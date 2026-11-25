// 시험용 가짜 Guacamole. 실제 Guacamole 웹앱과 같은 주소·형식으로 응답한다.
//   POST   /guacamole/api/tokens            로그인 → 토큰
//   DELETE /guacamole/api/tokens/<토큰>     토큰 폐기
//   WS     /guacamole/websocket-tunnel      화면 터널
//
// 직접 실행하면 (npm run mock) 8081 포트에서 단순한 그림을 보여 주는 원격 PC 흉내를 낸다.

import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { encode, parseInstructions } from '../src/protocol.js';

const OVER = 14; // 채널 마스크: 위에 덮어 그리기

const fill = (x, y, w, h, [r, g, b]) =>
  encode(['rect', 0, x, y, w, h]) + encode(['cfill', OVER, 0, r, g, b, 255]);

export function startMockGuacamole({
  port = 0,
  username = 'gate-service',
  password = 'mock-password',
  connectionId = '1',
} = {}) {
  const mock = {
    url: '',
    tokens: new Set(),
    revoked: [],
    logins: 0,
    tunnels: [], // 열려 있는 터널 소켓
    received: [], // 터널로 받은 명령 (내부 ping 제외)
    query: null, // 마지막 터널 연결의 주소 매개변수
    failLogin: false,
    // 열려 있는 모든 터널에 명령을 보낸다.
    send(text) {
      for (const socket of mock.tunnels) socket.send(text);
    },
    close() {
      for (const socket of mock.tunnels) socket.terminate();
      sockets.close();
      server.close();
      server.closeAllConnections();
    },
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');

    if (request.method === 'POST' && url.pathname === '/guacamole/api/tokens') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const form = new URLSearchParams(body);
        mock.logins += 1;
        if (mock.failLogin || form.get('username') !== username || form.get('password') !== password) {
          response.writeHead(403, { 'content-type': 'application/json' });
          return response.end(JSON.stringify({ message: 'Permission Denied.', type: 'INVALID_CREDENTIALS' }));
        }
        const authToken = randomBytes(32).toString('hex').toUpperCase();
        mock.tokens.add(authToken);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ authToken, username, dataSource: 'mock', availableDataSources: ['mock'] }),
        );
      });
      return;
    }

    const match = url.pathname.match(/^\/guacamole\/api\/tokens\/([A-F0-9]+)$/);
    if (request.method === 'DELETE' && match) {
      mock.tokens.delete(match[1]);
      mock.revoked.push(match[1]);
      response.writeHead(204);
      return response.end();
    }

    response.writeHead(404);
    response.end();
  });

  const sockets = new WebSocketServer({ noServer: true, handleProtocols: () => 'guacamole' });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    const allowed =
      url.pathname === '/guacamole/websocket-tunnel' &&
      mock.tokens.has(url.searchParams.get('token')) &&
      url.searchParams.get('GUAC_ID') === connectionId &&
      url.searchParams.get('GUAC_TYPE') === 'c';
    if (!allowed) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return socket.destroy();
    }

    sockets.handleUpgrade(request, socket, head, (ws) => {
      const width = Number(url.searchParams.get('GUAC_WIDTH')) || 1024;
      const height = Number(url.searchParams.get('GUAC_HEIGHT')) || 768;
      mock.query = url.searchParams;
      mock.tunnels.push(ws);
      ws.on('close', () => mock.tunnels.splice(mock.tunnels.indexOf(ws), 1));

      // 첫 명령은 터널 식별자, 이어서 바탕 화면 비슷한 그림
      ws.send(encode(['', randomUUID()]));
      ws.send(
        encode(['size', 0, width, height]) +
          fill(0, 0, width, height, [16, 60, 110]) +
          fill(0, height - 44, width, 44, [24, 28, 36]) +
          fill(12, height - 36, 28, 28, [76, 141, 255]) +
          fill(60, 60, 360, 220, [240, 240, 240]) +
          fill(60, 60, 360, 28, [45, 110, 200]) +
          encode(['sync', Date.now()]),
      );

      ws.on('message', (data) => {
        for (const instruction of parseInstructions(data.toString('utf8'))) {
          const [opcode, ...args] = instruction;
          if (opcode === '') {
            if (args[0] === 'ping') ws.send(encode(['', 'ping', args[1]]));
            continue;
          }
          mock.received.push(instruction);
          // 조작이 실제로 전달되는지 눈으로 볼 수 있게 마우스 자리에 점을 찍는다.
          if (opcode === 'mouse') {
            const pressed = Number(args[2]) !== 0;
            ws.send(
              fill(Number(args[0]) - 3, Number(args[1]) - 3, 6, 6, pressed ? [255, 90, 90] : [255, 220, 80]) +
                encode(['sync', Date.now()]),
            );
          }
        }
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      mock.url = `http://127.0.0.1:${server.address().port}/guacamole`;
      resolve(mock);
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mock = await startMockGuacamole({ port: Number(process.env.MOCK_PORT) || 8081 });
  console.log(`가짜 Guacamole: ${mock.url}  (계정 gate-service / mock-password, 연결 번호 1)`);
}
