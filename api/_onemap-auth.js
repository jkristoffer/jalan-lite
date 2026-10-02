
const { fetchJson, UpstreamError } = require('./_upstream');

let cachedToken = null;
let cachedExpiry = 0;
let inFlightRefresh = null;
let stateGeneration = 0;

const AUTH_URL = 'https://www.onemap.gov.sg/api/auth/post/getToken';
const REFRESH_BUFFER_SECONDS = 5 * 60;

function nowInUnixSeconds() {
  return Date.now() / 1000;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function expiryTimestamp(value, now = nowInUnixSeconds()) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && value.trim().length === 0)) {
    return null;
  }

  const expiry = Number(value);
  return Number.isFinite(expiry) && expiry > now ? expiry : null;
}

function isTokenPayload(value, now = nowInUnixSeconds()) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.access_token === 'string'
    && value.access_token.trim().length > 0
    && expiryTimestamp(value.expiry_timestamp, now) !== null;
}

function directToken() {
  const token = process.env.ONEMAP_ACCESS_TOKEN || process.env.ONEMAP_TOKEN;
  return isNonEmptyString(token) ? token : null;
}

function credentials() {
  const email = process.env.ONEMAP_EMAIL;
  const password = isNonEmptyString(process.env.ONEMAP_PASSWORD)
    ? process.env.ONEMAP_PASSWORD
    : process.env.ONEMAP_EMAIL_PASSWORD;

  return {
    email,
    password,
    configured: isNonEmptyString(email) && isNonEmptyString(password),
  };
}

function cachedTokenIsUsable(now = nowInUnixSeconds()) {
  return isNonEmptyString(cachedToken)
    && Number.isFinite(cachedExpiry)
    && cachedExpiry > now + REFRESH_BUFFER_SECONDS;
}

function invalidAuthResponse() {
  return new UpstreamError('OneMap authentication returned an invalid response.', {
    code: 'UPSTREAM_INVALID_SHAPE',
    service: 'OneMap authentication',
  });
}

async function refreshToken(email, password, generation) {
  const { data } = await fetchJson(
    AUTH_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    {
      service: 'OneMap authentication',
      validate: isTokenPayload,
    },
  );

  const expiry = expiryTimestamp(data.expiry_timestamp);
  if (expiry === null) throw invalidAuthResponse();

  if (generation !== stateGeneration) return data.access_token;
  cachedToken = data.access_token;
  cachedExpiry = expiry;
  return cachedToken;
}

function startRefresh(email, password) {
  if (inFlightRefresh) return inFlightRefresh;

  const refresh = refreshToken(email, password, stateGeneration);
  inFlightRefresh = refresh;
  refresh.then(
    () => {
      if (inFlightRefresh === refresh) inFlightRefresh = null;
    },
    () => {
      if (inFlightRefresh === refresh) inFlightRefresh = null;
    },
  );
  return refresh;
}

function abortError(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error('OneMap authentication request was aborted.');
  error.name = 'AbortError';
  return error;
}

function waitForRefresh(refresh, signal) {
  if (!signal) return refresh;
  if (signal.aborted) return Promise.reject(abortError(signal));

  // A caller's signal cancels only that caller's wait; the shared auth fetch
  // intentionally has no caller signal so one abort cannot cancel other callers.
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);

    signal.addEventListener('abort', onAbort, { once: true });
    refresh.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function resetState() {
  stateGeneration += 1;
  cachedToken = null;
  cachedExpiry = 0;
  inFlightRefresh = null;
}

function invalidateCachedToken(token) {
  if (cachedToken !== token) return;
  cachedToken = null;
  cachedExpiry = 0;
}

async function withOneMapToken(operation, { signal } = {}) {
  const credentialAuthConfigured = credentials().configured;
  const token = await getOneMapToken({ signal });
  try {
    return await operation(token);
  } catch (error) {
    if (error?.status !== 401 || !credentialAuthConfigured || !credentials().configured) throw error;
    invalidateCachedToken(token);
    const refreshedToken = await getOneMapToken({ signal });
    return operation(refreshedToken);
  }
}

async function getOneMapToken({ signal } = {}) {
  if (signal?.aborted) throw abortError(signal);

  const { email, password, configured } = credentials();
  if (!configured) {
    const token = directToken();
    if (token) return token;

    const error = new Error('OneMap routing is not configured.');
    error.code = 'ONEMAP_NOT_CONFIGURED';
    throw error;
  }

  if (cachedTokenIsUsable()) return cachedToken;
  return waitForRefresh(startRefresh(email, password), signal);
}

module.exports = {
  getOneMapToken,
  withOneMapToken,
  isTokenPayload,
  _test: { resetState },
};
