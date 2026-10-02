(() => {
  'use strict';

  const SPX_ORIGIN = 'https://spx.shopee.com.br';
  const RECEIVE_HASH = /^#\/generalReceiveTaskOps\/singleReceiveNew(?:\/|$)/;
  const MESSAGE_SOURCE = 'SPX_TOOLKIT_AWB_PRINT';
  const REASON_TRANSLATIONS = {
    'wrongly assigned': 'Fora de Rota'
  };
  const decisionCache = new Map();
  const pendingLookups = new Map();
  const handledPrintRequests = new Set();
  const CACHE_TTL_MS = 1500;

  function syncNetworkGuard() {
    chrome.runtime.sendMessage({
      type: 'SPX_SYNC_AWB_NETWORK_GUARD',
      url: location.href
    }).catch(() => {});
  }

  function isReceivePage() {
    return location.origin === SPX_ORIGIN && RECEIVE_HASH.test(location.hash);
  }

  function normalizeReason(reason) {
    return String(reason || '')
      .replace(/^\s*\[[^\]]+\]\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeRuleText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function translateReason(reason) {
    const clean = normalizeReason(reason);
    return REASON_TRANSLATIONS[clean.toLowerCase()] || clean || '-';
  }

  function getLatestAttempt(attempts) {
    return attempts
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const timeDiff = Number(a.item?.ctime || 0) - Number(b.item?.ctime || 0);
        return timeDiff || a.index - b.index;
      })
      .at(-1)?.item;
  }

  async function fetchLatestReasonDecision(shipmentId) {
    const url = `https://spx.shopee.com.br/api/fleet_order/order/detail/recipient_info?shipment_id=${encodeURIComponent(shipmentId)}&station_type=3`;
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*'
      }
    });
    const data = await response.json();

    if (!response.ok || data.retcode !== 0) {
      throw new Error(data.message || `HTTP ${response.status}`);
    }

    const attempts = Array.isArray(data?.data?.recipient?.On_Hold)
      ? data.data.recipient.On_Hold
      : [];
    const latestAttempt = getLatestAttempt(attempts);
    const latestReason = normalizeRuleText(
      translateReason(latestAttempt?.on_hold_reason__desc)
    );

    return latestReason === 'fora de rota';
  }

  function resolveDecision(shipmentId) {
    const cleanShipmentId = String(shipmentId || '').trim();
    if (!cleanShipmentId || !isReceivePage()) return Promise.resolve(false);

    const cached = decisionCache.get(cleanShipmentId);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      return Promise.resolve(cached.blockAndPrint);
    }

    if (pendingLookups.has(cleanShipmentId)) {
      return pendingLookups.get(cleanShipmentId);
    }

    const lookup = fetchLatestReasonDecision(cleanShipmentId)
      .then(blockAndPrint => {
        decisionCache.set(cleanShipmentId, {
          blockAndPrint,
          createdAt: Date.now()
        });
        return blockAndPrint;
      })
      .catch(error => {
        console.warn('SPX Toolkit impressão Fora de Rota:', error);
        return false;
      })
      .finally(() => {
        pendingLookups.delete(cleanShipmentId);
      });

    pendingLookups.set(cleanShipmentId, lookup);
    return lookup;
  }

  function showPrintStatus(message, isError = false) {
    const id = 'spx-out-of-route-print-status';
    let status = document.getElementById(id);

    if (!status) {
      status = document.createElement('div');
      status.id = id;
      Object.assign(status.style, {
        position: 'fixed',
        left: '50%',
        bottom: '22px',
        transform: 'translateX(-50%)',
        zIndex: '2147483647',
        borderRadius: '10px',
        padding: '11px 16px',
        color: '#fff',
        font: '700 13px/1.3 Arial, sans-serif',
        boxShadow: '0 12px 30px rgba(15, 23, 42, .35)'
      });
      document.documentElement.appendChild(status);
    }

    status.style.background = isError ? '#b91c1c' : '#0f766e';
    status.textContent = message;
    status.hidden = false;
    window.clearTimeout(showPrintStatus.hideTimer);
    showPrintStatus.hideTimer = window.setTimeout(() => {
      status.hidden = true;
    }, isError ? 6000 : 3500);
  }

  function ensureAutoAddToastStyle() {
    const styleId = 'spx-awb-autoadd-toast-style';
    if (
      document.getElementById(styleId) ||
      document.getElementById('spx-auto-hint-style')
    ) {
      return;
    }

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      #spx-autoadd-toast {
        position: fixed;
        right: 20px;
        bottom: 22px;
        z-index: 999999;
        display: flex;
        align-items: center;
        gap: 9px;
        max-width: min(420px, calc(100vw - 32px));
        padding: 12px 14px;
        border-radius: 14px;
        background: #0f172a;
        color: #fef3c7;
        border: 1px solid rgba(245, 158, 11, 0.42);
        border-left: 4px solid #f59e0b;
        box-shadow: 0 20px 48px rgba(0, 0, 0, 0.38);
        font: 900 13px/1.45 Arial, sans-serif;
        pointer-events: none;
        animation: spxAwbAutoAddToastIn 260ms ease-out forwards;
      }
      #spx-autoadd-toast .spx-autoadd-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        width: 22px;
        height: 22px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.1);
      }
      #spx-autoadd-toast .spx-autoadd-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      @keyframes spxAwbAutoAddToastIn {
        from { transform: translateX(calc(100% + 32px)); opacity: 0.2; }
        to { transform: translateX(0); opacity: 1; }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function showAutoAddBlockedToast(shipmentId) {
    const root = document.documentElement;
    if (!root) return;

    root.setAttribute(
      'data-spx-autoadd-blocked-shipment',
      String(shipmentId || '').trim()
    );
    ensureAutoAddToastStyle();
    document.getElementById('spx-autoadd-toast')?.remove();

    const toast = document.createElement('div');
    toast.id = 'spx-autoadd-toast';
    toast.className = 'spx-autoadd-next-cycle';
    toast.innerHTML = `
      <span class="spx-autoadd-icon">!</span>
      <span class="spx-autoadd-text">AutoAdd bloqueado por ser Fora de Rota</span>
    `;
    (document.body || root).appendChild(toast);
  }

  async function requestCustomPrint(requestId, shipmentId) {
    if (handledPrintRequests.has(requestId)) return;
    handledPrintRequests.add(requestId);
    if (handledPrintRequests.size > 100) handledPrintRequests.clear();

    showAutoAddBlockedToast(shipmentId);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SPX_PRINT_OUT_OF_ROUTE_LABEL',
        requestId,
        shipmentId
      });

      if (!response?.ok) {
        throw new Error(response?.error || 'Não foi possível imprimir a etiqueta.');
      }
    } catch (error) {
      showPrintStatus(String(error?.message || error), true);
    }
  }

  window.addEventListener('message', event => {
    if (
      event.source !== window ||
      event.origin !== SPX_ORIGIN ||
      event.data?.source !== MESSAGE_SOURCE
    ) {
      return;
    }

    if (event.data.type === 'CHECK_LATEST_REASON') {
      const { requestId, shipmentId } = event.data;
      resolveDecision(shipmentId).then(blockAndPrint => {
        window.postMessage({
          source: MESSAGE_SOURCE,
          type: 'LATEST_REASON_DECISION',
          requestId,
          shipmentId,
          blockAndPrint
        }, SPX_ORIGIN);
      });
      return;
    }

    if (event.data.type === 'PRINT_OUT_OF_ROUTE_LABEL') {
      requestCustomPrint(event.data.requestId, event.data.shipmentId);
    }
  });

  window.addEventListener('hashchange', syncNetworkGuard);
  syncNetworkGuard();
})();
