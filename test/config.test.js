import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig, normalizePhone } from '../src/config.js';
import { hashPassword } from '../src/password.js';

const base = {
  NODE_ENV: 'production',
  PUBLIC_ORIGIN: 'https://gate.example.com',
  TRUST_PROXY: '1',
  USER1_ID: 'alice',
  USER1_PHONE: '010-1111-2222',
  USER1_PASSWORD_HASH: await hashPassword('alice-password-123'),
  USER2_ID: 'bob',
  USER2_PHONE: '+821033334444',
  USER2_PASSWORD_HASH: await hashPassword('bob-password-456'),
  SMS_PROVIDER: 'solapi',
  SOLAPI_API_KEY: 'key',
  SOLAPI_API_SECRET: 'secret',
  SMS_FROM: '02-1234-5678',
  GUAC_URL: 'https://guac.example.com/guacamole/',
  GUAC_USERNAME: 'gate-service',
  GUAC_PASSWORD: 'service-password',
  GUAC_CONNECTION_ID: '1',
};

const refuses = (changes, pattern) =>
  assert.throws(
    () => loadConfig({ ...base, ...changes }),
    (error) => error instanceof ConfigError && pattern.test(error.message),
  );

test('올바른 운영 설정은 받아들인다', () => {
  const config = loadConfig(base);
  assert.equal(config.production, true);
  assert.equal(config.publicOrigin, 'https://gate.example.com');
  assert.equal(config.secure, true);
  assert.equal(config.guac.url, 'https://guac.example.com/guacamole');
  assert.equal(config.initialController, 'alice');
  assert.deepEqual(config.users[1].phone, { domestic: '01033334444', e164: '+821033334444' });
  assert.deepEqual(config.remote, { width: 1600, height: 900, dpi: 96 });
});

test('운영 환경에서 안전하지 않은 설정은 시작을 거부한다', () => {
  refuses({ SMS_PROVIDER: 'console' }, /console/);
  refuses({ PUBLIC_ORIGIN: 'http://gate.example.com' }, /PUBLIC_ORIGIN/);
  refuses({ PUBLIC_ORIGIN: 'http://localhost:8080' }, /PUBLIC_ORIGIN/);
  refuses({ GUAC_URL: 'http://guac.example.com/guacamole' }, /GUAC_URL/);
  refuses({ TRUST_PROXY: '0' }, /HTTPS/);
});

test('NODE_ENV 를 빠뜨려도 localhost 가 아닌 주소면 운영 기준을 적용한다', () => {
  refuses({ NODE_ENV: '', SMS_PROVIDER: 'console' }, /console/);
  refuses({ NODE_ENV: '', GUAC_URL: 'http://guac.example.com/guacamole' }, /GUAC_URL/);
  assert.equal(loadConfig({ ...base, NODE_ENV: '' }).production, true);
});

test('두 사용자는 서로 다른 사람이어야 한다', () => {
  refuses({ USER2_ID: 'alice' }, /아이디가 같습니다/);
  refuses({ USER2_PHONE: '01011112222' }, /휴대폰 번호가 같습니다/);
});

test('빠지거나 형식이 틀린 값은 이유와 함께 거부한다', () => {
  refuses({ USER1_PASSWORD_HASH: 'plain-password' }, /USER1_PASSWORD_HASH/);
  refuses({ USER1_PHONE: '12345' }, /USER1_PHONE/);
  refuses({ GUAC_PASSWORD: '' }, /GUAC_PASSWORD/);
  refuses({ SOLAPI_API_SECRET: '' }, /SOLAPI_API_SECRET/);
  refuses({ INITIAL_CONTROLLER: 'carol' }, /INITIAL_CONTROLLER/);
  refuses({ GUAC_EXTRA_HEADERS: '{"X-Bad": "a\\r\\nInjected: 1"}' }, /GUAC_EXTRA_HEADERS/);
  refuses({ REMOTE_WIDTH: '99999' }, /REMOTE_WIDTH/);
});

test('개발 중에는 localhost 와 console 문자를 허용한다', () => {
  const config = loadConfig({
    ...base,
    NODE_ENV: '',
    TRUST_PROXY: '',
    PUBLIC_ORIGIN: 'http://localhost:8080',
    SMS_PROVIDER: 'console',
    GUAC_URL: 'http://127.0.0.1:8081/guacamole',
  });
  assert.equal(config.production, false);
  assert.equal(config.secure, false);
  assert.equal(config.host, '127.0.0.1');
});

test('휴대폰 번호 표기를 맞춘다', () => {
  assert.deepEqual(normalizePhone('010 1234 5678'), { domestic: '01012345678', e164: '+821012345678' });
  assert.equal(normalizePhone('02-123-4567'), null);
  assert.equal(normalizePhone(''), null);
});
