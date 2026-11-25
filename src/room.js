// 원격 화면 "방". 인증된 두 사람의 화면 연결이 모두 붙어 있을 때만
// Guacamole 터널을 하나 열어 두 사람에게 똑같이 나눠 준다.
// 한 사람이라도 빠지면 터널을 닫는다.

import { randomUUID } from 'node:crypto';
import { createUpstreamFilter, encode, parseInstructions, readClientInstruction } from './protocol.js';

const HEARTBEAT_MS = 10_000;
const MAX_BROWSER_BUFFER = 8 * 1024 * 1024;
const MAX_INSTRUCTIONS_PER_SECOND = 2_000;
const MAX_PRESSED_KEYS = 64;
const GOOD_SESSION_MS = 10_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

// 브라우저 쪽 연결을 닫을 때 쓰는 코드
const CLOSE = { restart: 4000, replaced: 4001, slow: 4002, session: 4003, invalid: 4004 };

export function createRoom({ config, auth, audit, connect, now = Date.now }) {
  const members = new Map(); // 사용자 아이디 → 화면 연결
  let controller = config.initialController;
  let upstream = null;
  let retryTimer = null;
  let failures = 0;
  let message = '';
  let closing = false;

  const otherUser = (userId) => config.users.find((user) => user.id !== userId).id;

  const state = () => {
    if (upstream) return upstream.opened ? 'open' : 'connecting';
    return retryTimer ? 'retrying' : 'waiting';
  };

  // 상태가 바뀌었으니 화면을 새로 고치라고 브라우저에 알린다.
  function notify() {
    const signal = encode(['gate', 'state']);
    for (const member of members.values()) {
      if (member.ws.readyState === member.ws.OPEN) member.ws.send(signal);
    }
  }

  // 화면 연결 하나를 목록에서 빼고 닫는다.
  function drop(member, code, reason) {
    if (members.get(member.userId) !== member) return;
    members.delete(member.userId);
    audit('screen_detached', { user: member.userId, reason });
    try {
      member.ws.close(code, reason);
    } catch {
      member.ws.terminate();
    }
  }

  // 한 사람이 빠졌다: 원격 터널도 닫는다.
  function remove(member, code, reason) {
    drop(member, code, reason);
    stopUpstream('peer_left');
    notify();
  }

  function releaseInput() {
    if (!upstream) return;
    for (const keysym of upstream.pressed) upstream.connection.send(encode(['key', keysym, 0]));
    upstream.pressed.clear();
    if (upstream.mouse.mask !== 0) {
      upstream.mouse.mask = 0;
      upstream.connection.send(encode(['mouse', upstream.mouse.x, upstream.mouse.y, 0]));
    }
  }

  function stopUpstream(reason, detail) {
    const stopped = upstream;
    if (!stopped) return Promise.resolve();
    upstream = null;

    const lasted = stopped.openedAt ? now() - stopped.openedAt : 0;
    const deliberate = reason === 'peer_left' || reason === 'shutdown';
    const revoked = stopped.connection.close();

    audit('remote_closed', {
      reason,
      detail,
      seconds: Math.round(lasted / 1000),
      blocked: Object.keys(stopped.blocked).length > 0 ? stopped.blocked : undefined,
    });

    // 이미 화면을 받은 브라우저는 처음부터 다시 연결해야 한다.
    if (stopped.forwarded) {
      for (const member of [...members.values()]) drop(member, CLOSE.restart, 'restart');
    }

    if (lasted >= GOOD_SESSION_MS) failures = 0;
    if (!deliberate && lasted < GOOD_SESSION_MS) {
      // 연결이 되지 않거나 곧바로 끊기면 간격을 늘려 가며 다시 시도한다.
      failures += 1;
      message = '원격 PC에 연결하지 못했습니다. 잠시 후 자동으로 다시 시도합니다.';
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        notify();
        maybeStart();
      }, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1)));
      retryTimer.unref();
    }

    notify();
    maybeStart();
    return revoked;
  }

  function broadcast(text) {
    for (const member of [...members.values()]) {
      if (member.ws.bufferedAmount > MAX_BROWSER_BUFFER) {
        audit('screen_too_slow', { user: member.userId });
        return remove(member, CLOSE.slow, 'slow');
      }
      member.ws.send(text);
    }
    if (upstream) upstream.forwarded = true;
  }

  function onUpstreamMessage(current, text) {
    if (upstream !== current) return;

    let instructions;
    try {
      instructions = parseInstructions(text);
    } catch {
      return stopUpstream('upstream_protocol_error');
    }

    let forward = '';
    let end = null;
    for (const instruction of instructions) {
      const result = current.filter.process(instruction);
      if (result.forward) forward += result.forward;
      if (result.reply) current.connection.send(result.reply);
      if (result.blocked) {
        if (!(result.blocked in current.blocked)) audit('remote_data_blocked', { kind: result.blocked });
        current.blocked[result.blocked] = (current.blocked[result.blocked] ?? 0) + 1;
      }
      if (result.end) {
        end = result;
        break;
      }
    }

    if (forward) {
      if (!current.opened) {
        current.opened = true;
        current.openedAt = now();
        message = '';
        audit('remote_opened', { users: [...members.keys()], controller });
        notify();
      }
      broadcast(forward);
    }
    if (end && upstream === current) stopUpstream(end.end, end.detail);
  }

  function start() {
    const current = {
      connection: null,
      filter: createUpstreamFilter(),
      opened: false,
      openedAt: 0,
      forwarded: false,
      blocked: {},
      pressed: new Set(),
      mouse: { x: 0, y: 0, mask: 0 },
      syncSent: 0,
    };
    upstream = current;
    for (const member of members.values()) member.lastSync = 0;

    audit('remote_connecting', { users: [...members.keys()] });
    current.connection = connect(config.guac, config.remote, {
      onMessage: (text) => onUpstreamMessage(current, text),
      onClose: (reason) => {
        if (upstream === current) stopUpstream(reason);
      },
    });
    notify();
  }

  // 두 사람이 모두 인증된 상태로 붙어 있을 때만 시작한다.
  function maybeStart() {
    if (closing || upstream || retryTimer || members.size !== config.users.length) return;
    for (const member of [...members.values()]) {
      if (!auth.isVerified(member.sessionId)) return remove(member, CLOSE.session, 'session');
    }
    start();
  }

  // 두 브라우저가 모두 그린 시점까지만 Guacamole 에 알려 느린 쪽에 맞춘다.
  function forwardSync() {
    if (!upstream || members.size !== config.users.length) return;
    const slowest = Math.min(...[...members.values()].map((member) => member.lastSync));
    if (slowest > upstream.syncSent) {
      upstream.syncSent = slowest;
      upstream.connection.send(encode(['sync', slowest]));
    }
  }

  function onBrowserMessage(member, data, isBinary) {
    if (members.get(member.userId) !== member) return;
    if (isBinary) return remove(member, CLOSE.invalid, 'invalid');

    let instructions;
    try {
      instructions = parseInstructions(data.toString('utf8'));
    } catch {
      audit('screen_invalid_input', { user: member.userId });
      return remove(member, CLOSE.invalid, 'invalid');
    }

    if (now() - member.windowStart >= 1000) {
      member.windowStart = now();
      member.count = 0;
    }
    member.count += instructions.length;
    if (member.count > MAX_INSTRUCTIONS_PER_SECOND) {
      audit('screen_flood', { user: member.userId });
      return remove(member, CLOSE.invalid, 'invalid');
    }

    for (const instruction of instructions) {
      const input = readClientInstruction(instruction);
      if (!input) continue;

      if (input.type === 'ping') {
        member.ws.send(encode(['', 'ping', input.timestamp]));
        continue;
      }
      if (input.type === 'sync') {
        member.lastSync = Math.max(member.lastSync, input.timestamp);
        forwardSync();
        continue;
      }
      if (input.type === 'disconnect') return remove(member, 1000, 'bye');

      // 여기부터는 조작 입력. 조작 권한이 있는 사람의 것만, 화면이 열려 있을 때만 전달한다.
      if (member.userId !== controller || !upstream?.opened) continue;

      if (input.type === 'key') {
        if (input.pressed) {
          if (upstream.pressed.size >= MAX_PRESSED_KEYS && !upstream.pressed.has(input.keysym)) continue;
          upstream.pressed.add(input.keysym);
        } else {
          upstream.pressed.delete(input.keysym);
        }
        upstream.connection.send(encode(['key', input.keysym, input.pressed]));
      } else if (input.type === 'mouse') {
        upstream.mouse = { x: input.x, y: input.y, mask: input.mask };
        upstream.connection.send(encode(['mouse', input.x, input.y, input.mask]));
        // 보기만 하는 사람에게는 마우스 위치만 알려 준다.
        const pointer = encode(['mouse', input.x, input.y]);
        for (const other of members.values()) {
          if (other !== member && other.ws.readyState === other.ws.OPEN) other.ws.send(pointer);
        }
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const member of [...members.values()]) {
      if (!auth.isVerified(member.sessionId)) {
        remove(member, CLOSE.session, 'session');
      } else if (!member.alive) {
        member.ws.terminate();
        remove(member, CLOSE.invalid, 'timeout');
      } else {
        member.alive = false;
        member.ws.ping();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    // 인증된 세션의 화면 연결을 붙인다. (인증 확인은 호출하는 쪽에서 이미 마친 상태)
    attach(userId, sessionId, ws) {
      const previous = members.get(userId);
      if (previous) remove(previous, CLOSE.replaced, 'replaced');

      const member = { userId, sessionId, ws, alive: true, lastSync: 0, windowStart: now(), count: 0 };
      members.set(userId, member);
      audit('screen_attached', { user: userId });

      ws.on('message', (data, isBinary) => onBrowserMessage(member, data, isBinary));
      ws.on('pong', () => {
        member.alive = true;
        auth.touch(sessionId);
      });
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        if (members.get(userId) === member) remove(member, 1000, 'closed');
      });

      // Guacamole 브라우저 라이브러리는 첫 명령으로 터널 식별자를 기다린다.
      ws.send(encode(['', randomUUID()]));
      notify();
      maybeStart();
    },

    // 세션이 끝났으면(로그아웃, 만료, 다른 곳에서 로그인) 화면 연결도 끊는다.
    endSession(sessionId) {
      for (const member of [...members.values()]) {
        if (member.sessionId === sessionId) remove(member, CLOSE.session, 'session');
      }
    },

    // 조작 권한을 상대에게 넘긴다. 지금 조작 중인 사람만 할 수 있다.
    handover(userId) {
      if (userId !== controller) return false;
      releaseInput();
      controller = otherUser(userId);
      audit('control_handover', { from: userId, to: controller });
      notify();
      return true;
    },

    view() {
      return {
        state: state(),
        message: state() === 'retrying' || state() === 'connecting' ? message : '',
        controller,
        attached: [...members.keys()],
      };
    },

    shutdown() {
      closing = true;
      clearInterval(heartbeat);
      clearTimeout(retryTimer);
      retryTimer = null;
      const revoked = stopUpstream('shutdown');
      for (const member of [...members.values()]) drop(member, 1001, 'shutdown');
      return revoked;
    },
  };
}
