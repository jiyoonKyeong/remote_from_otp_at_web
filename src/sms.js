// 문자(SMS) 발송. 발송 서비스는 SMS_PROVIDER 로 고른다.
//   console  문자를 보내지 않고 서버 로그에 인증번호를 찍는다 (개발용, 운영에서는 거부됨)
//   solapi   솔라피 (구 쿨에스엠에스)
//   sens     네이버 클라우드 SENS
//   twilio   Twilio

import { createHmac, randomBytes } from 'node:crypto';

const TIMEOUT_MS = 10_000;

// 환경 변수에서 발송 설정을 읽는다. 빠진 값은 errors 에 쌓는다.
export function smsConfigFromEnv(env, errors, { production }) {
  const provider = (env.SMS_PROVIDER ?? '').trim().toLowerCase();
  const need = (key) => {
    const value = (env[key] ?? '').trim();
    if (!value) errors.push(`${key} 값이 없습니다 (SMS_PROVIDER=${provider})`);
    return value;
  };

  switch (provider) {
    case 'console':
      if (production) errors.push('운영 환경에서는 SMS_PROVIDER=console 을 쓸 수 없습니다');
      return { provider };
    case 'solapi':
      return {
        provider,
        apiKey: need('SOLAPI_API_KEY'),
        apiSecret: need('SOLAPI_API_SECRET'),
        from: need('SMS_FROM').replace(/[\s-]/g, ''),
      };
    case 'sens':
      return {
        provider,
        accessKey: need('SENS_ACCESS_KEY'),
        secretKey: need('SENS_SECRET_KEY'),
        serviceId: need('SENS_SERVICE_ID'),
        from: need('SMS_FROM').replace(/[\s-]/g, ''),
      };
    case 'twilio':
      return {
        provider,
        accountSid: need('TWILIO_ACCOUNT_SID'),
        authToken: need('TWILIO_AUTH_TOKEN'),
        from: need('SMS_FROM').replace(/[\s-]/g, ''),
      };
    default:
      errors.push('SMS_PROVIDER 는 console, solapi, sens, twilio 중 하나여야 합니다');
      return { provider: 'invalid' };
  }
}

async function post(url, { headers, body }) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    // 응답 본문에는 수신 번호 등이 들어 있을 수 있어 상태 코드만 남긴다.
    throw new Error(`문자 발송 서비스 응답 ${response.status}`);
  }
}

const senders = {
  console: () => async (phone, text) => {
    process.stdout.write(`[개발용 문자] ${phone.domestic} ← ${text}\n`);
  },

  solapi: (config) => async (phone, text) => {
    const date = new Date().toISOString();
    const salt = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', config.apiSecret).update(date + salt).digest('hex');
    await post('https://api.solapi.com/messages/v4/send', {
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC-SHA256 apiKey=${config.apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
      },
      body: JSON.stringify({ message: { to: phone.domestic, from: config.from, text } }),
    });
  },

  sens: (config) => async (phone, text) => {
    const path = `/sms/v2/services/${encodeURIComponent(config.serviceId)}/messages`;
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', config.secretKey)
      .update(`POST ${path}\n${timestamp}\n${config.accessKey}`)
      .digest('base64');
    await post(`https://sens.apigw.ntruss.com${path}`, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-ncp-apigw-timestamp': timestamp,
        'x-ncp-iam-access-key': config.accessKey,
        'x-ncp-apigw-signature-v2': signature,
      },
      body: JSON.stringify({
        type: 'SMS',
        contentType: 'COMM',
        countryCode: '82',
        from: config.from,
        content: text,
        messages: [{ to: phone.domestic }],
      }),
    });
  },

  twilio: (config) => async (phone, text) => {
    const basic = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
    await post(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({ To: phone.e164, From: config.from, Body: text }).toString(),
      },
    );
  },
};

// (phone, text) 를 받아 문자를 보내는 함수를 돌려준다. 실패하면 예외를 던진다.
export function createSmsSender(smsConfig) {
  const make = senders[smsConfig.provider];
  if (!make) throw new Error('알 수 없는 문자 발송 서비스');
  return make(smsConfig);
}
