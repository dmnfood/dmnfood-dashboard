let cachedSession = null;

const REQUIRED_ENV = [
  'ECOUNT_COM_CODE',
  'ECOUNT_USER_ID',
  'ECOUNT_API_CERT_KEY',
  'ECOUNT_ZONE',
  'ECOUNT_ENV',
];

const SAFE_ERROR_MESSAGES = {
  205: 'IP not allowed',
  201: 'Invalid API certification key',
  204: 'Test/production key mismatch',
  20: 'Invalid login information',
  412: 'Rate limit exceeded',
};

const sendJson = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
};

const safeString = (value, max = 300) => String(value || '').slice(0, max);

const buildLoginUrl = ({ env, zone }) => {
  const cleanZone = String(zone || '').trim();
  const prefix = String(env || '').trim().toLowerCase() === 'test' ? 'sboapi' : 'oapi';
  return `https://${prefix}${cleanZone}.ecount.com/OAPI/V2/OAPILogin`;
};

const findSessionId = (value) => {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.SESSION_ID === 'string') return value.SESSION_ID;
  if (typeof value.sessionId === 'string') return value.sessionId;
  if (typeof value.SESSIONID === 'string') return value.SESSIONID;

  for (const child of Object.values(value)) {
    const found = findSessionId(child);
    if (found) return found;
  }
  return '';
};

const safeEcountMessage = (payload, fallback) => {
  if (!payload || typeof payload !== 'object') return fallback;
  return safeString(
    payload.Message ||
    payload.MESSAGE ||
    payload.message ||
    payload.Error ||
    payload.ERROR ||
    payload.error ||
    fallback,
  );
};

const findEcountErrorCode = (value) => {
  if (!value || typeof value !== 'object') return null;

  const candidates = [
    value.Code,
    value.CODE,
    value.code,
    value.ErrorCode,
    value.ERROR_CODE,
    value.errorCode,
    value.ResultCode,
    value.RESULT_CODE,
    value.statusCode,
  ];

  for (const candidate of candidates) {
    const normalized = Number(candidate);
    if (Number.isFinite(normalized)) return normalized;
  }

  for (const child of Object.values(value)) {
    const found = findEcountErrorCode(child);
    if (found !== null) return found;
  }
  return null;
};

const safeErrorDetails = (payload, fallback = 'Ecount login failed') => {
  const errorCode = findEcountErrorCode(payload);
  const mappedMessage = SAFE_ERROR_MESSAGES[errorCode];
  return {
    errorCode,
    errorMessage: mappedMessage || safeEcountMessage(payload, fallback) || fallback,
  };
};

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return sendJson(response, 405, {
      ok: false,
      message: 'POST 요청만 지원합니다.',
      code: 'method_not_allowed',
    });
  }

  const missing = REQUIRED_ENV.filter(name => !process.env[name]);
  if (missing.length) {
    console.error('[ecount-login] Missing environment variables:', missing.join(', '));
    return sendJson(response, 500, {
      ok: false,
      message: 'Ecount 환경 변수가 설정되지 않았습니다.',
      code: 'missing_ecount_env',
      errorMessage: 'Missing environment variables',
    });
  }

  const zone = process.env.ECOUNT_ZONE;
  const loginUrl = buildLoginUrl({ env: process.env.ECOUNT_ENV, zone });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const ecountResponse = await fetch(loginUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        COM_CODE: process.env.ECOUNT_COM_CODE,
        USER_ID: process.env.ECOUNT_USER_ID,
        API_CERT_KEY: process.env.ECOUNT_API_CERT_KEY,
        LAN_TYPE: 'ko-KR',
        ZONE: zone,
      }),
    });

    clearTimeout(timeout);

    const rawText = await ecountResponse.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch (error) {
      console.error('[ecount-login] Invalid JSON response:', {
        status: ecountResponse.status,
        bodyPreview: safeString(rawText, 160),
      });
      return sendJson(response, 502, {
        ok: false,
        message: 'Ecount 응답을 해석하지 못했습니다.',
        code: 'invalid_ecount_json',
      });
    }

    if (!ecountResponse.ok) {
      const details = safeErrorDetails(payload);
      console.error('[ecount-login] Ecount HTTP error:', {
        status: ecountResponse.status,
        errorCode: details.errorCode,
        errorMessage: details.errorMessage,
      });
      return sendJson(response, 502, {
        ok: false,
        message: 'Ecount login failed',
        code: 'ecount_http_error',
        errorCode: details.errorCode,
        errorMessage: details.errorMessage,
      });
    }

    const sessionId = findSessionId(payload);
    if (!sessionId) {
      const details = safeErrorDetails(payload);
      console.error('[ecount-login] SESSION_ID missing in successful HTTP response:', {
        errorCode: details.errorCode,
        errorMessage: details.errorMessage,
      });
      return sendJson(response, 502, {
        ok: false,
        message: 'Ecount login failed',
        code: 'missing_session_id',
        errorCode: details.errorCode,
        errorMessage: details.errorMessage,
      });
    }

    cachedSession = {
      sessionId,
      zone: String(zone || '').trim(),
      createdAt: Date.now(),
    };

    return sendJson(response, 200, {
      ok: true,
      message: 'Ecount login successful',
      hasSession: true,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      console.error('[ecount-login] Request timed out.');
      return sendJson(response, 504, {
        ok: false,
        message: 'Ecount login timed out',
        code: 'ecount_timeout',
      });
    }

    console.error('[ecount-login] Serverless runtime error:', {
      name: safeString(error.name, 80),
      message: safeString(error.message, 200),
    });
    return sendJson(response, 500, {
      ok: false,
      message: 'Ecount login failed',
      code: 'serverless_runtime_error',
    });
  }
};
