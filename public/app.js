// 화면 쪽 코드. 권한 판단은 모두 서버가 한다. 여기서는 서버가 알려 준 상태를 보여 줄 뿐이다.

import Guacamole from '/vendor/guacamole-common.min.js';

const $ = (id) => document.getElementById(id);

const POLL_MS = 2000;
const RECONNECT_MS = 1500;
const KEY = { ctrl: 0xffe3, alt: 0xffe9, del: 0xffff };

let state = { stage: 'loading' };
let clockOffset = 0; // 서버 시계 - 내 시계
let remote = null; // 지금 열려 있는 화면 연결
let reconnectAt = 0;

const serverNow = () => Date.now() + clockOffset;
const canControl = () =>
  remote !== null && state.stage === 'verified' && state.room.state === 'open' && state.room.controller === 'me';

// --- 서버와 주고받기 --------------------------------------------------------

async function post(path, body = {}) {
  try {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'remote-gate' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok && data.ok === true, error: data.error, otp: data.otp };
  } catch {
    return { ok: false, error: '서버에 연결할 수 없습니다.' };
  }
}

let refreshing = null;
function refresh() {
  refreshing ??= (async () => {
    try {
      const response = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('state');
      state = await response.json();
      if (state.now) clockOffset = state.now - Date.now();
      $('offline').hidden = true;
    } catch {
      $('offline').hidden = false;
    }
    refreshing = null;
    render();
  })();
  return refreshing;
}

// --- 원격 화면 --------------------------------------------------------------

function fit() {
  if (!remote) return;
  const width = remote.display.getWidth();
  const height = remote.display.getHeight();
  if (!width || !height) return;
  const box = $('stage').getBoundingClientRect();
  remote.display.scale(Math.min(box.width / width, box.height / height));
}

function closeRemote() {
  const current = remote;
  if (!current) return;
  remote = null;
  try {
    current.client.disconnect();
  } catch {
    // 이미 닫힌 연결
  }
  $('screen').replaceChildren();
}

function openRemote() {
  if (remote || Date.now() < reconnectAt) return;

  const tunnel = new Guacamole.WebSocketTunnel('/tunnel');
  const client = new Guacamole.Client(tunnel);
  const display = client.getDisplay();
  const current = { client, display };
  remote = current;

  // 서버가 보내는 "상태가 바뀌었다" 신호는 따로 처리하고, 나머지는 화면 그리기에 넘긴다.
  const draw = tunnel.oninstruction;
  tunnel.oninstruction = (opcode, args) => {
    if (opcode === 'gate') refresh();
    else draw(opcode, args);
  };

  const lost = () => {
    if (remote !== current) return;
    closeRemote();
    reconnectAt = Date.now() + RECONNECT_MS;
    setTimeout(refresh, RECONNECT_MS);
    refresh();
  };
  tunnel.onerror = lost;
  client.onerror = lost;
  tunnel.onstatechange = (tunnelState) => {
    if (tunnelState === Guacamole.Tunnel.State.CLOSED) lost();
  };

  display.onresize = fit;
  const element = display.getElement();
  $('screen').replaceChildren(element);

  const mouse = new Guacamole.Mouse(element);
  mouse.onEach(['mousedown', 'mousemove', 'mouseup'], (event) => {
    if (event.type === 'mousedown') $('stage').focus();
    if (canControl()) client.sendMouseState(event.state, true);
  });

  client.connect('');
}

// 키보드는 원격 화면 영역에 포커스가 있을 때만 받는다.
const keyboard = new Guacamole.Keyboard($('stage'));
keyboard.onkeydown = (keysym) => {
  if (!canControl()) return true;
  remote.client.sendKeyEvent(1, keysym);
  return false;
};
keyboard.onkeyup = (keysym) => {
  if (canControl()) remote.client.sendKeyEvent(0, keysym);
};
$('stage').addEventListener('blur', () => keyboard.reset());
window.addEventListener('resize', fit);

// --- 화면 그리기 ------------------------------------------------------------

function show(view) {
  for (const id of ['view-login', 'view-otp', 'view-room']) $(id).hidden = id !== view;
}

function clock(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderOtp() {
  const otp = state.otp;
  $('otp-phone').textContent = otp.phone;

  const left = otp.expiresAt - serverNow();
  $('otp-timer').textContent =
    otp.expiresAt && left > 0 ? `남은 시간 ${clock(left)}` : '인증번호가 만료되었습니다. 다시 받아 주세요.';
  $('otp-submit').disabled = !(otp.expiresAt && left > 0);

  const wait = otp.resendAt - serverNow();
  $('otp-resend').disabled = wait > 0 || otp.resendsLeft <= 0;
  $('otp-resend').textContent = wait > 0 ? `다시 받기 (${Math.ceil(wait / 1000)}초)` : '다시 받기';
}

function overlayText() {
  const { peer, room } = state;
  if (room.state === 'open') return '';
  if (room.state === 'retrying') return room.message || '원격 PC에 다시 연결을 시도합니다.';
  if (room.state === 'connecting') return '원격 PC에 연결하는 중입니다.';
  if (!peer.verified) {
    return `${peer.name} 님의 인증을 기다리는 중입니다.\n두 사람이 모두 인증해야 원격 화면이 열립니다.`;
  }
  if (!peer.attached) return `${peer.name} 님이 화면에 연결하는 중입니다.`;
  return '원격 화면을 준비하는 중입니다.';
}

function renderRoom() {
  const { me, peer, room } = state;
  const open = room.state === 'open';
  const mine = room.controller === 'me';

  $('room-me').textContent = me.name;
  $('room-role').textContent = mine ? '조작 중' : '보기 전용';
  $('room-role').classList.toggle('active', mine);
  $('room-peer').textContent = `${peer.name}: ${peer.attached ? '접속 중' : peer.verified ? '인증 완료' : '미접속'}`;
  $('room-peer').classList.toggle('online', peer.attached);
  $('room-expiry').textContent = `세션 만료 ${new Date(state.expiresAt - clockOffset).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;

  $('room-handover').hidden = !mine;
  $('room-cad').hidden = !(mine && open);
  $('stage').classList.toggle('control', mine && open);

  const text = overlayText();
  $('overlay').hidden = text === '';
  $('overlay-text').textContent = text;

  openRemote();
  fit();
}

function render() {
  if (state.stage === 'verified') {
    show('view-room');
    renderRoom();
    return;
  }

  closeRemote();
  if (state.stage === 'otp') {
    show('view-otp');
    renderOtp();
  } else if (state.stage === 'anonymous') {
    show('view-login');
  }
}

// --- 버튼 -------------------------------------------------------------------

async function submit(button, errorElement, action) {
  button.disabled = true;
  errorElement.textContent = '';
  const result = await action();
  button.disabled = false;
  if (!result.ok) errorElement.textContent = result.error || '요청을 처리하지 못했습니다.';
  if (result.otp && state.stage === 'otp') state.otp = result.otp;
  await refresh();
  return result;
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await submit($('login-submit'), $('login-error'), () =>
    post('/api/login', { id: $('login-id').value.trim(), password: $('login-password').value }),
  );
  $('login-password').value = '';
  if (result.ok) {
    $('otp-code').value = '';
    $('otp-error').textContent = '';
    $('otp-code').focus();
  }
});

$('otp-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await submit($('otp-submit'), $('otp-error'), () => post('/api/otp/verify', { code: $('otp-code').value.trim() }));
  $('otp-code').value = '';
});

$('otp-resend').addEventListener('click', () =>
  submit($('otp-resend'), $('otp-error'), () => post('/api/otp/resend')),
);

async function logout() {
  closeRemote();
  await post('/api/logout');
  await refresh();
}
$('otp-cancel').addEventListener('click', logout);
$('room-logout').addEventListener('click', logout);

$('room-handover').addEventListener('click', async () => {
  keyboard.reset();
  await post('/api/control/handover');
  await refresh();
});

$('room-cad').addEventListener('click', () => {
  if (!canControl()) return;
  for (const keysym of [KEY.ctrl, KEY.alt, KEY.del]) remote.client.sendKeyEvent(1, keysym);
  for (const keysym of [KEY.del, KEY.alt, KEY.ctrl]) remote.client.sendKeyEvent(0, keysym);
  $('stage').focus();
});

// --- 시작 -------------------------------------------------------------------

setInterval(refresh, POLL_MS);
setInterval(() => {
  if (state.stage === 'otp') renderOtp();
}, 500);
refresh();
