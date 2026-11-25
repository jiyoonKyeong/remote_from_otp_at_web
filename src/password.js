// 비밀번호 해시 (scrypt). 저장 형식:  scrypt:N:r:p:salt:hash  (salt, hash 는 base64url)

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const DEFAULTS = { N: 32768, r: 8, p: 1 };
const KEY_LENGTH = 32;
const MAX_MEMORY = 128 * 1024 * 1024;

function derive(password, salt, { N, r, p }, length) {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, length, { N, r, p, maxmem: MAX_MEMORY }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export function parsePasswordHash(text) {
  const parts = String(text).split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const [N, r, p] = parts.slice(1, 4).map(Number);
  const powerOfTwo = Number.isInteger(N) && (N & (N - 1)) === 0;
  if (!powerOfTwo || N < 16384 || N > 131072 || r !== 8 || !Number.isInteger(p) || p < 1 || p > 4) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(parts[4]) || !/^[A-Za-z0-9_-]+$/.test(parts[5])) return null;

  const salt = Buffer.from(parts[4], 'base64url');
  const hash = Buffer.from(parts[5], 'base64url');
  if (salt.length < 16 || hash.length < 32 || hash.length > 64) return null;

  return { N, r, p, salt, hash };
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, DEFAULTS, KEY_LENGTH);
  return ['scrypt', DEFAULTS.N, DEFAULTS.r, DEFAULTS.p, salt.toString('base64url'), hash.toString('base64url')].join(':');
}

export async function verifyPassword(password, parsed) {
  const candidate = await derive(password, parsed.salt, parsed, parsed.hash.length);
  return timingSafeEqual(candidate, parsed.hash);
}
