import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ProtocolError,
  createUpstreamFilter,
  encode,
  parseInstructions,
  readClientInstruction,
} from '../src/protocol.js';

test('명령을 읽고 다시 만들 수 있다', () => {
  const text = encode(['size', 0, 1600, 900]) + encode(['sync', 12345]);
  assert.equal(text, '4.size,1.0,4.1600,3.900;4.sync,5.12345;');
  assert.deepEqual(parseInstructions(text), [
    ['size', '0', '1600', '900'],
    ['sync', '12345'],
  ]);
  assert.deepEqual(parseInstructions('0.,4.ping,2.42;'), [['', 'ping', '42']]);
});

test('값 안에 든 쉼표와 세미콜론은 구분자로 보지 않는다', () => {
  assert.deepEqual(parseInstructions('4.name,5.a,b;c;'), [['name', 'a,b;c']]);
});

test('길이를 코드 포인트로 세든 UTF-16 단위로 세든 읽는다', () => {
  // "😀a" : 코드 포인트 2개, UTF-16 단위 3개
  assert.deepEqual(parseInstructions('4.name,2.😀a;'), [['name', '😀a']]);
  assert.deepEqual(parseInstructions('4.name,3.😀a;'), [['name', '😀a']]);
  assert.deepEqual(parseInstructions('4.name,3.한글!;'), [['name', '한글!']]);
});

test('형식이 어긋난 입력은 거부한다', () => {
  for (const bad of ['4.size', '4.size,', 'x.size;', '4.sizes;', '.;', '9999999999.a;', '3.key,1.1', '-1.a;']) {
    assert.throws(() => parseInstructions(bad), ProtocolError, bad);
  }
});

test('화면 그리기 명령만 브라우저로 통과한다', () => {
  const filter = createUpstreamFilter();
  const pass = (instruction) => filter.process(instruction).forward;

  assert.equal(pass(['size', '0', '1600', '900']), encode(['size', 0, 1600, 900]));
  assert.equal(pass(['png', '14', '0', '0', '0', 'iVBORw0KGgo=']), encode(['png', 14, 0, 0, 0, 'iVBORw0KGgo=']));
  assert.equal(pass(['sync', '1234', '1']), encode(['sync', 1234, 1]));

  for (const opcode of ['nest', 'msg', 'name', 'filesystem', 'undefine', 'required-ish', 'select']) {
    const result = filter.process([opcode, '0', 'x']);
    assert.equal(result.forward, undefined, opcode);
  }
  // 터널 내부용 명령과 유지 신호
  assert.deepEqual(filter.process(['', 'ping', '1']), {});
  assert.deepEqual(filter.process(['nop']), {});
});

test('클립보드·파일·소리 스트림은 막고 거절 응답을 돌려준다', () => {
  const filter = createUpstreamFilter();

  for (const opcode of ['clipboard', 'file', 'pipe', 'audio', 'video', 'argv']) {
    const result = filter.process([opcode, '7', 'text/plain', 'x']);
    assert.equal(result.forward, undefined, opcode);
    assert.equal(result.blocked, opcode);
    assert.equal(result.reply, encode(['ack', 7, 'Unsupported', 256]));
  }
  assert.equal(filter.process(['body', '0', '9', 'text/plain', 'x']).reply, encode(['ack', 9, 'Unsupported', 256]));

  // 막힌 스트림의 내용과 끝 표시는 전달되지 않는다.
  assert.deepEqual(filter.process(['blob', '7', 'c2VjcmV0']), {});
  assert.deepEqual(filter.process(['end', '7']), {});
});

test('blob 은 화면 이미지 스트림에 속한 것만 통과한다', () => {
  const filter = createUpstreamFilter();

  assert.ok(filter.process(['img', '3', '14', '0', 'image/png', '10', '20']).forward);
  assert.equal(filter.process(['blob', '3', 'iVBORw0KGgo=']).forward, encode(['blob', 3, 'iVBORw0KGgo=']));
  assert.equal(filter.process(['end', '3']).forward, encode(['end', 3]));
  assert.deepEqual(filter.process(['blob', '3', 'iVBORw0KGgo=']), {}, '끝난 스트림');

  // 이미지가 아닌 형식의 img 는 막는다.
  assert.equal(filter.process(['img', '4', '14', '0', 'text/html', '0', '0']).forward, undefined);
  assert.deepEqual(filter.process(['blob', '4', 'PGh0bWw+']), {});
});

test('예상 밖의 문자가 든 그리기 명령은 통과하지 못한다', () => {
  const filter = createUpstreamFilter();
  assert.equal(filter.process(['png', '14', '0', '0', '0', '"><script>']).forward, undefined);
  assert.equal(filter.process(['set', '0', 'miter-limit', '한글']).forward, undefined);
  assert.equal(filter.process(['size', '0', '10;4.nest', '1']).forward, undefined);
});

test('오류·종료·추가 정보 요구는 연결 종료로 처리한다', () => {
  const filter = createUpstreamFilter();
  assert.equal(filter.process(['error', 'Aborted', '521']).end, 'upstream_error');
  assert.equal(filter.process(['disconnect']).end, 'upstream_disconnect');
  assert.equal(filter.process(['required', 'password']).end, 'upstream_required');
});

test('브라우저 입력은 허용 목록과 형식 검사를 통과한 것만 받는다', () => {
  assert.deepEqual(readClientInstruction(['key', '65', '1']), { type: 'key', keysym: 65, pressed: 1 });
  assert.deepEqual(readClientInstruction(['mouse', '10', '20', '1']), { type: 'mouse', x: 10, y: 20, mask: 1 });
  assert.deepEqual(readClientInstruction(['sync', '123']), { type: 'sync', timestamp: 123 });
  assert.deepEqual(readClientInstruction(['', 'ping', '99']), { type: 'ping', timestamp: '99' });

  for (const bad of [
    ['key', '65', '2'],
    ['key', '-1', '1'],
    ['key', '99999999999', '1'],
    ['key', '65'],
    ['mouse', '10', '20', '64'],
    ['mouse', '1e3', '20', '0'],
    ['clipboard', '0', 'text/plain'],
    ['blob', '0', 'aGk='],
    ['size', '800', '600', '96'],
    ['file', '0', 'text/plain', 'a.txt'],
    ['ack', '1', 'OK', '0'],
    ['select', 'rdp'],
    ['connect', 'host'],
    ['', 'other'],
  ]) {
    assert.equal(readClientInstruction(bad), null, bad.join(','));
  }
});
