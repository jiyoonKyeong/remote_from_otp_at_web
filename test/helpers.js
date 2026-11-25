// 시험 도우미: 가짜 Guacamole 과 게이트 서버를 띄우고, 브라우저 흉내를 낸다.

import net from 'node:net';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { createGate } from '../src/gate.js';
import { hashPassword } from '../src/password.js';
import { parseInstructions } from '../src/protocol.js';
import { startMockGuacamole } from '../scripts/mock-guacamole.js';

export const PASSWORDS = { alice: 'alice-password-123', bob: 'bob-password-456' };

let hashes = null;

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function waitFor(check, label = '조건', timeoutMs = 4000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`기다렸지만 일어나지 않음: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startStack(env = {}) {
  hashes ??= { alice: await hashPassword(PASSWORDS.alice), bob: await hashPassword(PASSWORDS.bob) };

  const mock = await startMockGuacamole();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;

  const config = loadConfig({
    PUBLIC_ORIGIN: origin,
    PORT: String(port),
    USER1_ID: 'alice',
    USER1_NAME: '앨리스',
    USER1_PHONE: '010-1111-2222',
    USER1_PASSWORD_HASH: hashes.alice,
    USER2_ID: 'bob',
    USER2_NAME: '밥',
    USER2_PHONE: '01033334444',
    USER2_PASSWORD_HASH: hashes.bob,
    SMS_PROVIDER: 'console',
    GUAC_URL: mock.url,
    GUAC_USERNAME: 'gate-service',
    GUAC_PASSWORD: 'mock-password',
    GUAC_CONNECTION_ID: '1',
    ...env,
  });

  const clock = { skew: 0 };
  const sms = []; // { phone, code }
  const events = [];
  const gate = await createGate(config, {
    now: () => Date.now() + clock.skew,
    audit: (event, fields) => events.push({ event, ...fields }),
    sendSms: async (phone, text) => {
      sms.push({ phone: phone.domestic, code: text.match(/\d{6}/)[0], text });
    },
  });
  await new Promise((resolve) => gate.server.listen(port, '127.0.0.1', resolve));

  // 브라우저 한 개 흉내: 쿠키를 기억하고 이 사이트에서 보낸 것처럼 요청한다.
  function browser() {
    let cookie = '';
    const remember = (response) => {
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        cookie = pair.endsWith('=') ? '' : pair;
      }
    };

    const self = {
      get cookie() {
        return cookie;
      },
      async post(path, body = {}, headers = {}) {
        const response = await fetch(origin + path, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-requested-with': 'remote-gate',
            cookie,
            ...headers,
          },
          body: JSON.stringify(body),
        });
        remember(response);
        return { status: response.status, body: await response.json().catch(() => null) };
      },
      async state() {
        const response = await fetch(`${origin}/api/state`, { headers: { cookie } });
        return response.json();
      },
      // 로그인부터 인증번호 확인까지 한 번에
      async signIn(id) {
        const before = sms.length;
        const login = await self.post('/api/login', { id, password: PASSWORDS[id] });
        if (login.status !== 200) throw new Error(`로그인 실패 ${login.status}`);
        const verify = await self.post('/api/otp/verify', { code: sms[before].code });
        if (verify.status !== 200) throw new Error(`인증 실패 ${verify.status}`);
        return self;
      },
      // 화면 연결. 받은 명령을 instructions 에 쌓는다.
      tunnel(headers = {}) {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, 'guacamole', {
          headers: { origin, cookie, ...headers },
        });
        const link = { socket, instructions: [], status: null, closed: null };
        socket.on('message', (data) => link.instructions.push(...parseInstructions(data.toString('utf8'))));
        socket.on('unexpected-response', (_request, response) => {
          link.status = response.statusCode;
          socket.terminate();
        });
        socket.on('close', (code) => (link.closed = code));
        socket.on('error', () => {});
        link.opened = new Promise((resolve) => socket.once('open', resolve));
        link.send = (...elements) =>
          socket.send(elements.map((element) => `${String(element).length}.${element}`).join(',') + ';');
        link.has = (opcode) => link.instructions.some((instruction) => instruction[0] === opcode);
        return link;
      },
    };
    return self;
  }

  return {
    origin,
    port,
    config,
    gate,
    mock,
    clock,
    sms,
    events,
    browser,
    async stop() {
      await gate.close();
      mock.close();
    },
  };
}
