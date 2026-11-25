// 비밀번호를 입력받아 .env 에 넣을 해시를 출력한다.
// 입력한 글자는 화면에 보이지 않고, 어디에도 저장되지 않는다.

import { stdin, stdout } from 'node:process';
import { hashPassword } from '../src/password.js';

const MIN_LENGTH = 12;

// 입력을 한 줄씩 모아 두었다가 순서대로 내준다.
const lines = [];
const waiting = [];
let current = '';
let lastWasReturn = false;
let ended = false;

function deliver() {
  while (waiting.length > 0 && (lines.length > 0 || ended)) {
    const { resolve, reject } = waiting.shift();
    if (lines.length > 0) resolve(lines.shift());
    else reject(new Error('입력이 끝났습니다.'));
  }
}

stdin.on('data', (chunk) => {
  for (const char of chunk.toString('utf8')) {
    if (char === '\u0003') {
      stdout.write('\n취소했습니다.\n');
      process.exit(1);
    }
    if (char === '\n' && lastWasReturn) {
      lastWasReturn = false;
      continue;
    }
    lastWasReturn = char === '\r';

    if (char === '\r' || char === '\n') {
      lines.push(current);
      current = '';
    } else if (char === '\u007f' || char === '\b') {
      current = current.slice(0, -1);
    } else {
      current += char;
    }
  }
  deliver();
});
stdin.on('end', () => {
  ended = true;
  deliver();
});

function ask(prompt) {
  stdout.write(prompt);
  return new Promise((resolve, reject) => {
    waiting.push({ resolve, reject });
    deliver();
  }).finally(() => stdout.write('\n'));
}

if (stdin.isTTY) stdin.setRawMode(true);
stdin.resume();

let exitCode = 0;
try {
  const password = await ask(`비밀번호 (${MIN_LENGTH}자 이상): `);
  if (password.length < MIN_LENGTH) throw new Error(`${MIN_LENGTH}자 이상이어야 합니다.`);
  const again = await ask('한 번 더 입력: ');
  if (password !== again) throw new Error('두 입력이 다릅니다.');

  const hash = await hashPassword(password);
  stdout.write(`\n아래 값을 USER1_PASSWORD_HASH 또는 USER2_PASSWORD_HASH 에 넣으세요:\n${hash}\n`);
} catch (error) {
  console.error(error.message);
  exitCode = 1;
}

if (stdin.isTTY) stdin.setRawMode(false);
process.exit(exitCode);
