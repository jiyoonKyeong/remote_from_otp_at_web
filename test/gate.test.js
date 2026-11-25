import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { encode } from '../src/protocol.js';
import { PASSWORDS, sleep, startStack, waitFor } from './helpers.js';

describe('요청 검사', () => {
  let stack;
  before(async () => (stack = await startStack()));
  after(() => stack.stop());

  test('로그인하지 않은 사람에게는 아무 정보도 주지 않는다', async () => {
    assert.deepEqual(await stack.browser().state(), { stage: 'anonymous' });
  });

  test('보안 헤더가 붙는다', async () => {
    const response = await fetch(`${stack.origin}/`);
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  test('목록에 없는 파일은 내려 주지 않는다', async () => {
    for (const path of ['/.env', '/src/gate.js', '/package.json', '/..%2f.env', '/vendor/../.env']) {
      const response = await fetch(stack.origin + path);
      assert.equal(response.status, 404, path);
    }
  });

  test('다른 사이트에서 보낸 것 같은 요청은 거부한다', async () => {
    const browser = stack.browser();
    const body = { id: 'alice', password: PASSWORDS.alice };

    assert.equal((await browser.post('/api/login', body, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await browser.post('/api/login', body, { 'x-requested-with': 'other' })).status, 403);
    assert.equal((await browser.post('/api/login', body, { 'content-type': 'text/plain' })).status, 403);
    assert.equal(stack.sms.length, 0, '문자가 나가지 않아야 한다');
  });

  test('설정한 주소가 아닌 이름으로 들어온 요청은 거부한다', async () => {
    const response = await fetch(`http://localhost:${stack.port}/`);
    assert.equal(response.status, 400);
  });

  test('너무 큰 요청은 받지 않는다', async () => {
    const result = await stack.browser().post('/api/login', { id: 'alice', password: 'x'.repeat(5000) });
    assert.equal(result.status, 400);
  });
});

describe('로그인과 인증번호', () => {
  let stack;
  before(async () => (stack = await startStack()));
  after(() => stack.stop());

  test('틀린 비밀번호와 없는 아이디는 같은 응답을 받는다', async () => {
    const wrong = await stack.browser().post('/api/login', { id: 'alice', password: 'wrong-password' });
    const unknown = await stack.browser().post('/api/login', { id: 'mallory', password: 'wrong-password' });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong, unknown);
    assert.equal(stack.sms.length, 0);
  });

  test('비밀번호가 맞으면 본인 번호로 6자리 인증번호가 가고, 화면에는 가린 번호만 보인다', async () => {
    const browser = stack.browser();
    const login = await browser.post('/api/login', { id: 'alice', password: PASSWORDS.alice });
    assert.equal(login.status, 200);
    assert.equal(login.body.otp.phone, '010****2222');
    assert.equal(stack.sms.at(-1).phone, '01011112222');
    assert.match(stack.sms.at(-1).code, /^\d{6}$/);
    assert.ok(!JSON.stringify(login.body).includes(stack.sms.at(-1).code));
    assert.match(browser.cookie, /^gate=[A-Za-z0-9_-]{43}$/);
    assert.equal((await browser.state()).stage, 'otp');
  });

  test('인증번호 전 단계에서는 화면 연결과 조작 권한 요청이 거부된다', async () => {
    const browser = stack.browser();
    await browser.post('/api/login', { id: 'alice', password: PASSWORDS.alice });
    const link = browser.tunnel();
    await waitFor(() => link.status, '거부 응답');
    assert.equal(link.status, 401);
    assert.equal((await browser.post('/api/control/handover')).status, 401);
  });

  test('틀린 인증번호는 5번까지만 받고, 그 뒤에는 맞는 번호도 통하지 않는다', async () => {
    const browser = stack.browser();
    await browser.post('/api/login', { id: 'bob', password: PASSWORDS.bob });
    const code = stack.sms.at(-1).code;
    const wrong = code === '000000' ? '000001' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await browser.post('/api/otp/verify', { code: wrong })).status, 400);
    }
    assert.equal((await browser.post('/api/otp/verify', { code })).status, 400);
    assert.equal((await browser.state()).stage, 'otp');
  });

  test('인증번호는 시간이 지나면 쓸 수 없다', async () => {
    const browser = stack.browser();
    await browser.post('/api/login', { id: 'alice', password: PASSWORDS.alice });
    const code = stack.sms.at(-1).code;

    stack.clock.skew += stack.config.otpTtlMs + 1000;
    assert.equal((await browser.post('/api/otp/verify', { code })).status, 400);
    stack.clock.skew = 0;
  });

  test('다시 받기는 30초 뒤에만 되고, 새 번호가 오면 이전 번호는 무효가 된다', async () => {
    stack.clock.skew += 11 * 60_000; // 앞선 시험의 문자 한도 창을 넘긴다
    const browser = stack.browser();
    await browser.post('/api/login', { id: 'alice', password: PASSWORDS.alice });
    const first = stack.sms.at(-1).code;

    assert.equal((await browser.post('/api/otp/resend')).status, 429);
    stack.clock.skew += 31_000;
    assert.equal((await browser.post('/api/otp/resend')).status, 200);
    const second = stack.sms.at(-1).code;

    if (first !== second) {
      assert.equal((await browser.post('/api/otp/verify', { code: first })).status, 400);
    }
    assert.equal((await browser.post('/api/otp/verify', { code: second })).status, 200);
    assert.equal((await browser.state()).stage, 'verified');
  });

  test('인증에 성공하면 세션 값이 바뀌고, 쓴 인증번호와 이전 세션 값은 다시 쓸 수 없다', async () => {
    stack.clock.skew += 11 * 60_000;
    const browser = stack.browser();
    await browser.post('/api/login', { id: 'alice', password: PASSWORDS.alice });
    const pending = browser.cookie;
    const code = stack.sms.at(-1).code;
    assert.equal((await browser.post('/api/otp/verify', { code })).status, 200);
    assert.notEqual(browser.cookie, pending);

    const old = await fetch(`${stack.origin}/api/state`, { headers: { cookie: pending } });
    assert.deepEqual(await old.json(), { stage: 'anonymous' });
    assert.equal((await browser.post('/api/otp/verify', { code })).status, 401);
  });

  test('세션은 정해진 시간이 지나면 끝난다', async () => {
    stack.clock.skew += 11 * 60_000;
    const browser = await stack.browser().signIn('bob');
    assert.equal((await browser.state()).stage, 'verified');
    stack.clock.skew += stack.config.sessionIdleMs + 1000;
    assert.equal((await browser.state()).stage, 'anonymous');
  });

  test('로그아웃하면 세션이 사라진다', async () => {
    stack.clock.skew += 11 * 60_000;
    const browser = await stack.browser().signIn('bob');
    const cookie = browser.cookie;
    await browser.post('/api/logout');
    const response = await fetch(`${stack.origin}/api/state`, { headers: { cookie } });
    assert.deepEqual(await response.json(), { stage: 'anonymous' });
  });
});

describe('잠금', () => {
  let stack;
  before(async () => (stack = await startStack()));
  after(() => stack.stop());

  test('비밀번호를 10번 틀리면 맞는 비밀번호도 한동안 받지 않는다', async () => {
    const browser = stack.browser();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal((await browser.post('/api/login', { id: 'alice', password: 'nope-nope-nope' })).status, 401);
    }
    assert.equal((await browser.post('/api/login', { id: 'alice', password: PASSWORDS.alice })).status, 429);
    assert.equal(stack.sms.length, 0);

    stack.clock.skew += 16 * 60_000;
    assert.equal((await browser.post('/api/login', { id: 'alice', password: PASSWORDS.alice })).status, 200);
  });

  test('인증번호 문자는 10분에 5통까지만 나간다', async () => {
    stack.clock.skew += 16 * 60_000;
    const before = stack.sms.length;
    const statuses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await stack.browser().post('/api/login', { id: 'bob', password: PASSWORDS.bob })).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
    assert.equal(stack.sms.length - before, 5);
  });
});

describe('두 사람 규칙과 원격 화면', () => {
  let stack;
  let alice;
  let bob;
  let aliceLink;
  let bobLink;

  before(async () => {
    stack = await startStack();
    alice = await stack.browser().signIn('alice');
    bob = await stack.browser().signIn('bob');
  });
  after(() => stack.stop());

  const upstreamGot = (opcode) => stack.mock.received.filter((instruction) => instruction[0] === opcode);

  test('다른 사이트에서 연 화면 연결은 거부한다', async () => {
    const link = alice.tunnel({ origin: 'https://evil.example' });
    await waitFor(() => link.status, '거부 응답');
    assert.equal(link.status, 403);
  });

  test('한 사람만 연결했을 때는 Guacamole 에 접속하지 않는다', async () => {
    aliceLink = alice.tunnel();
    await aliceLink.opened;
    await sleep(400);

    assert.equal(stack.mock.logins, 0);
    assert.equal(stack.mock.tunnels.length, 0);
    assert.equal(aliceLink.has('size'), false);

    const state = await alice.state();
    assert.equal(state.room.state, 'waiting');
    assert.deepEqual(state.peer, { name: '밥', verified: true, attached: false });
  });

  test('두 사람이 모두 연결하면 터널이 하나 열리고 같은 화면을 받는다', async () => {
    bobLink = bob.tunnel();
    await bobLink.opened;
    await waitFor(() => aliceLink.has('sync') && bobLink.has('sync'), '화면 수신');

    assert.equal(stack.mock.logins, 1);
    assert.equal(stack.mock.tunnels.length, 1);

    const drawing = (link) => link.instructions.filter(([opcode]) => !['', 'gate'].includes(opcode));
    assert.deepEqual(drawing(aliceLink), drawing(bobLink));
    assert.deepEqual(drawing(aliceLink)[0], ['size', '0', '1600', '900']);

    assert.equal((await alice.state()).room.state, 'open');
    assert.equal((await alice.state()).room.controller, 'me');
    assert.equal((await bob.state()).room.controller, 'peer');
  });

  test('Guacamole 토큰은 브라우저로 나가지 않고, 소리·영상 형식은 요청하지 않는다', async () => {
    const [token] = stack.mock.tokens;
    const seen = JSON.stringify([aliceLink.instructions, bobLink.instructions, await alice.state()]);
    assert.ok(!seen.includes(token));

    assert.equal(stack.mock.query.get('GUAC_AUDIO'), null);
    assert.equal(stack.mock.query.get('GUAC_VIDEO'), null);
    assert.equal(stack.mock.query.get('GUAC_WIDTH'), '1600');
    assert.deepEqual(stack.mock.query.getAll('GUAC_IMAGE'), ['image/png', 'image/jpeg']);
  });

  test('조작 권한이 있는 사람의 입력만 원격 PC로 간다', async () => {
    bobLink.send('key', 66, 1);
    bobLink.send('mouse', 500, 500, 1);
    aliceLink.send('key', 65, 1);
    aliceLink.send('key', 65, 0);
    aliceLink.send('mouse', 100, 120, 0);
    await waitFor(() => upstreamGot('mouse').length === 1, '마우스 전달');

    assert.deepEqual(upstreamGot('key'), [['key', '65', '1'], ['key', '65', '0']]);
    assert.deepEqual(upstreamGot('mouse'), [['mouse', '100', '120', '0']]);
    // 보기만 하는 사람은 조작자의 마우스 위치를 받는다.
    await waitFor(() => bobLink.instructions.some((i) => i.join() === 'mouse,100,120'), '마우스 위치 공유');
  });

  test('입력 이외의 명령은 조작자가 보내도 원격 PC로 가지 않는다', async () => {
    const before = stack.mock.received.length;
    aliceLink.send('clipboard', 0, 'text/plain');
    aliceLink.send('blob', 0, 'c2VjcmV0');
    aliceLink.send('end', 0);
    aliceLink.send('file', 1, 'application/octet-stream', 'tool.exe');
    aliceLink.send('size', 4000, 3000, 96);
    aliceLink.send('key', 65, 7);
    aliceLink.send('mouse', 1, 1, 99);
    aliceLink.send('select', 'rdp');
    aliceLink.send('key', 67, 1);
    aliceLink.send('key', 67, 0);
    await waitFor(() => upstreamGot('key').length === 4, '뒤따른 정상 입력');

    const extra = stack.mock.received.slice(before).filter(([opcode]) => !['nop', 'sync'].includes(opcode));
    assert.deepEqual(extra, [['key', '67', '1'], ['key', '67', '0']]);
  });

  test('원격 PC가 보내는 클립보드·파일·기타 데이터는 브라우저에 닿지 않는다', async () => {
    stack.mock.send(
      encode(['clipboard', 5, 'text/plain']) +
        encode(['blob', 5, 'c2VjcmV0LWRhdGE=']) +
        encode(['end', 5]) +
        encode(['file', 6, 'application/octet-stream', 'passwords.txt']) +
        encode(['blob', 6, 'cGFzc3dvcmRz']) +
        encode(['audio', 7, 'audio/L16']) +
        encode(['nest', 0, encode(['clipboard', 8, 'text/plain'])]) +
        encode(['name', '비밀 서버 😀']) +
        encode(['filesystem', 0, 'Shared Drive']) +
        encode(['rect', 0, 1, 2, 3, 4]) +
        encode(['sync', 999]),
    );
    await waitFor(() => aliceLink.instructions.some((i) => i.join() === 'sync,999'), '뒤따른 화면 갱신');
    await waitFor(() => bobLink.instructions.some((i) => i.join() === 'sync,999'), '뒤따른 화면 갱신');

    for (const link of [aliceLink, bobLink]) {
      const text = JSON.stringify(link.instructions);
      for (const leaked of ['clipboard', 'c2VjcmV0', 'cGFzc3dvcmRz', 'passwords', 'audio', 'nest', '비밀', 'Shared']) {
        assert.ok(!text.includes(leaked), leaked);
      }
      assert.ok(link.instructions.some((i) => i.join() === 'rect,0,1,2,3,4'));
    }

    // Guacamole 쪽에는 받지 않겠다는 응답이 간다.
    await waitFor(() => upstreamGot('ack').length === 3, '거절 응답');
    assert.deepEqual(upstreamGot('ack').map((ack) => ack.slice(1)), [
      ['5', 'Unsupported', '256'],
      ['6', 'Unsupported', '256'],
      ['7', 'Unsupported', '256'],
    ]);
    assert.ok(stack.events.some((entry) => entry.event === 'remote_data_blocked' && entry.kind === 'clipboard'));
  });

  test('화면 갱신 확인은 두 사람 중 느린 쪽에 맞춰 한 번만 전달된다', async () => {
    const before = upstreamGot('sync').length;
    aliceLink.send('sync', 999);
    await sleep(150);
    assert.equal(upstreamGot('sync').length, before, '한 사람만 확인했을 때는 보내지 않는다');
    bobLink.send('sync', 999);
    await waitFor(() => upstreamGot('sync').length === before + 1, '확인 전달');
    assert.deepEqual(upstreamGot('sync').at(-1), ['sync', '999']);
  });

  test('조작 권한은 가진 사람만 넘길 수 있고, 넘기면 누르고 있던 키가 풀린다', async () => {
    assert.equal((await bob.post('/api/control/handover')).status, 403);

    aliceLink.send('key', 65505, 1); // Shift 를 누른 채로
    await waitFor(() => upstreamGot('key').some((i) => i.join() === 'key,65505,1'), 'Shift 누름');
    assert.equal((await alice.post('/api/control/handover')).status, 200);
    await waitFor(() => upstreamGot('key').some((i) => i.join() === 'key,65505,0'), 'Shift 자동 해제');

    assert.equal((await alice.state()).room.controller, 'peer');
    assert.equal((await bob.state()).room.controller, 'me');

    const before = upstreamGot('key').length;
    aliceLink.send('key', 70, 1);
    bobLink.send('key', 71, 1);
    bobLink.send('key', 71, 0);
    await waitFor(() => upstreamGot('key').length === before + 2, '새 조작자의 입력');
    assert.deepEqual(upstreamGot('key').slice(before), [['key', '71', '1'], ['key', '71', '0']]);
    assert.ok(stack.events.some((entry) => entry.event === 'control_handover' && entry.to === 'bob'));
  });

  test('형식이 깨진 입력을 보내면 연결이 끊긴다', async () => {
    const [token] = stack.mock.tokens;
    bobLink.socket.send('5.mouse,9.1;');
    await waitFor(() => bobLink.closed && aliceLink.closed, '두 연결 종료');
    await waitFor(() => stack.mock.tunnels.length === 0, '터널 종료');
    await waitFor(() => stack.mock.revoked.includes(token), '토큰 폐기');
  });

  test('다시 두 사람이 연결하면 새 터널이 열리고, 한 사람이 로그아웃하면 곧바로 닫힌다', async () => {
    aliceLink = alice.tunnel();
    bobLink = bob.tunnel();
    await waitFor(() => aliceLink.has('sync') && bobLink.has('sync'), '화면 수신');
    assert.equal(stack.mock.tunnels.length, 1);
    const [token] = stack.mock.tokens;

    await bob.post('/api/logout');
    await waitFor(() => aliceLink.closed && bobLink.closed, '두 연결 종료');
    await waitFor(() => stack.mock.tunnels.length === 0, '터널 종료');
    await waitFor(() => stack.mock.revoked.includes(token), '토큰 폐기');

    // 남은 한 사람이 다시 연결해도 혼자서는 열리지 않는다.
    const logins = stack.mock.logins;
    aliceLink = alice.tunnel();
    await aliceLink.opened;
    await sleep(400);
    assert.equal(stack.mock.logins, logins);
    assert.equal(aliceLink.has('size'), false);
    assert.deepEqual((await alice.state()).peer, { name: '밥', verified: false, attached: false });
  });

  test('같은 사용자가 다른 곳에서 새로 인증하면 이전 세션과 화면 연결은 끊긴다', async () => {
    const second = await stack.browser().signIn('alice');
    await waitFor(() => aliceLink.closed, '이전 화면 연결 종료');
    assert.ok(stack.events.some((entry) => entry.event === 'session_end' && entry.reason === 'replaced'));
    assert.equal((await alice.state()).stage, 'anonymous');
    assert.equal((await second.state()).stage, 'verified');
  });
});

describe('Guacamole 연결 실패', () => {
  let stack;
  before(async () => (stack = await startStack({ GUAC_PASSWORD: 'wrong-service-password' })));
  after(() => stack.stop());

  test('연결에 실패하면 곧바로 반복하지 않고 기다렸다가 다시 시도한다', async () => {
    const alice = await stack.browser().signIn('alice');
    const bob = await stack.browser().signIn('bob');
    const aliceLink = alice.tunnel();
    const bobLink = bob.tunnel();
    await Promise.all([aliceLink.opened, bobLink.opened]);

    await waitFor(async () => (await alice.state()).room.state === 'retrying', '재시도 대기');
    await sleep(500);
    assert.equal(stack.mock.logins, 1);
    assert.equal(aliceLink.has('size'), false);
    assert.ok(stack.events.some((entry) => entry.event === 'remote_closed'));
    // 내부 오류 내용은 사용자 화면으로 나가지 않는다.
    const { message } = (await alice.state()).room;
    assert.equal(message, '원격 PC에 연결하지 못했습니다. 잠시 후 자동으로 다시 시도합니다.');
    const closed = stack.events.find((entry) => entry.event === 'remote_closed');
    assert.match(closed.reason, /upstream_login_failed/);
  });
});
