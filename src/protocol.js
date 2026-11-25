// Guacamole 프로토콜 명령을 읽고, 통과시켜도 되는 것만 골라내는 부분.
//
// 명령 한 개의 모양:  <길이>.<값>,<길이>.<값>,...;
// 예) 4.size,1.0,4.1600,3.900;

export class ProtocolError extends Error {}

const MAX_ELEMENTS = 64;
const SURROGATE = /[\uD800-\uDFFF]/;

const isTerminator = (ch) => ch === ',' || ch === ';';

// 값이 끝나는 위치를 찾는다. 길이는 원래 "문자(코드 포인트) 수"지만
// 일부 구현은 UTF-16 단위 수를 쓰므로 둘 다 받아들인다.
function elementEnd(text, start, length) {
  const fast = start + length;
  if (fast < text.length && isTerminator(text[fast]) && !SURROGATE.test(text.slice(start, fast))) {
    return fast;
  }

  let index = start;
  let count = 0;
  while (count < length && index < text.length) {
    const code = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    index += pair ? 2 : 1;
    count += 1;
  }
  if (count === length && index < text.length && isTerminator(text[index])) return index;
  if (fast < text.length && isTerminator(text[fast])) return fast;
  return -1;
}

// 문자열 하나에 들어 있는 명령을 모두 읽어 [[opcode, ...인자], ...] 로 돌려준다.
// 조금이라도 형식이 어긋나면 ProtocolError 를 던진다.
export function parseInstructions(text) {
  const instructions = [];
  let position = 0;

  while (position < text.length) {
    const elements = [];
    for (;;) {
      const dot = text.indexOf('.', position);
      if (dot === -1 || dot === position || dot - position > 8) {
        throw new ProtocolError('잘못된 길이 표기');
      }
      const digits = text.slice(position, dot);
      if (!/^\d+$/.test(digits)) throw new ProtocolError('잘못된 길이 표기');

      const start = dot + 1;
      const end = elementEnd(text, start, Number(digits));
      if (end === -1) throw new ProtocolError('명령이 중간에 끊김');

      elements.push(text.slice(start, end));
      if (elements.length > MAX_ELEMENTS) throw new ProtocolError('인자가 너무 많음');

      position = end + 1;
      if (text[end] === ';') break;
    }
    instructions.push(elements);
  }

  return instructions;
}

// 명령 한 개를 문자열로 만든다. 이 서버가 만드는 명령의 값은 모두 ASCII 라서
// 길이를 세는 방식(코드 포인트 / UTF-16)에 따른 차이가 생기지 않는다.
export function encode(elements) {
  return (
    elements
      .map((element) => {
        const value = String(element);
        return `${value.length}.${value}`;
      })
      .join(',') + ';'
  );
}

// ---------------------------------------------------------------------------
// 원격 PC(Guacamole) → 브라우저 방향 필터
// ---------------------------------------------------------------------------

// 숫자, base64, MIME 형식, 속성 이름에 쓰이는 문자만 허용한다.
const SAFE_VALUE = /^[A-Za-z0-9+/=._-]*$/;
const INDEX = /^\d{1,9}$/;

// 화면을 그리는 데만 쓰이는 명령.
const DRAWING = new Set([
  'arc', 'cfill', 'clip', 'close', 'copy', 'cstroke', 'cursor', 'curve',
  'dispose', 'distort', 'identity', 'jpeg', 'lfill', 'line', 'lstroke',
  'mouse', 'move', 'png', 'pop', 'push', 'rect', 'reset', 'set', 'shade',
  'size', 'start', 'sync', 'transfer', 'transform',
]);

// 화면 밖으로 데이터를 실어 나르는 명령. 값은 스트림 번호가 들어 있는 인자 위치.
const DATA_STREAMS = {
  argv: 0,
  audio: 0,
  clipboard: 0,
  file: 0,
  pipe: 0,
  video: 0,
  body: 1,
};

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_STREAMS = 512;

// 연결 하나마다 새로 만든다. process() 의 결과:
//   forward  브라우저 두 곳에 그대로 보낼 명령
//   reply    Guacamole 쪽에 돌려줄 명령 (거절 응답)
//   blocked  막은 명령의 이름 (기록용)
//   end      연결을 끝내야 하는 이유
export function createUpstreamFilter() {
  const imageStreams = new Set();

  const safe = (args) => args.every((arg) => SAFE_VALUE.test(arg));

  return {
    process([opcode, ...args]) {
      // 터널 내부용(연결 식별자, ping 응답)과 단순 유지 신호는 전달하지 않는다.
      if (opcode === '' || opcode === 'nop' || opcode === 'ack') return {};

      if (DRAWING.has(opcode)) {
        return safe(args) ? { forward: encode([opcode, ...args]) } : { blocked: `${opcode}(형식)` };
      }

      if (opcode === 'img') {
        const [stream, , , mimetype] = args;
        if (!INDEX.test(stream ?? '') || !IMAGE_TYPES.has(mimetype) || !safe(args)) {
          return { blocked: 'img(형식)' };
        }
        if (imageStreams.size >= MAX_IMAGE_STREAMS) return { end: 'upstream_protocol_error' };
        imageStreams.add(stream);
        return { forward: encode([opcode, ...args]) };
      }

      // blob / end 는 화면 이미지 스트림에 속한 것만 통과시킨다.
      if (opcode === 'blob') {
        return imageStreams.has(args[0]) && args.length === 2 && SAFE_VALUE.test(args[1])
          ? { forward: encode([opcode, ...args]) }
          : {};
      }
      if (opcode === 'end') {
        return imageStreams.delete(args[0]) ? { forward: encode([opcode, args[0]]) } : {};
      }

      // 클립보드, 파일, 소리 등은 받지 않겠다고 Guacamole 에 알린다.
      if (opcode in DATA_STREAMS) {
        const stream = args[DATA_STREAMS[opcode]] ?? '';
        return {
          blocked: opcode,
          reply: INDEX.test(stream) ? encode(['ack', stream, 'Unsupported', 256]) : undefined,
        };
      }

      if (opcode === 'error') {
        const code = /^\d{1,5}$/.test(args[1] ?? '') ? Number(args[1]) : 0;
        return { end: 'upstream_error', detail: `${code} ${String(args[0] ?? '').slice(0, 200)}` };
      }
      if (opcode === 'disconnect') return { end: 'upstream_disconnect' };
      if (opcode === 'required') {
        return { end: 'upstream_required', detail: args.join(' ').slice(0, 200) };
      }

      // 그 밖의 명령(nest, msg, name, filesystem, undefine, 모르는 명령)은 버린다.
      return { blocked: opcode.slice(0, 32) };
    },
  };
}

// ---------------------------------------------------------------------------
// 브라우저 → 서버 방향
// ---------------------------------------------------------------------------

const TIMESTAMP = /^\d{1,15}$/;
const COORDINATE = /^\d{1,5}$/;
const MAX_KEYSYM = 0x1fffffff;

// 브라우저가 보낸 명령 한 개를 검사해 의미 있는 것만 정리해서 돌려준다.
// 허용 목록에 없거나 형식이 틀리면 null.
export function readClientInstruction([opcode, ...args]) {
  if (opcode === '') {
    return args.length === 2 && args[0] === 'ping' && TIMESTAMP.test(args[1])
      ? { type: 'ping', timestamp: args[1] }
      : null;
  }

  if (opcode === 'sync') {
    return TIMESTAMP.test(args[0] ?? '') ? { type: 'sync', timestamp: Number(args[0]) } : null;
  }

  if (opcode === 'key') {
    const [keysym, pressed] = args;
    if (args.length !== 2 || !/^\d{1,10}$/.test(keysym) || !/^[01]$/.test(pressed)) return null;
    const value = Number(keysym);
    if (value < 1 || value > MAX_KEYSYM) return null;
    return { type: 'key', keysym: value, pressed: Number(pressed) };
  }

  if (opcode === 'mouse') {
    const [x, y, mask] = args;
    if (args.length !== 3 || !COORDINATE.test(x) || !COORDINATE.test(y) || !/^\d{1,2}$/.test(mask)) {
      return null;
    }
    // 버튼: 왼쪽 1, 가운데 2, 오른쪽 4, 휠 위 8, 휠 아래 16
    if (Number(mask) > 31) return null;
    return { type: 'mouse', x: Number(x), y: Number(y), mask: Number(mask) };
  }

  if (opcode === 'disconnect') return { type: 'disconnect' };
  if (opcode === 'nop') return { type: 'nop' };
  return null;
}
