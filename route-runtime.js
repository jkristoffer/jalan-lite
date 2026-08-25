(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JalanRuntime = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function routeItineraries(value) {
    return value?.plan?.itineraries || value?.data?.plan?.itineraries;
  }

  function isRoutePayload(value) {
    return Array.isArray(routeItineraries(value));
  }

  function isBusArrivalsPayload(value) {
    return isObject(value)
      && typeof value.stopCode === 'string'
      && Array.isArray(value.services)
      && value.services.every((service) => isObject(service)
        && typeof service.serviceNo === 'string'
        && Array.isArray(service.arrivals));
  }

  function isTrainRealtimePayload(value) {
    return isObject(value) && Array.isArray(value.updates) && Array.isArray(value.alerts);
  }

  function isNearbyStopsPayload(value) {
    return isObject(value) && Array.isArray(value.nearby);
  }

  function isMapConfigPayload(value) {
    return isObject(value) && typeof value.token === 'string' && value.token.startsWith('pk.');
  }

  function isPushConfigPayload(value) {
    return isObject(value) && typeof value.publicKey === 'string' && value.publicKey.trim().length > 0;
  }

  async function readJson(response, message = 'The service returned an invalid response.') {
    try {
      return await response.json();
    } catch {
      throw new Error(message);
    }
  }

  function createRequestCoordinator() {
    let active = null;
    let sequence = 0;

    function start() {
      if (active) active.controller.abort();
      const controller = typeof AbortController === 'function'
        ? new AbortController()
        : { signal: undefined, abort() {} };
      const request = { id: ++sequence, controller };
      active = request;
      return request;
    }

    function isCurrent(request) {
      return active === request && !request.controller.signal?.aborted;
    }

    function finish(request) {
      if (active === request) active = null;
    }

    function abort() {
      if (!active) return;
      active.controller.abort();
      active = null;
    }

    function hasActive() {
      return Boolean(active);
    }

    return { start, isCurrent, finish, abort, hasActive };
  }

  return {
    isRoutePayload,
    isBusArrivalsPayload,
    isTrainRealtimePayload,
    isNearbyStopsPayload,
    isMapConfigPayload,
    isPushConfigPayload,
    readJson,
    createRequestCoordinator,
  };
}));
