// 시작점. 설정을 읽고 서버를 띄운다.

import { ConfigError, loadConfig } from './config.js';
import { createGate } from './gate.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const gate = await createGate(config);

gate.server.listen(config.port, config.host, () => {
  console.error(`원격 접속 게이트 시작: ${config.publicOrigin} (수신 ${config.host}:${config.port})`);
  if (!config.production) {
    console.error('※ 개발 모드입니다. 운영에서는 NODE_ENV=production 으로 실행하세요.');
  }
});

// 종료할 때 열려 있는 원격 연결을 닫고 Guacamole 토큰을 폐기한다.
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const forced = setTimeout(() => process.exit(0), 5_000);
  forced.unref();
  await gate.close();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
