
const { fetchJson } = require('./_upstream');

let cachedToken = null;
let cachedExpiry = 0;

function isTokenPayload(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.access_token === 'string'
    && value.access_token.trim().length > 0;
}

async function getOneMapToken({ signal } = {}) {
  const directToken = process.env.ONEMAP_ACCESS_TOKEN || process.env.ONEMAP_TOKEN;
  if (directToken) return directToken;

  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedExpiry > now + 300) return cachedToken;

  const email = process.env.ONEMAP_EMAIL;
  const password = process.env.ONEMAP_PASSWORD || process.env.ONEMAP_EMAIL_PASSWORD;
  if (!email || !password) {
    const error = new Error('OneMap routing is not configured.');
    error.code = 'ONEMAP_NOT_CONFIGURED';
    throw error;
  }

  const { data } = await fetchJson(
    'https://www.onemap.gov.sg/api/auth/post/getToken',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal,
    },
    {
      service: 'OneMap authentication',
      validate: isTokenPayload,
    },
  );

  cachedToken = data.access_token;
  cachedExpiry = Number(data.expiry_timestamp);
  if (!Number.isFinite(cachedExpiry)) cachedExpiry = now + 3600;
  return cachedToken;
}

module.exports = { getOneMapToken, isTokenPayload };
