
const DEFAULT_TIMEOUT_MS = 8000;

class UpstreamError extends Error {
  constructor(message, { code = 'UPSTREAM_FAILURE', status = 502, service = 'upstream', cause } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
    this.service = service;
    if (cause) this.cause = cause;
  }
}

function timeoutValue(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0
    ? Number(value)
    : DEFAULT_TIMEOUT_MS;
}

function createTimeoutSignal(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutValue(timeoutMs));
  timer.unref?.();

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cancel: () => clearTimeout(timer),
  };
}

async function fetchWithTimeout(url, options = {}, { service = 'upstream', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const parentSignal = options.signal;
  let onParentAbort;

  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason);
  } else if (parentSignal) {
    onParentAbort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), timeoutValue(timeoutMs));
  timer.unref?.();

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (parentSignal?.aborted) throw error;
    if (controller.signal.aborted) {
      throw new UpstreamError(service + ' request timed out.', {
        code: 'UPSTREAM_TIMEOUT',
        service,
        cause: error,
      });
    }
    throw new UpstreamError(service + ' request failed.', {
      code: 'UPSTREAM_NETWORK',
      service,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    if (parentSignal && onParentAbort) parentSignal.removeEventListener('abort', onParentAbort);
  }
}

async function readJson(response, service) {
  try {
    return await response.json();
  } catch (error) {
    throw new UpstreamError(service + ' returned malformed JSON.', {
      code: 'UPSTREAM_INVALID_JSON',
      service,
      cause: error,
    });
  }
}

async function fetchJson(url, options = {}, {
  service = 'upstream',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowStatuses = [],
  validate,
} = {}) {
  const response = await fetchWithTimeout(url, options, { service, timeoutMs });
  const allowed = new Set(allowStatuses);

  if (!response.ok && !allowed.has(response.status)) {
    throw new UpstreamError(service + ' returned HTTP ' + response.status + '.', {
      code: 'UPSTREAM_HTTP',
      status: response.status,
      service,
    });
  }

  const data = await readJson(response, service);
  if (response.ok && validate && !validate(data)) {
    throw new UpstreamError(service + ' returned an invalid response.', {
      code: 'UPSTREAM_INVALID_SHAPE',
      service,
    });
  }

  return { response, data };
}

async function fetchBytes(url, options = {}, {
  service = 'upstream',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  validate,
} = {}) {
  const response = await fetchWithTimeout(url, options, { service, timeoutMs });
  if (!response.ok) {
    throw new UpstreamError(service + ' returned HTTP ' + response.status + '.', {
      code: 'UPSTREAM_HTTP',
      status: response.status,
      service,
    });
  }

  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new UpstreamError(service + ' returned an unreadable response.', {
      code: 'UPSTREAM_INVALID_BODY',
      service,
      cause: error,
    });
  }

  if (!bytes.length || (validate && !validate(bytes))) {
    throw new UpstreamError(service + ' returned an invalid response.', {
      code: 'UPSTREAM_INVALID_SHAPE',
      service,
    });
  }

  return { response, bytes };
}

function safeUpstreamFailure(error) {
  if (!error) return;
  const service = error.service || 'upstream';
  const code = error.code || 'UPSTREAM_FAILURE';
  const status = Number.isInteger(error.status) ? ' ' + error.status : '';
  console.warn('[jalan-upstream]', service, code + status);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  UpstreamError,
  createTimeoutSignal,
  fetchWithTimeout,
  fetchJson,
  fetchBytes,
  safeUpstreamFailure,
};
