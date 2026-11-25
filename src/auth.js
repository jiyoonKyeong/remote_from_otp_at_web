// 로그인(아이디·비밀번호) → 문자 인증번호 → 인증된 세션.
// 모든 상태는 메모리에만 있다. 서버가 다시 시작되면 모두 처음부터 인증해야 한다.

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hashPassword, parsePasswordHash, verifyPassword } from './password.js';
import { maskPhone } from './audit.js';

const OTP_ATTEMPTS = 5; // 인증번호 한 개당 입력 기회
const OTP_PER_LOGIN = 3; // 로그인 한 번에 받을 수 있는 인증번호 수
const OTP_RESEND_WAIT_MS = 30_000;
const PENDING_MAX_MS = 10 * 60_000; // 인증번호 입력 단계에 머물 수 있는 시간

const LIMITS = {
  loginPerIp: [20, 10 * 60_000],
  loginGlobal: [120, 60_000],
  otpPerIp: [40, 10 * 60_000],
  failuresPerAccount: [10, 15 * 60_000], // 넘으면 창이 끝날 때까지 잠김
  smsPerUser: [5, 10 * 60_000],
};
const MAX_LIMIT_KEYS = 20_000;

const GENERIC_LOGIN_ERROR = '아이디 또는 비밀번호가 올바르지 않습니다.';
const TOO_MANY = '시도가 너무 많습니다. 잠시 후 다시 시도하세요.';

// 정해진 시간 창 안에서 횟수를 세는 단순한 제한기.
function createLimiter(now) {
  const entries = new Map();

  const current = (key) => {
    const entry = entries.get(key);
    if (entry && entry.resetAt > now()) return entry;
    entries.delete(key);
    return null;
  };

  return {
    // 한 번 센다. 한도를 넘으면 false.
    hit(key, [limit, windowMs]) {
      let entry = current(key);
      if (!entry) {
        // 키가 지나치게 많으면 새 키는 받지 않는다 (메모리 보호, 닫힌 쪽으로 실패).
        if (entries.size >= MAX_LIMIT_KEYS) return false;
        entry = { count: 0, resetAt: now() + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= limit;
    },
    // 세지 않고 한도에 닿았는지만 본다.
    reached(key, [limit]) {
      const entry = current(key);
      return entry !== null && entry.count >= limit;
    },
    prune() {
      for (const [key, entry] of entries) if (entry.resetAt <= now()) entries.delete(key);
    },
  };
}

const failure = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

export async function createAuth({ config, sendSms, audit, now = Date.now, onSessionEnd = () => {} }) {
  const sessions = new Map();
  const limiter = createLimiter(now);
  const otpKey = randomBytes(32);

  // 없는 아이디로 로그인해도 같은 시간이 걸리도록 비교용 해시를 하나 만들어 둔다.
  const decoyHash = parsePasswordHash(await hashPassword(randomBytes(24).toString('hex')));

  const userById = (id) => config.users.find((user) => user.id === id) ?? null;
  const accountKey = (id) => `account:${createHash('sha256').update(String(id)).digest('hex').slice(0, 24)}`;
  const otpMac = (session, code) => createHmac('sha256', otpKey).update(`${session.id}:${code}`).digest();

  function end(session, reason) {
    if (!sessions.delete(session.id)) return;
    audit('session_end', { user: session.userId, stage: session.stage, reason });
    if (session.stage === 'verified') onSessionEnd(session.id, session.userId, reason);
  }

  function expired(session) {
    if (session.stage === 'otp') return now() > session.createdAt + PENDING_MAX_MS ? 'otp_timeout' : null;
    if (now() > session.expiresAt) return 'max_time';
    if (now() > session.lastSeen + config.sessionIdleMs) return 'idle';
    return null;
  }

  function sweep() {
    for (const session of [...sessions.values()]) {
      const reason = expired(session);
      if (reason) end(session, reason);
    }
    limiter.prune();
  }
  const sweepTimer = setInterval(sweep, 5_000);
  sweepTimer.unref();

  async function issueOtp(session) {
    const user = userById(session.userId);
    if (!limiter.hit(`sms:${user.id}`, LIMITS.smsPerUser)) {
      return failure(429, '인증번호 요청이 너무 많습니다. 10분 뒤에 다시 시도하세요.');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    session.otp = {
      mac: otpMac(session, code),
      expiresAt: now() + config.otpTtlMs,
      attemptsLeft: OTP_ATTEMPTS,
    };
    session.otpCount += 1;
    session.resendAt = now() + OTP_RESEND_WAIT_MS;

    const minutes = Math.round(config.otpTtlMs / 60_000);
    try {
      await sendSms(user.phone, `[원격접속] 인증번호 ${code} (${minutes}분 안에 입력). 타인에게 알리지 마세요.`);
    } catch (error) {
      session.otp = null;
      audit('otp_send_failed', { user: user.id, detail: String(error?.message ?? error).slice(0, 200) });
      return failure(502, '인증번호 문자를 보내지 못했습니다. 잠시 후 다시 시도하세요.');
    }

    audit('otp_sent', { user: user.id, phone: maskPhone(user.phone.domestic) });
    return { ok: true };
  }

  const otpView = (session) => ({
    phone: maskPhone(userById(session.userId).phone.domestic),
    expiresAt: session.otp?.expiresAt ?? 0,
    resendAt: session.resendAt,
    attemptsLeft: session.otp?.attemptsLeft ?? 0,
    resendsLeft: OTP_PER_LOGIN - session.otpCount,
  });

  return {
    // 1단계: 아이디와 비밀번호. 맞으면 인증번호를 문자로 보내고 임시 세션을 만든다.
    async login(ip, id, password) {
      if (
        typeof id !== 'string' || typeof password !== 'string' ||
        id.length === 0 || id.length > 64 || password.length === 0 || password.length > 256
      ) {
        return failure(400, GENERIC_LOGIN_ERROR);
      }
      if (!limiter.hit(`login-ip:${ip}`, LIMITS.loginPerIp) || !limiter.hit('login-all', LIMITS.loginGlobal)) {
        audit('login_rate_limited', { ip });
        return failure(429, TOO_MANY);
      }
      // 없는 아이디도 같은 방식으로 세어, 잠김 여부로 아이디 존재를 알 수 없게 한다.
      // 입력한 아이디는 기록하지 않는다 (아이디 칸에 비밀번호를 잘못 넣는 경우가 있다).
      const user = userById(id);
      if (limiter.reached(accountKey(id), LIMITS.failuresPerAccount)) {
        audit('login_locked', { ip, user: user?.id });
        return failure(429, TOO_MANY);
      }

      const matches = await verifyPassword(password, user ? user.passwordHash : decoyHash);
      if (!user || !matches) {
        limiter.hit(accountKey(id), LIMITS.failuresPerAccount);
        audit('login_failed', { ip, user: user?.id });
        return failure(401, GENERIC_LOGIN_ERROR);
      }

      // 같은 사용자의 이전 인증 대기 세션은 버린다 (가장 최근 인증번호만 유효).
      for (const other of [...sessions.values()]) {
        if (other.userId === user.id && other.stage === 'otp') end(other, 'new_login');
      }

      const session = {
        id: randomBytes(32).toString('base64url'),
        userId: user.id,
        stage: 'otp',
        createdAt: now(),
        lastSeen: now(),
        expiresAt: 0,
        otp: null,
        otpCount: 0,
        resendAt: 0,
        ip,
      };
      sessions.set(session.id, session);

      const sent = await issueOtp(session);
      if (!sent.ok) {
        end(session, 'otp_not_sent');
        return sent;
      }

      audit('login_password_ok', { ip, user: user.id });
      return { ok: true, sessionId: session.id, otp: otpView(session) };
    },

    // 2단계: 문자로 받은 인증번호. 맞으면 세션 값을 새로 발급한다.
    async verifyOtp(sessionId, code, ip) {
      const session = this.get(sessionId);
      if (!session || session.stage !== 'otp') return failure(401, '다시 로그인하세요.');
      if (!limiter.hit(`otp-ip:${ip}`, LIMITS.otpPerIp)) return failure(429, TOO_MANY);
      if (limiter.reached(accountKey(session.userId), LIMITS.failuresPerAccount)) {
        end(session, 'locked');
        return failure(429, TOO_MANY);
      }

      const otp = session.otp;
      if (!otp || now() > otp.expiresAt || otp.attemptsLeft <= 0) {
        session.otp = null;
        return failure(400, '인증번호가 만료되었습니다. 다시 받아 주세요.', { otp: otpView(session) });
      }

      // 비교하기 전에 기회를 먼저 줄인다.
      otp.attemptsLeft -= 1;
      const wellFormed = typeof code === 'string' && /^\d{6}$/.test(code);
      const matches = wellFormed && timingSafeEqual(otpMac(session, code), otp.mac);

      if (!matches) {
        limiter.hit(accountKey(session.userId), LIMITS.failuresPerAccount);
        audit('otp_failed', { ip, user: session.userId, attemptsLeft: otp.attemptsLeft });
        if (otp.attemptsLeft <= 0) {
          session.otp = null;
          if (session.otpCount >= OTP_PER_LOGIN) {
            end(session, 'otp_exhausted');
            return failure(401, '인증에 실패했습니다. 처음부터 다시 로그인하세요.');
          }
          return failure(400, '입력 기회를 모두 썼습니다. 인증번호를 다시 받아 주세요.', { otp: otpView(session) });
        }
        return failure(400, `인증번호가 맞지 않습니다. (남은 기회 ${otp.attemptsLeft}번)`, { otp: otpView(session) });
      }

      // 인증번호는 한 번만 쓸 수 있다. 세션 값도 새로 만든다.
      session.otp = null;
      for (const other of [...sessions.values()]) {
        if (other.userId === session.userId && other !== session) end(other, 'replaced');
      }
      sessions.delete(session.id);
      session.id = randomBytes(32).toString('base64url');
      session.stage = 'verified';
      session.lastSeen = now();
      session.expiresAt = now() + config.sessionMaxMs;
      session.ip = ip;
      sessions.set(session.id, session);

      audit('otp_verified', { ip, user: session.userId });
      return { ok: true, sessionId: session.id };
    },

    async resendOtp(sessionId) {
      const session = this.get(sessionId);
      if (!session || session.stage !== 'otp') return failure(401, '다시 로그인하세요.');
      if (now() < session.resendAt) {
        return failure(429, '조금 뒤에 다시 받을 수 있습니다.', { otp: otpView(session) });
      }
      if (session.otpCount >= OTP_PER_LOGIN) {
        end(session, 'otp_exhausted');
        return failure(401, '인증번호를 더 받을 수 없습니다. 처음부터 다시 로그인하세요.');
      }

      const sent = await issueOtp(session);
      if (!sent.ok) return { ...sent, otp: otpView(session) };
      return { ok: true, otp: otpView(session) };
    },

    logout(sessionId) {
      const session = sessions.get(sessionId);
      if (session) end(session, 'logout');
    },

    // 유효한 세션을 돌려준다. 만료됐으면 지우고 null.
    get(sessionId, { touch = true } = {}) {
      const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!session) return null;
      const reason = expired(session);
      if (reason) {
        end(session, reason);
        return null;
      }
      if (touch) session.lastSeen = now();
      return session;
    },

    isVerified(sessionId) {
      return this.get(sessionId, { touch: false })?.stage === 'verified';
    },

    // 화면 연결이 살아 있는 동안에는 자리를 비운 것으로 보지 않는다.
    touch(sessionId) {
      const session = sessions.get(sessionId);
      if (session) session.lastSeen = now();
    },

    userVerified(userId) {
      for (const session of sessions.values()) {
        if (session.userId === userId && session.stage === 'verified' && !expired(session)) return true;
      }
      return false;
    },

    otpView,
    userById,
    sweep,
    stop() {
      clearInterval(sweepTimer);
    },
  };
}
