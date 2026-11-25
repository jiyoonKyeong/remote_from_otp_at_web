// Guacamole 과의 연결. 이 서버가 전용 계정으로 Guacamole 에 로그인하고
// 화면 터널을 하나 연다. Guacamole 토큰은 브라우저로 나가지 않는다.

import WebSocket from 'ws';

const TIMEOUT_MS = 10_000;
const KEEP_ALIVE_MS = 5_000;
const PING_MS = 10_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

// 인증서 검증은 끄지 않는다. 사설 인증 기관을 쓰면 Node 의 NODE_EXTRA_CA_CERTS 로 지정한다.
function request(guac, path, options) {
  return fetch(`${guac.url}${path}`, {
    ...options,
    headers: { ...guac.extraHeaders, ...options.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function login(guac) {
  const response = await request(guac, '/api/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: guac.username, password: guac.password }).toString(),
  });
  if (!response.ok) throw new Error(`Guacamole 로그인 실패 (${response.status})`);

  const body = await response.json();
  if (typeof body?.authToken !== 'string' || !/^[A-Za-z0-9]{16,256}$/.test(body.authToken)) {
    throw new Error('Guacamole 로그인 응답이 예상과 다릅니다');
  }
  return { token: body.authToken, dataSource: guac.dataSource || String(body.dataSource ?? '') };
}

async function revoke(guac, token) {
  try {
    await request(guac, `/api/tokens/${encodeURIComponent(token)}`, { method: 'DELETE', headers: {} });
    return true;
  } catch {
    return false;
  }
}

// 터널을 연다. 결과는 handlers 로 알려 준다.
//   onMessage(text)  Guacamole 이 보낸 명령 묶음
//   onClose(reason)  어떤 이유로든 끝났을 때 한 번
// 돌려주는 객체: send(text), close() → 토큰 폐기까지 끝나면 완료되는 Promise
export function connectUpstream(guac, remote, handlers) {
  let finished = false;
  let socket = null;
  let token = null;
  let alive = true;
  let revoked = Promise.resolve();
  const timers = [];

  function finish(reason) {
    if (finished) return revoked;
    finished = true;
    timers.forEach(clearInterval);
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.terminate();
    }
    if (token) revoked = revoke(guac, token);
    handlers.onClose(reason);
    return revoked;
  }

  (async () => {
    const session = await login(guac);
    if (finished) {
      await revoke(guac, session.token);
      return;
    }
    token = session.token;

    const query = new URLSearchParams({
      token,
      GUAC_DATA_SOURCE: session.dataSource,
      GUAC_ID: guac.connectionId,
      GUAC_TYPE: 'c',
      GUAC_WIDTH: String(remote.width),
      GUAC_HEIGHT: String(remote.height),
      GUAC_DPI: String(remote.dpi),
    });
    // 받을 수 있는 형식은 화면 이미지뿐이다. 소리·영상 형식은 알리지 않는다.
    query.append('GUAC_IMAGE', 'image/png');
    query.append('GUAC_IMAGE', 'image/jpeg');

    const url = `${guac.url.replace(/^http/, 'ws')}/websocket-tunnel?${query}`;
    socket = new WebSocket(url, 'guacamole', {
      headers: guac.extraHeaders,
      handshakeTimeout: TIMEOUT_MS,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      followRedirects: false,
    });

    socket.on('open', () => {
      // guacd 는 한동안 아무것도 받지 못하면 연결을 끊는다.
      timers.push(setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('3.nop;'), KEEP_ALIVE_MS));
      timers.push(
        setInterval(() => {
          if (!alive) return finish('upstream_timeout');
          alive = false;
          socket.ping();
        }, PING_MS),
      );
    });
    socket.on('pong', () => {
      alive = true;
    });
    socket.on('message', (data, isBinary) => {
      alive = true;
      if (isBinary) return finish('upstream_protocol_error');
      handlers.onMessage(data.toString('utf8'));
    });
    socket.on('unexpected-response', (_request, response) => finish(`upstream_http_${response.statusCode}`));
    socket.on('close', (code) => finish(`upstream_closed_${code}`));
    socket.on('error', (error) => finish(`upstream_error_${error.code ?? 'socket'}`));
  })().catch((error) => finish(`upstream_login_failed: ${String(error?.message ?? error).slice(0, 160)}`));

  return {
    send(text) {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    close() {
      return finish('stopped');
    },
  };
}
