// 접속 기록. 한 줄에 JSON 하나씩 표준 출력으로 내보낸다.
// 인증번호, 비밀번호, 세션 값은 절대 넘기지 않는다.

export function createAudit(write = (line) => process.stdout.write(`${line}\n`)) {
  return function audit(event, fields = {}) {
    write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
  };
}

// 01012345678 → 010****5678
export function maskPhone(phone) {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
