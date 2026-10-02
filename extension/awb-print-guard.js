(() => {
  'use strict';

  const SPX_ORIGIN = 'https://spx.shopee.com.br';
  const RECEIVE_HASH = /^#\/generalReceiveTaskOps\/singleReceiveNew(?:\/|$)/;
  const PRINT_PATH = '/spx_delivery/admin/delivery/inbound_print_route_awb';
  const REPLAY_PARAM = 'spx_toolkit_awb_replay';
  const MESSAGE_SOURCE = 'SPX_TOOLKIT_AWB_PRINT';
  const DECISION_TIMEOUT_MS = 3000;
  const DECISION_RETRY_MS = 150;
  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const originalXhrAbort = XMLHttpRequest.prototype.abort;
  const pendingDecisions = new Map();
  const xhrRequests = new WeakMap();

  function isReceivePage() {
    return location.origin === SPX_ORIGIN && RECEIVE_HASH.test(location.hash);
  }

  async function readRequest(input, init) {
    try {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url || String(input), location.href);
      const method = String(init?.method || request?.method || 'GET').toUpperCase();
      let body = init?.body;

      if (body == null && request) {
        try {
          body = await request.clone().text();
        } catch (_) {}
      }

      return { url, method, body };
    } catch (_) {
      return null;
    }
  }

  function readShipmentId(body) {
    try {
      if (typeof body === 'string') {
        return String(JSON.parse(body)?.shipment_id || '').trim();
      }
      if (body instanceof URLSearchParams || body instanceof FormData) {
        return String(body.get('shipment_id') || '').trim();
      }
      if (body && typeof body === 'object' && 'shipment_id' in body) {
        return String(body.shipment_id || '').trim();
      }
    } catch (_) {}

    return '';
  }

  function isPrintRequest(url, method) {
    return Boolean(
      isReceivePage() &&
      String(method || 'GET').toUpperCase() === 'POST' &&
      url?.origin === SPX_ORIGIN &&
      url?.pathname === PRINT_PATH &&
      !url.searchParams.has(REPLAY_PARAM)
    );
  }

  function addReplayMarker(rawUrl) {
    const url = new URL(rawUrl, location.href);
    url.searchParams.set(REPLAY_PARAM, '1');
    return url.href;
  }

  function buildReplayFetchArgs(args, request) {
    const replayUrl = addReplayMarker(request.url.href);

    if (args[0] instanceof Request) {
      return [new Request(replayUrl, args[0]), args[1]];
    }

    return [replayUrl, args[1]];
  }

  function requestCustomPrint(shipmentId) {
    window.postMessage({
      source: MESSAGE_SOURCE,
      type: 'PRINT_OUT_OF_ROUTE_LABEL',
      requestId: crypto.randomUUID(),
      shipmentId
    }, SPX_ORIGIN);
  }

  function postDecisionRequest(requestId, shipmentId) {
    window.postMessage({
      source: MESSAGE_SOURCE,
      type: 'CHECK_LATEST_REASON',
      requestId,
      shipmentId
    }, SPX_ORIGIN);
  }

  function requestDecision(shipmentId) {
    return new Promise(resolve => {
      const requestId = crypto.randomUUID();
      const startedAt = Date.now();

      const finish = blockAndPrint => {
        const pending = pendingDecisions.get(requestId);
        if (!pending) return;
        window.clearInterval(pending.retryTimer);
        window.clearTimeout(pending.timeoutTimer);
        pendingDecisions.delete(requestId);
        resolve(Boolean(blockAndPrint));
      };

      const retryTimer = window.setInterval(() => {
        if (Date.now() - startedAt < DECISION_TIMEOUT_MS) {
          postDecisionRequest(requestId, shipmentId);
        }
      }, DECISION_RETRY_MS);
      const timeoutTimer = window.setTimeout(() => finish(false), DECISION_TIMEOUT_MS);

      pendingDecisions.set(requestId, { finish, retryTimer, timeoutTimer });
      postDecisionRequest(requestId, shipmentId);
    });
  }

  window.addEventListener('message', event => {
    if (
      event.source !== window ||
      event.origin !== SPX_ORIGIN ||
      event.data?.source !== MESSAGE_SOURCE ||
      event.data?.type !== 'LATEST_REASON_DECISION'
    ) {
      return;
    }

    pendingDecisions.get(event.data.requestId)?.finish(event.data.blockAndPrint);
  });

  window.fetch = async function (...args) {
    const request = await readRequest(args[0], args[1]);

    if (!request || !isPrintRequest(request.url, request.method)) {
      return originalFetch.apply(this, args);
    }

    const shipmentId = readShipmentId(request.body);
    const blockAndPrint = await requestDecision(shipmentId);

    if (!blockAndPrint) {
      return originalFetch.apply(this, buildReplayFetchArgs(args, request));
    }

    requestCustomPrint(shipmentId);

    throw new DOMException(
      'A impressão AWB original foi substituída pela etiqueta de pedido fora de rota.',
      'AbortError'
    );
  };

  XMLHttpRequest.prototype.open = function (method, rawUrl, ...rest) {
    let url;
    try {
      url = new URL(String(rawUrl), location.href);
    } catch (_) {
      xhrRequests.delete(this);
      return originalXhrOpen.call(this, method, rawUrl, ...rest);
    }

    if (!isPrintRequest(url, method)) {
      xhrRequests.delete(this);
      return originalXhrOpen.call(this, method, rawUrl, ...rest);
    }

    xhrRequests.set(this, {
      method: String(method || 'GET').toUpperCase(),
      originalUrl: url.href,
      cancelled: false
    });
    return originalXhrOpen.call(this, method, addReplayMarker(url.href), ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    const state = xhrRequests.get(xhr);
    if (!state) return originalXhrSend.call(xhr, body);

    const shipmentId = readShipmentId(body);

    requestDecision(shipmentId).then(blockAndPrint => {
      if (state.cancelled) return;

      if (!blockAndPrint) {
        try {
          originalXhrSend.call(xhr, body);
        } catch (error) {
          console.warn('SPX Toolkit liberação da impressão AWB:', error);
        }
        return;
      }

      requestCustomPrint(shipmentId);
      try {
        originalXhrAbort.call(xhr);
        queueMicrotask(() => {
          xhr.dispatchEvent(new ProgressEvent('abort'));
          xhr.dispatchEvent(new ProgressEvent('loadend'));
        });
      } catch (_) {}
    });
  };

  XMLHttpRequest.prototype.abort = function () {
    const state = xhrRequests.get(this);
    if (state) state.cancelled = true;
    return originalXhrAbort.call(this);
  };
})();
