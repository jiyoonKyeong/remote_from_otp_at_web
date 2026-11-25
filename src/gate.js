// HTTP 서버. 화면 파일, 로그인 API, 화면 연결(WebSocket) 입구를 맡는다.

import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { createAudit } from './audit.js';
import { createAuth } from './auth.js';
import { connectUpstream } from './guacamole.js';
import { createRoom } from './room.js';
import { createSmsSender } from './sms.js';

const MAX_BODY_BYTES = 2048;
const MAX_TUNNEL_MESSAGE_BYTES = 8192;
const REQUIRED_HEADER = 'remote-gate';
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

const read = (relative) => readFileSync(new URL(relative, import.meta.url));

// 내려 줄 수 있는 파일은 이 목록이 전부다.
const FILES = {
  '/': [read('../public/index.html'), 'text/html; charset=utf-8'],
  '/app.js': [read('../public/app.js'), 'text/javascript; charset=utf-8'],
  '/style.css': [read('../public/style.css'), 'text/css; charset=utf-8'],
  '/vendor/guacamole-common.min.js': [
    read('../node_modules/guacamole-common-js/dist/esm/guacamole-common.min.js'),
    'text/javascript; charset=utf-8',
  ],
};

export async function createGate(config, overrides = {}) {
  const audit = overrides.audit ?? createAudit();
  const now = overrides.now ?? Date.now;
  const sendSms = overrides.sendSms ?? createSmsSender(config.sms);

  let room = null;
  const auth = await createAuth({
    config,
    sendSms,
    audit,
    now,
    onSessionEnd: (sessionId) => room?.endSession(sessionId),
  });
  room = createRoom({ config, auth, audit, now, connect: overrides.connect ?? connectUpstream });

  const cookieName = config.secure ? '__Host-gate' : 'gate';
  const cookieAttributes = `Path=/; HttpOnly; SameSite=Strict${config.secure ? '; Secure' : ''}`;
  const sessionCookie = (sessionId) => `${cookieName}=${sessionId}; ${cookieAttributes}`;
  const clearedCookie = `${cookieName}=; ${cookieAttributes}; Max-Age=0`;

  const securityHeaders = {
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      `connect-src 'self' ${config.publicOrigin.replace(/^http/, 'ws')}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()',
    'cache-control': 'no-store',
    ...(config.secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };

  function send(response, status, body, headers = {}) {
    response.writeHead(status, { ...securityHeaders, ...headers });
    response.end(body);
  }
  const json = (response, status, value, headers = {}) =>
    send(response, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', ...headers });

  // 프록시 뒤에 있으면 프록시가 붙인 주소를, 아니면 직접 연결된 주소를 쓴다.
  function clientIp(request) {
    const direct = request.socket.remoteAddress ?? 'unknown';
    if (config.trustProxy === 0) return direct;
    const chain = String(request.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    return (chain[chain.length - config.trustProxy] ?? direct).slice(0, 64);
  }

  function sessionIdOf(request) {
    for (const part of String(request.headers.cookie ?? '').split(';')) {
      const index = part.indexOf('=');
      if (index !== -1 && part.slice(0, index).trim() === cookieName) {
        const value = part.slice(index + 1).trim();
        return SESSION_ID.test(value) ? value : null;
      }
    }
    return null;
  }

  function readJson(request) {
    return new Promise((resolve) => {
      if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return resolve(null);
      const chunks = [];
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      request.on('error', () => resolve(null));
      request.on('end', () => {
        if (size > MAX_BODY_BYTES) return resolve(null);
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : null);
        } catch {
          resolve(null);
        }
      });
    });
  }

  function stateOf(session) {
    if (!session) return { stage: 'anonymous' };
    if (session.stage === 'otp') return { stage: 'otp', now: now(), otp: auth.otpView(session) };

    const me = auth.userById(session.userId);
    const peer = config.users.find((user) => user.id !== me.id);
    const view = room.view();
    return {
      stage: 'verified',
      now: now(),
      me: { name: me.name },
      peer: {
        name: peer.name,
        verified: auth.userVerified(peer.id),
        attached: view.attached.includes(peer.id),
      },
      room: {
        state: view.state,
        message: view.message,
        controller: view.controller === me.id ? 'me' : 'peer',
      },
      expiresAt: session.expiresAt,
    };
  }

  async function handlePost(request, response, path) {
    // 다른 사이트가 사용자의 브라우저를 시켜 보내는 요청을 막는다.
    const fromThisSite =
      request.headers.origin === config.publicOrigin &&
      request.headers['x-requested-with'] === REQUIRED_HEADER &&
      String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
    if (!fromThisSite) return json(response, 403, { ok: false, error: '허용되지 않은 요청입니다.' });

    const body = await readJson(request);
    if (!body) return json(response, 400, { ok: false, error: '요청 형식이 올바르지 않습니다.' });

    const ip = clientIp(request);
    const sessionId = sessionIdOf(request);
    const reply = (result, headers) =>
      json(response, result.status ?? 200, { ok: result.ok, error: result.error, otp: result.otp }, headers);

    if (path === '/api/login') {
      const result = await auth.login(ip, body.id, body.password);
      return reply(result, result.ok ? { 'set-cookie': sessionCookie(result.sessionId) } : {});
    }
    if (path === '/api/otp/verify') {
      const result = await auth.verifyOtp(sessionId, body.code, ip);
      return reply(result, result.ok ? { 'set-cookie': sessionCookie(result.sessionId) } : {});
    }
    if (path === '/api/otp/resend') {
      return reply(await auth.resendOtp(sessionId));
    }
    if (path === '/api/logout') {
      if (sessionId) auth.logout(sessionId);
      return json(response, 200, { ok: true }, { 'set-cookie': clearedCookie });
    }
    if (path === '/api/control/handover') {
      const session = auth.get(sessionId);
      if (!session || session.stage !== 'verified') {
        return json(response, 401, { ok: false, error: '다시 로그인하세요.' });
      }
      return room.handover(session.userId)
        ? json(response, 200, { ok: true })
        : json(response, 403, { ok: false, error: '조작 권한이 없습니다.' });
    }
    return json(response, 404, { ok: false, error: '없는 주소입니다.' });
  }

  async function handle(request, response) {
    const path = new URL(request.url, 'http://localhost').pathname;

    if (path === '/healthz' && request.method === 'GET') {
      return send(response, 200, 'ok', { 'content-type': 'text/plain' });
    }
    if (request.headers.host !== config.publicHost) {
      return send(response, 400, '접속 주소가 설정(PUBLIC_ORIGIN)과 다릅니다.', {
        'content-type': 'text/plain; charset=utf-8',
      });
    }

    if (request.method === 'GET') {
      if (path === '/api/state') return json(response, 200, stateOf(auth.get(sessionIdOf(request))));
      const file = Object.hasOwn(FILES, path) ? FILES[path] : null;
      if (file) return send(response, 200, file[0], { 'content-type': file[1] });
      return send(response, 404, 'Not found', { 'content-type': 'text/plain' });
    }
    if (request.method === 'POST') return handlePost(request, response, path);
    return send(response, 405, 'Method not allowed', { 'content-type': 'text/plain', allow: 'GET, POST' });
  }

  const listener = (request, response) => {
    handle(request, response).catch((error) => {
      audit('server_error', { detail: String(error?.message ?? error).slice(0, 200) });
      if (!response.headersSent) json(response, 500, { ok: false, error: '서버 오류가 발생했습니다.' });
      else response.destroy();
    });
  };

  const server = config.tls
    ? https.createServer({ ...config.tls, minVersion: 'TLSv1.2' }, listener)
    : http.createServer(listener);
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 500;

  // --- 화면 연결 -----------------------------------------------------------
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_TUNNEL_MESSAGE_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has('guacamole') ? 'guacamole' : false),
  });

  server.on('upgrade', (request, socket, head) => {
    const refuse = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    socket.on('error', () => socket.destroy());

    let path;
    try {
      path = new URL(request.url, 'http://localhost').pathname;
    } catch {
      return refuse(400, 'Bad Request');
    }
    if (path !== '/tunnel') return refuse(404, 'Not Found');
    if (request.headers.host !== config.publicHost || request.headers.origin !== config.publicOrigin) {
      audit('screen_refused', { ip: clientIp(request), reason: 'origin' });
      return refuse(403, 'Forbidden');
    }

    // 인증번호까지 마친 세션만 화면 연결을 열 수 있다.
    const sessionId = sessionIdOf(request);
    const session = auth.get(sessionId);
    if (!session || session.stage !== 'verified') {
      audit('screen_refused', { ip: clientIp(request), reason: 'not_verified' });
      return refuse(401, 'Unauthorized');
    }

    sockets.handleUpgrade(request, socket, head, (ws) => room.attach(session.userId, session.id, ws));
  });

  return {
    server,
    auth,
    room,
    async close() {
      const revoked = room.shutdown();
      auth.stop();
      sockets.close();
      server.close();
      server.closeAllConnections();
      await revoked;
    },
  };
}
