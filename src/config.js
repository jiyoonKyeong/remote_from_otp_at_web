// 환경 변수에서 설정을 읽고 검사한다.
// 값이 빠졌거나 안전하지 않으면 서버를 시작하지 않는다.

import { readFileSync } from 'node:fs';
import { smsConfigFromEnv } from './sms.js';
import { parsePasswordHash } from './password.js';

export class ConfigError extends Error {}

// 010-1234-5678, 01012345678, +821012345678 을 받아 두 가지 표기로 돌려준다.
export function normalizePhone(raw) {
  const compact = String(raw ?? '').replace(/[\s-]/g, '');
  const domestic = compact.startsWith('+82') ? `0${compact.slice(3)}` : compact;
  if (!/^01[016789]\d{7,8}$/.test(domestic)) return null;
  return { domestic, e164: `+82${domestic.slice(1)}` };
}

export function loadConfig(env = process.env) {
  const errors = [];

  const text = (key) => (env[key] ?? '').trim();
  const need = (key) => {
    const value = text(key);
    if (!value) errors.push(`${key} 값이 없습니다`);
    return value;
  };
  const integer = (key, fallback, min, max) => {
    const raw = text(key);
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${key} 는 ${min}~${max} 사이의 정수여야 합니다`);
      return fallback;
    }
    return value;
  };
  const url = (key) => {
    const raw = need(key);
    if (!raw) return null;
    try {
      return new URL(raw);
    } catch {
      errors.push(`${key} 가 올바른 주소가 아닙니다`);
      return null;
    }
  };

  // --- 이 웹앱의 공개 주소 -------------------------------------------------
  const origin = url('PUBLIC_ORIGIN');
  const local = origin !== null && ['localhost', '127.0.0.1'].includes(origin.hostname);
  // localhost 가 아닌 주소로 서비스하면 NODE_ENV 값과 상관없이 운영 기준을 적용한다.
  const production = env.NODE_ENV === 'production' || !local;
  if (origin) {
    if (origin.pathname !== '/' || origin.search || origin.hash || origin.username) {
      errors.push('PUBLIC_ORIGIN 에는 경로 없이 주소만 적어야 합니다 (예: https://gate.example.com)');
    }
    if (origin.protocol !== 'https:' && production) {
      errors.push('PUBLIC_ORIGIN 은 https 주소여야 합니다 (개발 중 localhost 만 http 허용)');
    }
  }

  const trustProxy = integer('TRUST_PROXY', 0, 0, 5);
  const certFile = text('TLS_CERT_FILE');
  const keyFile = text('TLS_KEY_FILE');
  let tls = null;
  if (certFile || keyFile) {
    if (!certFile || !keyFile) {
      errors.push('TLS_CERT_FILE 과 TLS_KEY_FILE 은 함께 지정해야 합니다');
    } else {
      try {
        tls = { cert: readFileSync(certFile), key: readFileSync(keyFile) };
      } catch {
        errors.push('TLS 인증서 또는 키 파일을 읽을 수 없습니다');
      }
    }
  }
  if (production && !tls && trustProxy < 1) {
    errors.push(
      '운영 환경에서는 HTTPS 가 필요합니다. 인증서 파일(TLS_CERT_FILE, TLS_KEY_FILE)을 지정하거나, ' +
        'HTTPS 를 처리하는 프록시 뒤에 두고 TRUST_PROXY=1 로 설정하세요',
    );
  }

  // --- 사용자 2명 ----------------------------------------------------------
  const users = [1, 2].map((number) => {
    const id = need(`USER${number}_ID`);
    if (id && !/^[A-Za-z0-9._-]{3,32}$/.test(id)) {
      errors.push(`USER${number}_ID 는 영문, 숫자, . _ - 로 3~32자여야 합니다`);
    }

    const phone = normalizePhone(need(`USER${number}_PHONE`));
    if (text(`USER${number}_PHONE`) && !phone) {
      errors.push(`USER${number}_PHONE 이 휴대폰 번호 형식이 아닙니다 (예: 01012345678)`);
    }

    const hashText = need(`USER${number}_PASSWORD_HASH`);
    const passwordHash = hashText ? parsePasswordHash(hashText) : null;
    if (hashText && !passwordHash) {
      errors.push(`USER${number}_PASSWORD_HASH 형식이 올바르지 않습니다 (npm run hash-password 로 만드세요)`);
    }

    return { id, name: text(`USER${number}_NAME`).slice(0, 40) || id, phone, passwordHash };
  });
  if (users[0].id && users[0].id.toLowerCase() === users[1].id.toLowerCase()) {
    errors.push('두 사용자의 아이디가 같습니다');
  }
  if (users[0].phone && users[1].phone && users[0].phone.domestic === users[1].phone.domestic) {
    errors.push('두 사용자의 휴대폰 번호가 같습니다. 서로 다른 두 사람의 번호여야 합니다');
  }

  const initialController = text('INITIAL_CONTROLLER') || users[0].id;
  if (users[0].id && users[1].id && !users.some((user) => user.id === initialController)) {
    errors.push('INITIAL_CONTROLLER 는 두 사용자 아이디 중 하나여야 합니다');
  }

  // --- Guacamole -----------------------------------------------------------
  const guacUrl = url('GUAC_URL');
  if (guacUrl) {
    if (!['https:', 'http:'].includes(guacUrl.protocol)) {
      errors.push('GUAC_URL 은 http(s) 주소여야 합니다');
    } else if (guacUrl.protocol !== 'https:' && production) {
      errors.push('운영 환경에서는 GUAC_URL 이 https 주소여야 합니다');
    }
    if (guacUrl.search || guacUrl.hash || guacUrl.username) {
      errors.push('GUAC_URL 에는 주소와 경로만 적어야 합니다 (예: https://guac.example.com/guacamole)');
    }
  }

  let extraHeaders = {};
  if (text('GUAC_EXTRA_HEADERS')) {
    try {
      const parsed = JSON.parse(text('GUAC_EXTRA_HEADERS'));
      const valid =
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.entries(parsed).every(
          ([name, value]) => /^[A-Za-z0-9-]+$/.test(name) && typeof value === 'string' && !/[\r\n]/.test(value),
        );
      if (!valid) throw new Error('invalid');
      extraHeaders = parsed;
    } catch {
      errors.push('GUAC_EXTRA_HEADERS 는 {"헤더이름":"값"} 형태의 JSON 이어야 합니다');
    }
  }

  const guac = {
    url: guacUrl ? guacUrl.href.replace(/\/+$/, '') : '',
    username: need('GUAC_USERNAME'),
    password: need('GUAC_PASSWORD'),
    connectionId: need('GUAC_CONNECTION_ID'),
    dataSource: text('GUAC_DATA_SOURCE'),
    extraHeaders,
  };

  const sms = smsConfigFromEnv(env, errors, { production });

  const port = integer('PORT', 8080, 1, 65535);
  const remote = {
    width: integer('REMOTE_WIDTH', 1600, 640, 4096),
    height: integer('REMOTE_HEIGHT', 900, 480, 2160),
    dpi: integer('REMOTE_DPI', 96, 72, 288),
  };
  const otpTtlMs = integer('OTP_TTL_SECONDS', 180, 60, 600) * 1000;
  const sessionIdleMs = integer('SESSION_IDLE_SECONDS', 120, 30, 3600) * 1000;
  const sessionMaxMs = integer('SESSION_MAX_MINUTES', 120, 5, 720) * 60_000;

  if (errors.length > 0) {
    throw new ConfigError(`설정에 문제가 있어 시작하지 않습니다:\n- ${errors.join('\n- ')}`);
  }

  return {
    production,
    host: text('HOST') || (production ? '0.0.0.0' : '127.0.0.1'),
    port,
    publicOrigin: origin.origin,
    publicHost: origin.host,
    secure: origin.protocol === 'https:',
    trustProxy,
    tls,
    users,
    initialController,
    guac,
    sms,
    remote,
    otpTtlMs,
    sessionIdleMs,
    sessionMaxMs,
  };
}
