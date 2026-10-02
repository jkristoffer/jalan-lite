const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('./_onemap-auth');
const location = require('./location');
const route = require('./route');
const realtimeRoute = require('./realtime-route');

const ENV_KEYS = [
  'ONEMAP_ACCESS_TOKEN',
  'ONEMAP_TOKEN',
  'ONEMAP_EMAIL',
  'ONEMAP_PASSWORD',
  'ONEMAP_EMAIL_PASSWORD',
];
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = global.fetch;
const originalDateNow = Date.now;
const BASE_SECONDS = 1_800_000_000;

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

function clearOneMapEnv() {
  ENV_KEYS.forEach((key) => delete process.env[key]);
}

function setCredentials() {
  process.env.ONEMAP_EMAIL = 'planner@example.test';
  process.env.ONEMAP_PASSWORD = 'test-password';
}

function setNow(seconds) {
  Date.now = () => seconds * 1000;
}

function restoreEnv() {
  ENV_KEYS.forEach((key) => {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
}

function captureResponse() {
  const result = {};
  return {
    result,
    response: {
      setHeader() {},
      status(code) {
        result.status = code;
        return this;
      },
      json(body) {
        result.body = body;
        return body;
      },
    },
  };
}

test.beforeEach(() => {
  auth._test.resetState();
  clearOneMapEnv();
  global.fetch = originalFetch;
  Date.now = originalDateNow;
});

test.afterEach(() => {
  auth._test.resetState();
  restoreEnv();
  global.fetch = originalFetch;
  Date.now = originalDateNow;
});

test('prefers credential exchange when a direct token is also configured', async () => {
  setCredentials();
  process.env.ONEMAP_ACCESS_TOKEN = 'legacy-token';
  setNow(BASE_SECONDS);
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return jsonResponse({ access_token: 'dynamic-token', expiry_timestamp: BASE_SECONDS + 86400 });
  };

  assert.equal(await auth.getOneMapToken(), 'dynamic-token');
  assert.equal(request.url, 'https://www.onemap.gov.sg/api/auth/post/getToken');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {
    email: 'planner@example.test',
    password: 'test-password',
  });
});

test('reuses a cached token while it has more than five minutes remaining', async () => {
  setCredentials();
  setNow(BASE_SECONDS);
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({ access_token: 'cached-token', expiry_timestamp: BASE_SECONDS + 3600 });
  };

  assert.equal(await auth.getOneMapToken(), 'cached-token');
  setNow(BASE_SECONDS + 120);
  assert.equal(await auth.getOneMapToken(), 'cached-token');
  assert.equal(calls, 1);
});

test('refreshes a cached token at the five-minute boundary', async () => {
  setCredentials();
  setNow(BASE_SECONDS);
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({
      access_token: calls === 1 ? 'first-token' : 'refreshed-token',
      expiry_timestamp: calls === 1 ? BASE_SECONDS + 600 : BASE_SECONDS + 7200,
    });
  };

  assert.equal(await auth.getOneMapToken(), 'first-token');
  setNow(BASE_SECONDS + 300);
  assert.equal(await auth.getOneMapToken(), 'refreshed-token');
  assert.equal(calls, 2);
});

test('coalesces concurrent authentication requests', async () => {
  setCredentials();
  setNow(BASE_SECONDS);
  let calls = 0;
  let release;
  global.fetch = () => {
    calls += 1;
    return new Promise((resolve) => {
      release = () => resolve(jsonResponse({
        access_token: 'shared-token',
        expiry_timestamp: BASE_SECONDS + 3600,
      }));
    });
  };

  const first = auth.getOneMapToken();
  const second = auth.getOneMapToken();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['shared-token', 'shared-token']);
});

test('does not let one caller abort a shared authentication request', async () => {
  setCredentials();
  setNow(BASE_SECONDS);
  const controller = new AbortController();
  let requestSignal;
  let release;
  global.fetch = (_url, options) => {
    requestSignal = options.signal;
    return new Promise((resolve) => {
      release = () => resolve(jsonResponse({
        access_token: 'surviving-token',
        expiry_timestamp: BASE_SECONDS + 3600,
      }));
    });
  };

  const aborted = auth.getOneMapToken({ signal: controller.signal });
  const surviving = auth.getOneMapToken();
  controller.abort();
  await assert.rejects(aborted, (error) => error.name === 'AbortError');
  assert.notEqual(requestSignal, controller.signal);
  release();
  assert.equal(await surviving, 'surviving-token');
});

test('rejects an authentication response with a malformed expiry', async () => {
  setCredentials();
  setNow(BASE_SECONDS);
  global.fetch = async () => jsonResponse({
    access_token: 'token-without-valid-expiry',
    expiry_timestamp: 'not-a-unix-timestamp',
  });

  await assert.rejects(
    auth.getOneMapToken(),
    (error) => error.code === 'UPSTREAM_INVALID_SHAPE'
      && error.service === 'OneMap authentication',
  );
});

test('clears a failed refresh so a later call retries authentication', async () => {
  setCredentials();
  setNow(BASE_SECONDS);
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: 'temporarily unavailable' }, 503);
    return jsonResponse({ access_token: 'retry-token', expiry_timestamp: BASE_SECONDS + 3600 });
  };

  await assert.rejects(auth.getOneMapToken(), (error) => error.code === 'UPSTREAM_HTTP');
  assert.equal(await auth.getOneMapToken(), 'retry-token');
  assert.equal(calls, 2);
});

test('refreshes once and retries an operation after a credential-backed 401', async () => {
  setCredentials();
  setNow(BASE_SECONDS);
  let authenticationCalls = 0;
  const operationTokens = [];
  global.fetch = async () => {
    authenticationCalls += 1;
    return jsonResponse({
      access_token: authenticationCalls === 1 ? 'stale-token' : 'fresh-token',
      expiry_timestamp: BASE_SECONDS + 3600,
    });
  };

  const result = await auth.withOneMapToken(async (token) => {
    operationTokens.push(token);
    if (operationTokens.length === 1) {
      const error = new Error('unauthorized');
      error.status = 401;
      throw error;
    }
    return 'operation-result';
  });

  assert.equal(result, 'operation-result');
  assert.deepEqual(operationTokens, ['stale-token', 'fresh-token']);
  assert.equal(authenticationCalls, 2);
});

test('does not clear a newer token when concurrent operations reject the stale token', async () => {
  setCredentials();
  setNow(BASE_SECONDS);
  let authenticationCalls = 0;
  let releaseRefresh;
  global.fetch = async () => {
    authenticationCalls += 1;
    if (authenticationCalls === 2) {
      return new Promise((resolve) => {
        releaseRefresh = () => resolve(jsonResponse({
          access_token: 'fresh-token',
          expiry_timestamp: BASE_SECONDS + 3600,
        }));
      });
    }
    return jsonResponse({ access_token: 'stale-token', expiry_timestamp: BASE_SECONDS + 3600 });
  };

  const staleRejectors = [];
  const operation = (token) => {
    if (token === 'stale-token') {
      return new Promise((_resolve, reject) => staleRejectors.push(reject));
    }
    return 'fresh-result';
  };
  const first = auth.withOneMapToken(operation);
  const second = auth.withOneMapToken(operation);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleRejectors.length, 2);

  const unauthorized = new Error('unauthorized');
  unauthorized.status = 401;
  staleRejectors[0](unauthorized);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authenticationCalls, 2);
  releaseRefresh();
  staleRejectors[1](unauthorized);

  assert.deepEqual(await Promise.all([first, second]), ['fresh-result', 'fresh-result']);
  assert.equal(await auth.getOneMapToken(), 'fresh-token');
  assert.equal(authenticationCalls, 2);
});

test('does not retry an operation for a non-401 error', async () => {
  setCredentials();
  setNow(BASE_SECONDS);
  let authenticationCalls = 0;
  let operationCalls = 0;
  global.fetch = async () => {
    authenticationCalls += 1;
    return jsonResponse({ access_token: 'cached-token', expiry_timestamp: BASE_SECONDS + 3600 });
  };

  await assert.rejects(
    auth.withOneMapToken(async () => {
      operationCalls += 1;
      const error = new Error('upstream failure');
      error.status = 503;
      throw error;
    }),
    (error) => error.status === 503,
  );
  assert.equal(operationCalls, 1);
  assert.equal(authenticationCalls, 1);
});

test('does not retry a direct-token operation after a 401', async () => {
  process.env.ONEMAP_TOKEN = 'fallback-token';
  let operationCalls = 0;
  let authenticationCalls = 0;
  global.fetch = async () => {
    authenticationCalls += 1;
    return jsonResponse({ access_token: 'unexpected-token', expiry_timestamp: BASE_SECONDS + 3600 });
  };

  await assert.rejects(
    auth.withOneMapToken(async () => {
      operationCalls += 1;
      const error = new Error('unauthorized');
      error.status = 401;
      throw error;
    }),
    (error) => error.status === 401,
  );
  assert.equal(operationCalls, 1);
  assert.equal(authenticationCalls, 0);
});

test('wires location search through credential refresh and one retry', async () => {
  setCredentials();
  setNow(BASE_SECONDS);
  let authenticationCalls = 0;
  let searchCalls = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('/auth/post/getToken')) {
      authenticationCalls += 1;
      return jsonResponse({
        access_token: authenticationCalls === 1 ? 'stale-token' : 'fresh-token',
        expiry_timestamp: BASE_SECONDS + 3600,
      });
    }
    searchCalls += 1;
    assert.equal(options.headers.Authorization, searchCalls === 1 ? 'stale-token' : 'fresh-token');
    if (searchCalls === 1) return jsonResponse({ error: 'unauthorized' }, 401);
    return jsonResponse({ results: [{ LATITUDE: '1.3', LONGITUDE: '103.8', SEARCHVAL: 'Test place' }] });
  };
  const captured = captureResponse();

  await location({ query: { q: 'Test place' } }, captured.response);

  assert.equal(captured.result.status, 200);
  assert.deepEqual(captured.result.body.point, { lat: 1.3, lng: 103.8 });
  assert.equal(searchCalls, 2);
  assert.equal(authenticationCalls, 2);
});

test('wires public transit routing through credential refresh and one retry', async () => {
  setCredentials();
  setNow(BASE_SECONDS);
  let authenticationCalls = 0;
  let routingCalls = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('/auth/post/getToken')) {
      authenticationCalls += 1;
      return jsonResponse({
        access_token: authenticationCalls === 1 ? 'stale-token' : 'fresh-token',
        expiry_timestamp: BASE_SECONDS + 3600,
      });
    }
    routingCalls += 1;
    assert.equal(options.headers.Authorization, routingCalls === 1 ? 'stale-token' : 'fresh-token');
    if (routingCalls === 1) return jsonResponse({ error: 'unauthorized' }, 401);
    return jsonResponse({ plan: { itineraries: [{ startTime: 1, endTime: 2, legs: [] }] } });
  };

  const response = await route._test.requestRouteWithAuth({
    start: '1.300000,103.800000',
    end: '1.310000,103.810000',
    date: '08-25-2026',
    time: '08:00:00',
  });

  assert.equal(response.data.plan.itineraries.length, 1);
  assert.equal(routingCalls, 2);
  assert.equal(authenticationCalls, 2);
});

test('wires realtime walking lookups through credential refresh and one retry', async () => {
  setCredentials();
  setNow(BASE_SECONDS);
  let authenticationCalls = 0;
  let walkingCalls = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('/auth/post/getToken')) {
      authenticationCalls += 1;
      return jsonResponse({
        access_token: authenticationCalls === 1 ? 'stale-token' : 'fresh-token',
        expiry_timestamp: BASE_SECONDS + 3600,
      });
    }
    walkingCalls += 1;
    if (options.headers.Authorization === 'stale-token') return jsonResponse({ error: 'unauthorized' }, 401);
    return jsonResponse({
      status: 0,
      status_message: 'Found route between points',
      route_summary: { total_distance: 300, total_time: 240 },
      route_instructions: [],
    });
  };
  const candidate = {
    board: { stopCode: 'A', lat: 1.3, lng: 103.8, distanceMetres: 100 },
    alight: { stopCode: 'B', lat: 1.31, lng: 103.81, distanceMetres: 200 },
  };

  const result = await realtimeRoute._test.attachWalkingDistances(
    [candidate],
    { lat: 1.3, lng: 103.8 },
    { lat: 1.31, lng: 103.81 },
  );

  assert.deepEqual(result, { status: 'ready', checked: 2, failed: 0 });
  assert.equal(walkingCalls, 4);
  assert.equal(authenticationCalls, 2);
});

test('uses a direct token when credential configuration is incomplete', async () => {
  process.env.ONEMAP_TOKEN = 'fallback-token';
  global.fetch = async () => {
    throw new Error('authentication should not be requested');
  };

  assert.equal(await auth.getOneMapToken(), 'fallback-token');
});

test('reports OneMap as not configured when no auth option is available', async () => {
  global.fetch = async () => {
    throw new Error('authentication should not be requested');
  };

  await assert.rejects(
    auth.getOneMapToken(),
    (error) => error.code === 'ONEMAP_NOT_CONFIGURED',
  );
});
