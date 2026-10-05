const AUTOADD_BLOCK_STORAGE_KEY = 'spxToolkitAutoAddBlocked';
const AUTOADD_PRINT_ENDPOINT_FILTER =
  '|https://spx.shopee.com.br/spx_delivery/admin/delivery/inbound_print_route_awb|';
const AUTOADD_RECEIVE_HASH = /^#\/generalReceiveTaskOps\/singleReceiveNew(?:\/|$)/;
const AUTOADD_RULE_ID_OFFSET = 1000000;
let autoAddBlocked = false;

const autoAddStateReady = chrome.storage.session.get({
  [AUTOADD_BLOCK_STORAGE_KEY]: false
}).then(settings => {
  autoAddBlocked = settings[AUTOADD_BLOCK_STORAGE_KEY] === true;
});

function getAutoAddRuleId(tabId) {
  return AUTOADD_RULE_ID_OFFSET + Number(tabId || 0);
}

function isAutoAddReceivePage(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.origin === 'https://spx.shopee.com.br' &&
      AUTOADD_RECEIVE_HASH.test(url.hash)
    );
  } catch (_) {
    return false;
  }
}

async function syncAutoAddRule(tabId, rawUrl) {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  await autoAddStateReady;

  const ruleId = getAutoAddRuleId(tabId);
  const shouldBlock = autoAddBlocked && isAutoAddReceivePage(rawUrl);
  const update = {
    removeRuleIds: [ruleId]
  };

  if (shouldBlock) {
    update.addRules = [{
      id: ruleId,
      priority: 1,
      action: { type: 'block' },
      condition: {
        urlFilter: AUTOADD_PRINT_ENDPOINT_FILTER,
        requestMethods: ['post'],
        resourceTypes: ['xmlhttprequest', 'ping', 'other'],
        tabIds: [tabId]
      }
    }];
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules(update);
  } catch (error) {
    console.warn('SPX Toolkit controle do AutoAdd:', error);
  }
}

async function syncAutoAddOpenTabs() {
  await autoAddStateReady;
  const tabs = await chrome.tabs.query({
    url: 'https://spx.shopee.com.br/*'
  });
  await Promise.all(
    tabs.map(tab => syncAutoAddRule(tab.id, tab.url))
  );
}

async function setAutoAddBlocked(blocked) {
  await autoAddStateReady;
  autoAddBlocked = blocked === true;
  await chrome.storage.session.set({
    [AUTOADD_BLOCK_STORAGE_KEY]: autoAddBlocked
  });
  await syncAutoAddOpenTabs();
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const currentUrl = changeInfo.url || tab.url;

  if (
    changeInfo.status === 'loading' &&
    isAutoAddReceivePage(currentUrl)
  ) {
    setAutoAddBlocked(false).catch(() => {});
    return;
  }

  if (changeInfo.url || changeInfo.status === 'complete') {
    syncAutoAddRule(tabId, currentUrl);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [getAutoAddRuleId(tabId)]
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  setAutoAddBlocked(false).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  setAutoAddBlocked(false).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[AUTOADD_BLOCK_STORAGE_KEY]) return;
  autoAddBlocked = changes[AUTOADD_BLOCK_STORAGE_KEY].newValue === true;
  syncAutoAddOpenTabs().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'SPX_SET_AUTOADD_BLOCKED') return;

  setAutoAddBlocked(message.blocked === true)
    .then(() => sendResponse({ ok: true, blocked: autoAddBlocked }))
    .catch(error => sendResponse({
      ok: false,
      error: String(error?.message || error)
    }));

  return true;
});

syncAutoAddOpenTabs().catch(() => {});

function parseJsonResponse(text, status) {
  const clean = String(text || '').trim();

  if (/^<!doctype html/i.test(clean) || /^<html/i.test(clean)) {
    const titleMatch = clean.match(/<title>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : 'HTML recebido';
    throw new Error(
      `${title}. O Apps Script retornou HTML em vez de JSON. ` +
      `Verifique se o Web App está publicado para o usuário correto e se a conta Google da Shopee está logada.`
    );
  }

  let data;
  try {
    data = JSON.parse(clean);
  } catch (e) {
    throw new Error(clean.slice(0, 500) || `HTTP ${status}`);
  }

  return data;
}

async function requestJson(url, options = {}) {
  const timeoutMs = Math.max(10000, Number(options.timeoutMs || 180000));
  const fetchOptions = { ...options };
  delete fetchOptions.timeoutMs;

  const controller = new AbortController();
  let timer = null;

  try {
    timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      ...fetchOptions,
      signal: controller.signal
    });

    const text = await res.text();
    const data = parseJsonResponse(text, res.status);

    if (!res.ok) {
      throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
    }

    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Tempo limite de ${Math.round(timeoutMs / 1000)}s excedido ao acessar ${url}.`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'SEND_TO_SHEETS' || msg.type === 'GAS_POST_JSON') {
    (async () => {
      try {
        const data = await requestJson(msg.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=utf-8'
          },
          body: JSON.stringify(msg.payload || {})
        });
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();

    return true;
  }

  if (msg.type === 'GAS_GET_JSON') {
    (async () => {
      try {
        const data = await requestJson(msg.url, { method: 'GET' });
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();

    return true;
  }
});

const AVARIAS_ENDPOINT = 'https://script.google.com/a/macros/shopee.com/s/AKfycbxEoPu2cpB498v1BVGIKdxIBwRcGFt2JJX1rkz7eWNOCkKMdPSO06SGnedGh8o7c-mJ/exec';
const AVARIAS_ALARM_NAME = 'spx-toolkit-avarias-auto-run';
const AVARIAS_INTERVAL_MINUTES = 10;
const AVARIAS_MAX_RUNNING_MS = 9 * 60 * 1000;
const AVARIAS_ITEM_AUTO_TEXT = 'o nome do item é preenchido automaticamente...';
const AVARIAS_STATUS_AUTO_TEXT = 'o status é preenchido automaticamente...';
const AVARIAS_STATUS_REFRESH_TEXTS = ['Ticket Submitted', 'Tratativa pendente'];

function normalizeLooseText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normCompareText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function isAvariasRunStale(state) {
  return !!state.running && Number(state.lastRunAt || 0) > 0 && (Date.now() - Number(state.lastRunAt || 0)) > AVARIAS_MAX_RUNNING_MS;
}

function shouldFetchAvariasItemBg(item) {
  const txt = normalizeLooseText(item);
  return !txt || txt === normalizeLooseText(AVARIAS_ITEM_AUTO_TEXT);
}

function shouldRefreshAvariasStatusBg(status) {
  const txt = normalizeLooseText(status);
  return !txt ||
    txt === normalizeLooseText(AVARIAS_STATUS_AUTO_TEXT) ||
    AVARIAS_STATUS_REFRESH_TEXTS.some(target => txt === normalizeLooseText(target));
}

function normalizeAvariasPendingBg(data) {
  const raw = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  const seen = new Set();

  return raw.map(x => {
    const spx_tn = String(x?.spx_tn || x?.spx || x?.SPX_TN || x?.['SPX TN'] || '').trim().toUpperCase();
    const item = x?.item || x?.['ITEM/PRODUTO'] || '';
    const status = x?.status || x?.['STATUS SPX'] || '';
    return {
      spx_tn,
      item,
      status,
      row: x?.row || '',
      fetch_item: shouldFetchAvariasItemBg(item),
      refresh_status: shouldRefreshAvariasStatusBg(status)
    };
  }).filter(x => {
    if (!x.spx_tn) return false;
    if (seen.has(x.spx_tn)) return false;
    seen.add(x.spx_tn);
    return x.fetch_item || x.refresh_status;
  });
}

function avariasSpxAutoRunner(payload) {
  return (async () => {
    const pending = Array.isArray(payload?.pending) ? payload.pending : [];
    const concurrency = Math.max(1, Math.min(2, Number(payload?.concurrency) || 2));

    const API = {
      trackingInfo: id => `https://spx.shopee.com.br/api/fleet_order/order/detail/tracking_info?shipment_id=${encodeURIComponent(id)}`,
      tradeInfo: id => `https://spx.shopee.com.br/api/fleet_order/order/detail/trade_info?shipment_id=${encodeURIComponent(id)}`,
      sensitive: (id, field, extra = '') => `https://spx.shopee.com.br/api/fleet_order/order/detail/show_sensitive_data?shipment_id=${encodeURIComponent(id)}&data_field=${encodeURIComponent(field)}${extra ? '&' + extra : ''}`
    };

    const AVARIAS_STATUS_PRIORIDADE = [
      'Status DAMAGED [Colocar na Gaiola de Salvados - Status Finalizador]',
      'Pedido descartado',
      'Fraude - Offline Resolve',
      'Ticket Submitted'
    ];

    function normalizeText(v) {
      return String(v || '').replace(/\s+/g, ' ').trim();
    }

    function flattenTracking(arr) {
      return (arr || []).reduce((acc, n) => {
        acc.push(n);
        if (Array.isArray(n.children)) acc.push(...flattenTracking(n.children));
        return acc;
      }, []);
    }

    async function runPool(items, maxConcurrency, worker) {
      const list = Array.isArray(items) ? items : [];
      const results = new Array(list.length);
      let cursor = 0;

      async function runner() {
        while (true) {
          const index = cursor++;
          if (index >= list.length) break;
          results[index] = await worker(list[index], index);
        }
      }

      const size = Math.max(1, Math.min(maxConcurrency || 1, list.length || 1));
      await Promise.all(Array.from({ length: size }, () => runner()));
      return results;
    }

    async function getJson(url, options = {}) {
      const res = await fetch(url, {
        credentials: 'include',
        ...options,
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json;charset=UTF-8',
          ...(options.headers || {})
        }
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 260)}`);
      let json;
      try {
        json = JSON.parse(txt);
      } catch (e) {
        throw new Error('JSON inválido: ' + txt.slice(0, 180));
      }
      if (json && json.is_login === false) throw new Error('SPX retornou is_login:false');
      if (typeof json?.retcode !== 'undefined' && json.retcode !== 0) {
        throw new Error(`retcode ${json.retcode}: ${json.message || ''}`);
      }
      return json;
    }

    async function skuName(br) {
      const trade = await getJson(API.tradeInfo(br));
      const sku = trade?.data?.sku_list?.[0]?.id;
      if (!sku) return '';
      const nameJ = await getJson(API.sensitive(br, 'name', `id=${encodeURIComponent(String(sku))}`));
      return String(nameJ?.data?.data_detail || '').trim();
    }

    async function avariasStatus(br) {
      const j = await getJson(API.trackingInfo(br));
      const all = flattenTracking(j?.data?.tracking_list || []);
      const messages = all.map(n => normalizeText(n.message || n.status_text || n.status || '')).filter(Boolean);

      for (const target of AVARIAS_STATUS_PRIORIDADE) {
        if (messages.some(msg => msg === target || msg.includes(target))) {
          return target;
        }
      }

      return 'Tratativa pendente';
    }

    const rows = await runPool(pending, concurrency, async item => {
      const br = String(item?.spx_tn || '').trim().toUpperCase();
      let productName = String(item?.item || '').trim();
      let status = String(item?.status || '').trim();
      const errParts = [];

      if (!br) return ['', '', '', 'SPX TN vazio'];

      if (item?.fetch_item !== false) {
        try {
          productName = await skuName(br);
        } catch (e) {
          productName = '';
          errParts.push('item: ' + e.message);
        }
      }

      if (item?.refresh_status !== false) {
        try {
          status = await avariasStatus(br);
        } catch (e) {
          status = '';
          errParts.push('status: ' + e.message);
        }
      }

      return [br, productName, status, errParts.join(' | ')];
    });

    return { ok: true, rows: rows.filter(Boolean) };
  })();
}

function getAvariasAutoDefaultState() {
  return {
    enabled: true,
    running: false,
    lastRunAt: 0,
    nextRunAt: Date.now() + AVARIAS_INTERVAL_MINUTES * 60 * 1000,
    lastStatus: 'Automação ativa.',
    lastTotal: 0,
    lastUpdated: 0,
    lastErrors: 0
  };
}

async function getAvariasAutoState() {
  const obj = await chrome.storage.local.get(['avariasAuto']);
  return { ...getAvariasAutoDefaultState(), ...(obj.avariasAuto || {}) };
}

async function setAvariasAutoState(patch) {
  const current = await getAvariasAutoState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ avariasAuto: next });
  return next;
}

async function ensureAvariasAlarm() {
  const state = await getAvariasAutoState();
  await chrome.alarms.clear(AVARIAS_ALARM_NAME);
  if (!state.enabled) return;
  const when = Date.now() + AVARIAS_INTERVAL_MINUTES * 60 * 1000;
  await chrome.alarms.create(AVARIAS_ALARM_NAME, { when });
  await setAvariasAutoState({ nextRunAt: when });
}

async function withTimeout(promise, ms, label) {
  let t;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(label || 'Tempo limite excedido.')), ms);
      })
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientChromePortError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('message port closed') ||
    msg.includes('receiving end does not exist') ||
    msg.includes('extension context invalidated') ||
    msg.includes('frame with id') ||
    msg.includes('cannot access contents of url');
}

function normalizeChromeExecutionError(err) {
  const raw = String(err?.message || err || '');
  if (raw.includes('The message port closed before a response was received')) {
    return 'A aba SPX mudou/carregou durante a automação. A próxima execução tentará novamente automaticamente.';
  }
  if (raw.includes('Receiving end does not exist')) {
    return 'A aba SPX ainda não está pronta para receber a automação. Aguarde a página carregar.';
  }
  return raw || 'Falha ao executar automação na aba SPX.';
}

async function executeAvariasRunnerWithRetry(tabId, payload) {
  let lastErr;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const injected = await withTimeout(chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: avariasSpxAutoRunner,
        args: [payload]
      }), AVARIAS_MAX_RUNNING_MS, 'Tempo limite da consulta SPX excedido.');

      const result = injected?.[0]?.result;
      if (!result?.ok) throw new Error(result?.error || 'Falha ao consultar SPX.');
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransientChromePortError(err) || attempt === 3) break;
      await sleep(1200 * attempt);
    }
  }

  throw new Error(normalizeChromeExecutionError(lastErr));
}

async function findReadySpxTabForAvarias() {
  const tabs = await chrome.tabs.query({ url: 'https://spx.shopee.com.br/*' });
  const candidates = tabs
    .filter(t => t?.id && String(t.url || '').startsWith('https://spx.shopee.com.br/'))
    .sort((a, b) => Number(b.active || false) - Number(a.active || false));

  return candidates.find(t => t.status === 'complete') || candidates[0] || null;
}

async function runAvariasAutoFlow(source = 'alarm') {
  let state = await getAvariasAutoState();
  const busyObj = await chrome.storage.local.get(['spxToolkitBusy']);
  const busy = busyObj.spxToolkitBusy || {};

  if (!state.enabled) return { skipped: true, reason: 'Automação desativada.' };

  if (isAvariasRunStale(state)) {
    state = await setAvariasAutoState({
      running: false,
      lastStatus: 'Execução anterior expirou e foi liberada.'
    });
  }

  if (state.running) return { skipped: true, reason: 'Automação já está rodando.' };
  if (busy.running) {
    await setAvariasAutoState({
      lastStatus: `Ignorado: ${busy.scope || 'extensão'} em execução.`,
      nextRunAt: Date.now() + AVARIAS_INTERVAL_MINUTES * 60 * 1000
    });
    return { skipped: true, reason: 'Extensão ocupada.' };
  }

  await setAvariasAutoState({
    running: true,
    lastStatus: 'Buscando pendentes na planilha...',
    lastRunAt: Date.now()
  });

  try {
    const pendingResp = await requestJson(AVARIAS_ENDPOINT, { method: 'GET' });
    if (pendingResp && pendingResp.success === false) throw new Error(pendingResp.error || 'GET retornou falha.');

    const pending = normalizeAvariasPendingBg(pendingResp);
    if (!pending.length) {
      await setAvariasAutoState({
        running: false,
        lastStatus: 'Nenhum SPX TN pendente encontrado.',
        lastTotal: 0,
        lastUpdated: 0,
        lastErrors: 0,
        nextRunAt: Date.now() + AVARIAS_INTERVAL_MINUTES * 60 * 1000
      });
      return { ok: true, total: 0 };
    }

    await setAvariasAutoState({ lastStatus: `Consultando ${pending.length} pedido(s) na SPX...`, lastTotal: pending.length });

    const tab = await findReadySpxTabForAvarias();
    if (!tab?.id) throw new Error('Nenhuma aba SPX encontrada para automação. Abra a SPX logada em uma aba.');

    if (tab.status !== 'complete') {
      throw new Error('A aba SPX ainda está carregando. A próxima execução tentará novamente.');
    }

    const result = await executeAvariasRunnerWithRetry(tab.id, { pending, concurrency: 2 });

    let updated = 0;
    let errors = 0;
    let unchanged = 0;
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const pendingBySpx = new Map(pending.map(x => [String(x.spx_tn || '').trim().toUpperCase(), x]));

    for (const row of rows) {
      const br = String(row[0] || '').trim().toUpperCase();
      const item = String(row[1] || '').trim();
      const status = String(row[2] || '').trim();
      const lookupError = String(row[3] || '').trim();
      const original = pendingBySpx.get(br) || {};

      if (!br || lookupError) {
        errors += 1;
        continue;
      }

      const itemChanged = !!item && original.fetch_item !== false && normCompareText(item) !== normCompareText(original.item);
      const statusChanged = !!status && original.refresh_status !== false && normCompareText(status) !== normCompareText(original.status);

      if (!itemChanged && !statusChanged) {
        unchanged += 1;
        continue;
      }

      const payload = { spx_tn: br };
      if (itemChanged) payload.item = item;
      if (statusChanged) payload.status = status;

      try {
        const postResp = await requestJson(AVARIAS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload)
        });
        if (postResp && postResp.success === false) throw new Error(postResp.error || 'POST retornou falha.');
        updated += 1;
      } catch (e) {
        errors += 1;
      }
    }

    await setAvariasAutoState({
      running: false,
      lastStatus: `Auto concluído • ${updated} atualizado(s) • ${unchanged} sem alteração • ${errors} erro(s).`,
      lastTotal: pending.length,
      lastUpdated: updated,
      lastErrors: errors,
      nextRunAt: Date.now() + AVARIAS_INTERVAL_MINUTES * 60 * 1000
    });

    return { ok: true, total: pending.length, updated, errors };
  } catch (err) {
    await setAvariasAutoState({
      running: false,
      lastStatus: 'Erro no auto: ' + String(err?.message || err),
      lastErrors: Number(state.lastErrors || 0) + 1,
      nextRunAt: Date.now() + AVARIAS_INTERVAL_MINUTES * 60 * 1000
    });
    return { ok: false, error: String(err?.message || err) };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAvariasAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureAvariasAlarm().catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === AVARIAS_ALARM_NAME) {
    runAvariasAutoFlow('alarm').finally(() => ensureAvariasAlarm().catch(() => {}));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'AVARIAS_AUTO_STATUS') {
    (async () => {
      try {
        let state = await getAvariasAutoState();
        if (isAvariasRunStale(state)) {
          state = await setAvariasAutoState({
            running: false,
            lastStatus: 'Execução anterior expirou e foi liberada.',
            nextRunAt: Date.now() + AVARIAS_INTERVAL_MINUTES * 60 * 1000
          });
          await ensureAvariasAlarm();
        }
        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'AVARIAS_AUTO_SET_ENABLED') {
    (async () => {
      try {
        const enabled = !!msg.enabled;
        const patch = { enabled, lastStatus: enabled ? 'Automação ativa.' : 'Automação desativada.' };
        if (enabled) patch.nextRunAt = Date.now() + AVARIAS_INTERVAL_MINUTES * 60 * 1000;
        const state = await setAvariasAutoState(patch);
        await ensureAvariasAlarm();
        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'AVARIAS_AUTO_RUN_NOW') {
    runAvariasAutoFlow('manual-message')
      .finally(() => ensureAvariasAlarm().catch(() => {}));
    sendResponse({ ok: true, data: { started: true } });
    return false;
  }
});


const AUDIT_SYNC_ENDPOINT = 'https://script.google.com/a/macros/shopee.com/s/AKfycbx_aHJdSNOTWvUU65wz43pk3Mtm6L-JAZsf_VI6FDVqFUSgkOewcjEKB_j9PheFw8iI/exec';
const AUDIT_AUTO_ALARM_NAME = 'spx-toolkit-audit-auto-run';
const AUDIT_AUTO_INTERVAL_MINUTES = 10;
const AUDIT_AUTO_MAX_RUNNING_MS = 9 * 60 * 1000;
const AUDIT_AUTO_LOOKBACK_DAYS = 7;

function conferenciaAutoSpxRunner(payload) {
  return (async () => {
    const lookbackDays = Math.max(1, Math.min(30, Number(payload?.lookbackDays) || 7));
    const concurrency = Math.max(1, Math.min(3, Number(payload?.concurrency) || 2));
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - (lookbackDays * 24 * 60 * 60);
    const endSec = nowSec + (2 * 60 * 60);

    const API = {
      taskList: (page, count, start, end) =>
        `https://spx.shopee.com.br/api/in-station/lmhub/audit/task/list?page_no=${page}&count=${count}&validation_start_time=${start}&validation_end_time=${end}`,
      targetList: (page, count, taskId) =>
        `https://spx.shopee.com.br/api/in-station/lmhub/audit/target/list?page_no=${page}&count=${count}&task_id=${encodeURIComponent(taskId)}`
    };

    const taskHeaders = [
      'validation_task_id',
      'station_name',
      'create_time',
      'end_time',
      'total_target_qty',
      'total_initial_parcel_qty',
      'total_final_parcel_qty',
      'validated_target_qty',
      'validated_target_qty_ratio',
      'scanned_parcel_qty',
      'validation_task_operator',
      'task_status'
    ];

    const targetHeaders = [
      'vt_task_id',
      'target_id',
      'binding_entity',
      'initial_qty',
      'final_qty',
      'scanned_parcel_qty',
      'missort_qty',
      'missing_qty',
      'duplicate_qty',
      'validation_start_time',
      'validation_end_time',
      'revalidation_time',
      'validation_operator',
      'revalidation_operator',
      'revalidation_count',
      'need_show_remark',
      'validation_status',
      'audit_target_type',
      'belong'
    ];

    const summaryHeaders = [
      'VT',
      'CRIADA_EM',
      'ENCERRADA_EM',
      'TOTAL_TARGETS',
      'VALIDADOS',
      'EM_PROGRESSO',
      'NAO_INICIADOS',
      'TARGETS_BAIXADOS',
      'TASK_STATUS',
      'RETORNO'
    ];

    function formatEpochSec(sec) {
      const n = Number(sec || 0);
      if (!n) return '';
      const d = new Date(n * 1000);
      if (Number.isNaN(d.getTime())) return '';
      const pad = v => String(v).padStart(2, '0');
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    async function getJson(url, options = {}) {
      const res = await fetch(url, {
        credentials: 'include',
        ...options,
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json;charset=UTF-8',
          ...(options.headers || {})
        }
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 260)}`);
      let json;
      try {
        json = JSON.parse(txt);
      } catch (e) {
        throw new Error('JSON inválido: ' + txt.slice(0, 180));
      }
      if (json && json.is_login === false) throw new Error('SPX retornou is_login:false');
      if (typeof json?.retcode !== 'undefined' && json.retcode !== 0) {
        throw new Error(`retcode ${json.retcode}: ${json.message || ''}`);
      }
      return json;
    }

    async function runPool(items, maxConcurrency, worker) {
      const list = Array.isArray(items) ? items : [];
      const results = new Array(list.length);
      let cursor = 0;

      async function runner() {
        while (true) {
          const index = cursor++;
          if (index >= list.length) break;
          results[index] = await worker(list[index], index);
        }
      }

      const size = Math.max(1, Math.min(maxConcurrency || 1, list.length || 1));
      await Promise.all(Array.from({ length: size }, () => runner()));
      return results;
    }

    async function fetchAllTasks() {
      const all = [];
      let page = 1;
      const count = 100;
      let total = null;

      while (true) {
        const json = await getJson(API.taskList(page, count, startSec, endSec));
        const data = json?.data || {};
        const list = Array.isArray(data.list) ? data.list : [];
        total = total === null ? Number(data.total || 0) : total;
        all.push(...list);
        if (!list.length || all.length >= total) break;
        page += 1;
      }

      return all;
    }

    async function fetchTaskTargets(taskId) {
      const all = [];
      let page = 1;
      const count = 200;
      let total = null;
      let firstData = null;

      while (true) {
        const json = await getJson(API.targetList(page, count, taskId));
        const data = json?.data || {};
        if (!firstData) firstData = data;
        const list = Array.isArray(data.list) ? data.list : [];
        total = total === null ? Number(data.total || 0) : total;
        all.push(...list);
        if (!list.length || all.length >= total) break;
        page += 1;
      }

      return {
        meta: {
          task_status: Number(firstData?.task_status || 0),
          all_qty: Number(firstData?.all_qty || 0),
          total: Number(firstData?.total || 0),
          not_validate_qty: Number(firstData?.not_validate_qty || 0),
          in_progress_qty: Number(firstData?.in_progress_qty || 0),
          deviated_qty: Number(firstData?.deviated_qty || 0),
          validated_qty: Number(firstData?.validated_qty || 0)
        },
        list: all
      };
    }

    const tasks = await fetchAllTasks();
    const taskRows = tasks.map(task => taskHeaders.map(key => task?.[key] ?? ''));
    const targetRows = [];
    const summaryRows = [];
    let errors = 0;

    await runPool(tasks, concurrency, async task => {
      const vt = String(task?.validation_task_id || '').trim();
      if (!vt) return;

      try {
        const targetResp = await fetchTaskTargets(vt);
        const targets = Array.isArray(targetResp.list) ? targetResp.list : [];

        for (const target of targets) {
          const rowObj = { vt_task_id: vt, ...target };
          targetRows.push(targetHeaders.map(key => rowObj?.[key] ?? ''));
        }

        summaryRows.push([
          vt,
          formatEpochSec(task?.create_time),
          formatEpochSec(task?.end_time),
          Number(task?.total_target_qty || 0),
          Number(targetResp?.meta?.validated_qty || task?.validated_target_qty || 0),
          Number(targetResp?.meta?.in_progress_qty || 0),
          Number(targetResp?.meta?.not_validate_qty || 0),
          targets.length,
          Number(task?.task_status || targetResp?.meta?.task_status || 0),
          'OK'
        ]);
      } catch (e) {
        errors += 1;
        summaryRows.push([
          vt,
          formatEpochSec(task?.create_time),
          formatEpochSec(task?.end_time),
          Number(task?.total_target_qty || 0),
          Number(task?.validated_target_qty || 0),
          '',
          '',
          0,
          Number(task?.task_status || 0),
          '❌ ' + String(e?.message || e)
        ]);
      }
    });

    summaryRows.sort((a, b) => String(b[1] || '').localeCompare(String(a[1] || '')));

    return {
      ok: true,
      lookbackDays,
      taskHeaders,
      taskRows,
      targetHeaders,
      targetRows,
      summaryHeaders,
      summaryRows,
      taskCount: taskRows.length,
      targetCount: targetRows.length,
      errors
    };
  })();
}

function getAuditAutoDefaultState() {
  return {
    enabled: true,
    running: false,
    lastRunAt: 0,
    nextRunAt: Date.now() + AUDIT_AUTO_INTERVAL_MINUTES * 60 * 1000,
    lastStatus: 'Automação ativa.',
    lastTasks: 0,
    lastTargets: 0,
    lastErrors: 0,
    lastHeaders: [],
    lastRows: []
  };
}

async function getAuditAutoState() {
  const obj = await chrome.storage.local.get(['auditAuto']);
  return { ...getAuditAutoDefaultState(), ...(obj.auditAuto || {}) };
}

async function setAuditAutoState(patch) {
  const current = await getAuditAutoState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ auditAuto: next });
  return next;
}

function isAuditAutoRunStale(state) {
  return !!state.running && Number(state.lastRunAt || 0) > 0 && (Date.now() - Number(state.lastRunAt || 0)) > AUDIT_AUTO_MAX_RUNNING_MS;
}

async function ensureAuditAutoAlarm() {
  const state = await getAuditAutoState();
  await chrome.alarms.clear(AUDIT_AUTO_ALARM_NAME);
  if (!state.enabled) return;
  const when = Date.now() + AUDIT_AUTO_INTERVAL_MINUTES * 60 * 1000;
  await chrome.alarms.create(AUDIT_AUTO_ALARM_NAME, { when });
  await setAuditAutoState({ nextRunAt: when });
}

async function executeAuditRunnerWithRetry(tabId, payload) {
  let lastErr;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const injected = await withTimeout(chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: conferenciaAutoSpxRunner,
        args: [payload]
      }), AUDIT_AUTO_MAX_RUNNING_MS, 'Tempo limite da consulta de Conferência excedido.');

      const result = injected?.[0]?.result;
      if (!result?.ok) throw new Error(result?.error || 'Falha ao consultar Conferência na SPX.');
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransientChromePortError(err) || attempt === 3) break;
      await sleep(1200 * attempt);
    }
  }

  throw new Error(normalizeChromeExecutionError(lastErr));
}

async function findReadySpxTabForAudit() {
  const tabs = await chrome.tabs.query({ url: 'https://spx.shopee.com.br/*' });
  const candidates = tabs
    .filter(t => t?.id && String(t.url || '').startsWith('https://spx.shopee.com.br/'))
    .sort((a, b) => Number(b.active || false) - Number(a.active || false));

  return candidates.find(t => t.status === 'complete') || candidates[0] || null;
}

async function runAuditAutoFlow(source = 'alarm') {
  let state = await getAuditAutoState();
  const busyObj = await chrome.storage.local.get(['spxToolkitBusy']);
  const busy = busyObj.spxToolkitBusy || {};

  if (!state.enabled) return { skipped: true, reason: 'Automação desativada.' };

  if (isAuditAutoRunStale(state)) {
    state = await setAuditAutoState({
      running: false,
      lastStatus: 'Execução anterior expirou e foi liberada.'
    });
  }

  if (state.running) return { skipped: true, reason: 'Automação já está rodando.' };
  if (busy.running) {
    await setAuditAutoState({
      lastStatus: `Ignorado: ${busy.scope || 'extensão'} em execução.`,
      nextRunAt: Date.now() + AUDIT_AUTO_INTERVAL_MINUTES * 60 * 1000
    });
    return { skipped: true, reason: 'Extensão ocupada.' };
  }

  if (!AUDIT_SYNC_ENDPOINT || !/^https?:\/\//i.test(AUDIT_SYNC_ENDPOINT)) {
    throw new Error('Endpoint fixo da Conferência Auto não está configurado.');
  }

  await setAuditAutoState({
    running: true,
    lastStatus: 'Coletando Conferência e Conferencia_AT_List na SPX...',
    lastRunAt: Date.now()
  });

  try {
    const tab = await findReadySpxTabForAudit();
    if (!tab?.id) throw new Error('Nenhuma aba SPX encontrada para automação. Abra a SPX logada em uma aba.');
    if (tab.status !== 'complete') throw new Error('A aba SPX ainda está carregando. A próxima execução tentará novamente.');

    const result = await executeAuditRunnerWithRetry(tab.id, {
      lookbackDays: AUDIT_AUTO_LOOKBACK_DAYS,
      concurrency: 2
    });

    const payload = {
      items: [
        {
          sheetName: 'Conferencia',
          header: result.taskHeaders || [],
          rows: result.taskRows || []
        },
        {
          sheetName: 'Conferencia_AT_List',
          header: result.targetHeaders || [],
          rows: result.targetRows || []
        }
      ]
    };

    const postResp = await requestJson(AUDIT_SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });

    if (postResp && postResp.ok === false) {
      throw new Error(postResp.error || 'Apps Script retornou falha.');
    }

    const taskCount = Number(result.taskCount || 0);
    const targetCount = Number(result.targetCount || 0);
    const errors = Number(result.errors || 0);

    await setAuditAutoState({
      running: false,
      lastStatus: `Auto concluído • ${taskCount} tarefa(s) • ${targetCount} target(s) • ${errors} erro(s).`,
      lastTasks: taskCount,
      lastTargets: targetCount,
      lastErrors: errors,
      lastHeaders: result.summaryHeaders || [],
      lastRows: result.summaryRows || [],
      nextRunAt: Date.now() + AUDIT_AUTO_INTERVAL_MINUTES * 60 * 1000
    });

    return { ok: true, taskCount, targetCount, errors };
  } catch (err) {
    await setAuditAutoState({
      running: false,
      lastStatus: 'Erro no auto: ' + String(err?.message || err),
      lastErrors: Number(state.lastErrors || 0) + 1,
      nextRunAt: Date.now() + AUDIT_AUTO_INTERVAL_MINUTES * 60 * 1000
    });
    return { ok: false, error: String(err?.message || err) };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAuditAutoAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureAuditAutoAlarm().catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === AUDIT_AUTO_ALARM_NAME) {
    runAuditAutoFlow('alarm').finally(() => ensureAuditAutoAlarm().catch(() => {}));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'AUDIT_AUTO_STATUS') {
    (async () => {
      try {
        let state = await getAuditAutoState();
        if (isAuditAutoRunStale(state)) {
          state = await setAuditAutoState({
            running: false,
            lastStatus: 'Execução anterior expirou e foi liberada.',
            nextRunAt: Date.now() + AUDIT_AUTO_INTERVAL_MINUTES * 60 * 1000
          });
          await ensureAuditAutoAlarm();
        }
        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'AUDIT_AUTO_SET_ENABLED') {
    (async () => {
      try {
        const enabled = !!msg.enabled;
        const patch = { enabled, lastStatus: enabled ? 'Automação ativa.' : 'Automação desativada.' };
        if (enabled) patch.nextRunAt = Date.now() + AUDIT_AUTO_INTERVAL_MINUTES * 60 * 1000;
        const state = await setAuditAutoState(patch);
        await ensureAuditAutoAlarm();
        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'AUDIT_AUTO_RUN_NOW') {
    runAuditAutoFlow('manual-message')
      .finally(() => ensureAuditAutoAlarm().catch(() => {}));
    sendResponse({ ok: true, data: { started: true } });
    return false;
  }

  if (msg.type === 'AUDIT_AUTO_CLEAR_RESULTS') {
    (async () => {
      try {
        const state = await setAuditAutoState({
          lastTasks: 0,
          lastTargets: 0,
          lastErrors: 0,
          lastHeaders: [],
          lastRows: [],
          lastStatus: 'Resultado limpo.'
        });
        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
});



const ASSIGNMENT_SYNC_ENDPOINT = 'https://script.google.com/a/macros/shopee.com/s/AKfycbw8q8kGMWKXpSs6cJuTNY97gdU8uxIu-SqhLHDk1Epfb42I6rDyc_G_QQH3JcK_XD1klQ/exec';
const ASSIGNMENT_AUTO_ALARM_NAME = 'spx-toolkit-assignment-auto-run';
const ASSIGNMENT_AUTO_INTERVAL_MINUTES = 60;
const ASSIGNMENT_AUTO_MAX_RUNNING_MS = 9 * 60 * 1000;
const ASSIGNMENT_SYNC_CHUNK_SIZE = 100;
const ASSIGNMENT_SYNC_TIMEOUT_MS = 2 * 60 * 1000;
const ASSIGNMENT_AUTO_LOOKBACK_DAYS = 7;
const ASSIGNMENT_AUTO_HEADERS = [
  'assignment_task_id',
  'driver_id',
  'order_count',
  'status',
  'delivery_time',
  'processing_time',
  'processed_time',
  'assigned_time',
  'partially_assigned_time',
  'complete_time',
  'vehicle_name',
  'original_auto_add_order_count_quota',
  'ctime',
  'mtime',
  'corridor_cage',
  'vehicle_type',
  'city',
  'neighborhood',
  'cluster',
  'planned_vehicle_type',
  'driver_assigned_time',
  'driver_name',
  'stops_number',
  'total_distance'
];

function isAssignmentAutoRunStale(state) {
  return !!state.running && Number(state.lastRunAt || 0) > 0 && (Date.now() - Number(state.lastRunAt || 0)) > ASSIGNMENT_AUTO_MAX_RUNNING_MS;
}

async function getAssignmentAutoState() {
  const obj = await chrome.storage.local.get(['spxAssignmentAutoState']);
  const state = obj.spxAssignmentAutoState || {};
  return {
    enabled: state.enabled !== false,
    running: !!state.running,
    lastStatus: state.lastStatus || 'Automação ativa.',
    lastRunAt: Number(state.lastRunAt || 0),
    nextRunAt: Number(state.nextRunAt || 0),
    lastTasks: Number(state.lastTasks || 0),
    lastSent: Number(state.lastSent || 0),
    lastUnchanged: Number(state.lastUnchanged || 0),
    lastErrors: Number(state.lastErrors || 0),
    lastHeaders: Array.isArray(state.lastHeaders) ? state.lastHeaders : ASSIGNMENT_AUTO_HEADERS,
    lastRows: Array.isArray(state.lastRows) ? state.lastRows : []
  };
}

async function setAssignmentAutoState(patch) {
  const current = await getAssignmentAutoState();
  const next = { ...current, ...(patch || {}) };
  await chrome.storage.local.set({ spxAssignmentAutoState: next });
  return next;
}

async function ensureAssignmentAutoAlarm() {
  const state = await getAssignmentAutoState();
  await chrome.alarms.clear(ASSIGNMENT_AUTO_ALARM_NAME);
  if (!state.enabled) return;
  const when = Date.now() + ASSIGNMENT_AUTO_INTERVAL_MINUTES * 60 * 1000;
  await chrome.alarms.create(ASSIGNMENT_AUTO_ALARM_NAME, { when });
  await setAssignmentAutoState({ nextRunAt: when });
}

function chunkAssignmentItems(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function isAssignmentDateTimeField(header) {
  const key = String(header || '').trim().toLowerCase();
  return [
    'delivery_time',
    'processing_time',
    'processed_time',
    'assigned_time',
    'partially_assigned_time',
    'complete_time',
    'driver_assigned_time',
    'ctime',
    'mtime',
    'created_at',
    'updated_at',
    'create_time',
    'update_time'
  ].includes(key) || key.endsWith('_at') || key.endsWith('_date') || key.endsWith('_datetime');
}

function parseAssignmentSignatureTimestamp(value) {
  if (value === null || value === undefined || value === '') return '';

  if (value instanceof Date && !isNaN(value.getTime())) {
    return String(Math.floor(value.getTime() / 1000));
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return '';
    if (value > 99999999999999) return String(Math.floor(value / 1000000));
    if (value > 9999999999) return String(Math.floor(value / 1000));
    if (value > 999999999) return String(Math.floor(value));
    return '';
  }

  const text = String(value).trim();
  if (!text || text === '0') return '';

  if (/^\d+(\.\d+)?$/.test(text)) {
    return parseAssignmentSignatureTimestamp(Number(text));
  }

  let match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const date = new Date(
      Number(match[3]),
      Number(match[2]) - 1,
      Number(match[1]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0)
    );
    return isNaN(date.getTime()) ? text : String(Math.floor(date.getTime() / 1000));
  }

  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? text : String(Math.floor(parsed.getTime() / 1000));
}

function stableAssignmentValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    return '[' + value.map(stableAssignmentValue).join(',') + ']';
  }

  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableAssignmentValue(value[key])}`).join(',') + '}';
  }

  return String(value);
}

function normalizeAssignmentSignatureValue(header, value) {
  return isAssignmentDateTimeField(header)
    ? parseAssignmentSignatureTimestamp(value)
    : stableAssignmentValue(value);
}

function hashAssignmentSignature(text) {
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

function buildAssignmentItemSignature(item, headers) {
  const values = headers.map(header => normalizeAssignmentSignatureValue(header, item?.[header]));
  return hashAssignmentSignature(JSON.stringify(values));
}

function buildAssignmentSignatures(items, headers, keyField) {
  return items
    .map(item => {
      const key = String(item?.[keyField] ?? '').trim();
      return key ? { key, signature: buildAssignmentItemSignature(item, headers) } : null;
    })
    .filter(Boolean);
}

function assignmentTaskSpxRunner(payload) {
  return (async () => {
    const lookbackDays = Math.max(1, Math.min(30, Number(payload?.lookbackDays) || 7));
    const count = Math.max(20, Math.min(100, Number(payload?.count) || 100));
    const endpoint = 'https://spx.shopee.com.br/spx_delivery/admin/assignment/assignment_task/search/v2';
    const headers = Array.isArray(payload?.headers) && payload.headers.length ? payload.headers : [];

    function getCookie(name) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : '';
    }

    function getDateRangeSeconds(days) {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      return {
        start: Math.floor(start.getTime() / 1000),
        end: Math.floor(end.getTime() / 1000)
      };
    }

    function safeJson(v) {
      if (!v) return {};
      if (typeof v === 'object') return v;
      try { return JSON.parse(String(v)); } catch (e) { return {}; }
    }

    function pick(item, header) {
      if (header === 'original_auto_add_order_count_quota') {
        return safeJson(item?.extra).original_auto_add_order_count_quota ?? '';
      }
      return item?.[header] ?? '';
    }

    function normalizeItem(item) {
      const out = {};
      headers.forEach(header => out[header] = pick(item, header));
      return out;
    }

    function toRow(item) {
      return headers.map(header => pick(item, header));
    }

    async function postPage(pageno, ctime) {
      const csrftoken = getCookie('csrftoken');
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json, text/plain, */*',
          app: 'FMS Portal',
          'content-type': 'application/json;charset=UTF-8',
          ...(csrftoken ? { 'x-csrftoken': csrftoken } : {})
        },
        body: JSON.stringify({ ctime, pageno, count, search_type: 0 })
      });

      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 260)}`);
      let json;
      try { json = JSON.parse(text); } catch (e) { throw new Error('JSON inválido: ' + text.slice(0, 180)); }
      if (json && json.is_login === false) throw new Error('SPX retornou is_login:false');
      if (typeof json?.retcode !== 'undefined' && json.retcode !== 0) throw new Error(`retcode ${json.retcode}: ${json.message || ''}`);
      return json;
    }

    const range = getDateRangeSeconds(lookbackDays);
    const ctime = `${range.start},${range.end}`;
    const first = await postPage(1, ctime);
    const data = first?.data || {};
    const total = Number(data.total || 0);
    const pages = Math.max(1, Math.ceil(total / count));
    const list = Array.isArray(data.list) ? [...data.list] : [];

    for (let page = 2; page <= pages; page++) {
      const json = await postPage(page, ctime);
      const pageList = Array.isArray(json?.data?.list) ? json.data.list : [];
      list.push(...pageList);
    }

    const byId = new Map();
    for (const item of list) {
      const key = String(item?.assignment_task_id || '').trim();
      if (!key) continue;
      byId.set(key, item);
    }

    const unique = Array.from(byId.values());
    const items = unique.map(normalizeItem);
    const rows = unique.map(toRow);

    return {
      ok: true,
      ctime,
      total,
      pages,
      count: unique.length,
      headers,
      items,
      rows
    };
  })().catch(err => ({ ok: false, error: String(err?.message || err) }));
}

async function executeAssignmentRunnerWithRetry(tabId, payload) {
  let lastErr;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const injected = await withTimeout(chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: assignmentTaskSpxRunner,
        args: [payload]
      }), ASSIGNMENT_AUTO_MAX_RUNNING_MS, 'Tempo limite da consulta de ATs excedido.');

      const result = injected?.[0]?.result;
      if (!result?.ok) throw new Error(result?.error || 'Falha ao consultar ATs na SPX.');
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransientChromePortError(err) || attempt === 3) break;
      await sleep(1200 * attempt);
    }
  }

  throw new Error(normalizeChromeExecutionError(lastErr));
}

async function findReadySpxTabForAssignment() {
  const tabs = await chrome.tabs.query({ url: 'https://spx.shopee.com.br/*' });
  const candidates = tabs
    .filter(t => t?.id && String(t.url || '').startsWith('https://spx.shopee.com.br/'))
    .sort((a, b) => Number(b.active || false) - Number(a.active || false));

  return candidates.find(t => t.status === 'complete') || candidates[0] || null;
}

async function runAssignmentAutoFlow(source = 'alarm') {
  let state = await getAssignmentAutoState();
  const busyObj = await chrome.storage.local.get(['spxToolkitBusy']);
  const busy = busyObj.spxToolkitBusy || {};

  if (!state.enabled) return { skipped: true, reason: 'Automação desativada.' };

  if (isAssignmentAutoRunStale(state)) {
    state = await setAssignmentAutoState({
      running: false,
      lastStatus: 'Execução anterior expirou e foi liberada.'
    });
  }

  if (state.running) return { skipped: true, reason: 'Automação já está rodando.' };
  if (busy.running) {
    await setAssignmentAutoState({
      lastStatus: `Ignorado: ${busy.scope || 'extensão'} em execução.`,
      nextRunAt: Date.now() + ASSIGNMENT_AUTO_INTERVAL_MINUTES * 60 * 1000
    });
    return { skipped: true, reason: 'Extensão ocupada.' };
  }

  if (!ASSIGNMENT_SYNC_ENDPOINT || !/^https?:\/\//i.test(ASSIGNMENT_SYNC_ENDPOINT)) {
    throw new Error('Endpoint fixo da Base de ATs não está configurado. Edite ASSIGNMENT_SYNC_ENDPOINT no background.js.');
  }

  await setAssignmentAutoState({
    running: true,
    lastStatus: 'Coletando ATs dos últimos 7 dias na SPX...',
    lastRunAt: Date.now()
  });

  try {
    const tab = await findReadySpxTabForAssignment();
    if (!tab?.id) throw new Error('Nenhuma aba SPX encontrada para automação. Abra a SPX logada em uma aba.');
    if (tab.status !== 'complete') throw new Error('A aba SPX ainda está carregando. A próxima execução tentará novamente.');

    const result = await executeAssignmentRunnerWithRetry(tab.id, {
      lookbackDays: ASSIGNMENT_AUTO_LOOKBACK_DAYS,
      count: 100,
      headers: ASSIGNMENT_AUTO_HEADERS
    });

    const items = Array.isArray(result.items) ? result.items : [];
    const totalCollected = items.length;
    const keyField = 'assignment_task_id';
    const signatures = buildAssignmentSignatures(items, ASSIGNMENT_AUTO_HEADERS, keyField);

    await setAssignmentAutoState({
      lastStatus: `Comparando ${totalCollected} AT(s) com a planilha...`
    });

    const compareResp = await requestJson(ASSIGNMENT_SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'compareAssignmentTasks',
        sheetName: 'Base_ATs',
        keyField,
        headers: ASSIGNMENT_AUTO_HEADERS,
        signatures
      }),
      timeoutMs: ASSIGNMENT_SYNC_TIMEOUT_MS
    });

    if (compareResp && compareResp.ok === false) {
      throw new Error(compareResp.error || 'Apps Script retornou falha na comparação.');
    }

    const changedKeys = new Set(Array.isArray(compareResp?.changedKeys) ? compareResp.changedKeys.map(String) : []);
    const itemsToSend = items.filter(item => changedKeys.has(String(item?.[keyField] ?? '').trim()));
    const chunks = chunkAssignmentItems(itemsToSend, ASSIGNMENT_SYNC_CHUNK_SIZE);
    const totalToSend = itemsToSend.length;
    const unchanged = Math.max(0, totalCollected - totalToSend);
    let sent = 0;
    let inserted = 0;
    let updated = 0;
    let serverUnchanged = 0;
    let skipped = 0;

    if (!totalCollected) {
      await setAssignmentAutoState({ lastStatus: 'Nenhuma AT encontrada nos últimos 7 dias.' });
    } else if (!totalToSend) {
      await setAssignmentAutoState({ lastStatus: `Nenhuma alteração encontrada em ${totalCollected} AT(s).` });
    }

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkNumber = index + 1;
      const totalChunks = chunks.length;

      await setAssignmentAutoState({
        lastStatus: `Enviando somente alterações... lote ${chunkNumber}/${totalChunks} (${sent}/${totalToSend})`
      });

      const postResp = await requestJson(ASSIGNMENT_SYNC_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'upsertAssignmentTasks',
          sheetName: 'Base_ATs',
          keyField,
          headers: ASSIGNMENT_AUTO_HEADERS,
          items: chunk
        }),
        timeoutMs: ASSIGNMENT_SYNC_TIMEOUT_MS
      });

      if (postResp && postResp.ok === false) {
        throw new Error(postResp.error || 'Apps Script retornou falha.');
      }

      sent += chunk.length;
      inserted += Number(postResp?.inserted || 0);
      updated += Number(postResp?.updated || 0);
      serverUnchanged += Number(postResp?.unchanged || 0);
      skipped += Number(postResp?.skipped || 0);

      await setAssignmentAutoState({
        lastStatus: `Lote ${chunkNumber}/${totalChunks} enviado • ${sent}/${totalToSend} alteração(ões)`
      });
    }

    const totalUnchanged = unchanged + serverUnchanged;

    await setAssignmentAutoState({
      running: false,
      lastStatus: `Auto concluído • ${totalCollected} coletadas • ${sent} enviadas • ${totalUnchanged} sem alteração • ${inserted} novas • ${updated} atualizadas • ${skipped} ignoradas.`,
      lastTasks: totalCollected,
      lastSent: sent,
      lastUnchanged: totalUnchanged,
      lastErrors: 0,
      lastHeaders: result.headers || ASSIGNMENT_AUTO_HEADERS,
      lastRows: result.rows || [],
      nextRunAt: Date.now() + ASSIGNMENT_AUTO_INTERVAL_MINUTES * 60 * 1000
    });

    return { ok: true, collected: totalCollected, sent, unchanged: totalUnchanged, inserted, updated };
  } catch (err) {
    await setAssignmentAutoState({
      running: false,
      lastStatus: 'Erro no auto: ' + String(err?.message || err),
      lastErrors: Number(state.lastErrors || 0) + 1,
      nextRunAt: Date.now() + ASSIGNMENT_AUTO_INTERVAL_MINUTES * 60 * 1000
    });
    return { ok: false, error: String(err?.message || err) };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAssignmentAutoAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureAssignmentAutoAlarm().catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ASSIGNMENT_AUTO_ALARM_NAME) {
    runAssignmentAutoFlow('alarm').finally(() => ensureAssignmentAutoAlarm().catch(() => {}));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'ASSIGNMENT_AUTO_STATUS') {
    (async () => {
      try {
        let state = await getAssignmentAutoState();
        if (isAssignmentAutoRunStale(state)) {
          state = await setAssignmentAutoState({
            running: false,
            lastStatus: 'Execução anterior expirou e foi liberada.',
            nextRunAt: Date.now() + ASSIGNMENT_AUTO_INTERVAL_MINUTES * 60 * 1000
          });
          await ensureAssignmentAutoAlarm();
        }
        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ASSIGNMENT_AUTO_SET_ENABLED') {
    (async () => {
      try {
        const enabled = !!msg.enabled;
        const patch = { enabled, lastStatus: enabled ? 'Automação ativa.' : 'Automação desativada.' };
        if (enabled) patch.nextRunAt = Date.now() + ASSIGNMENT_AUTO_INTERVAL_MINUTES * 60 * 1000;
        const state = await setAssignmentAutoState(patch);
        await ensureAssignmentAutoAlarm();
        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ASSIGNMENT_AUTO_RUN_NOW') {
    (async () => {
      try {
        const data = await runAssignmentAutoFlow('manual-message');
        await ensureAssignmentAutoAlarm();
        sendResponse({ ok: true, data });
      } catch (err) {
        await ensureAssignmentAutoAlarm().catch(() => {});
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ASSIGNMENT_AUTO_CLEAR_RESULTS') {
    (async () => {
      try {
        const state = await setAssignmentAutoState({
          lastTasks: 0,
          lastSent: 0,
          lastUnchanged: 0,
          lastErrors: 0,
          lastHeaders: ASSIGNMENT_AUTO_HEADERS,
          lastRows: [],
          lastStatus: 'Resultado limpo.'
        });
        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
});

const PARCEL_SWEEPER_SYNC_ENDPOINT = AUDIT_SYNC_ENDPOINT;
const PARCEL_SWEEPER_ALARM_NAME = 'spx-toolkit-parcel-sweeper-auto-run';
const PARCEL_SWEEPER_INTERVAL_MINUTES = 60;
const PARCEL_SWEEPER_MAX_RUNNING_MS = 12 * 60 * 1000;
const PARCEL_SWEEPER_STATION_ID = 5264;
const PARCEL_SWEEPER_TASK_LIMIT = 5;
const PARCEL_SWEEPER_ORDER_PAGE_SIZE = 24;
const PARCEL_SWEEPER_ORDER_CONCURRENCY = 4;
const PARCEL_SWEEPER_SUMMARY_HEADERS = [
  'Data',
  'Tarefa PS',
  'Status',
  'Planilha',
  'Pedidos',
  'Resultado'
];

function getParcelSweeperDefaultState() {
  return {
    enabled: true,
    running: false,
    lastRunAt: 0,
    nextRunAt: Date.now() + PARCEL_SWEEPER_INTERVAL_MINUTES * 60 * 1000,
    lastStatus: 'Automação ativa.',
    lastTasks: 0,
    lastOrders: 0,
    lastErrors: 0,
    lastHeaders: PARCEL_SWEEPER_SUMMARY_HEADERS,
    lastRows: []
  };
}

async function getParcelSweeperState() {
  const obj = await chrome.storage.local.get(['parcelSweeperAuto']);
  return { ...getParcelSweeperDefaultState(), ...(obj.parcelSweeperAuto || {}) };
}

async function setParcelSweeperState(patch) {
  const current = await getParcelSweeperState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ parcelSweeperAuto: next });
  return next;
}

function isParcelSweeperRunStale(state) {
  return !!state.running &&
    Number(state.lastRunAt || 0) > 0 &&
    (Date.now() - Number(state.lastRunAt || 0)) > PARCEL_SWEEPER_MAX_RUNNING_MS;
}

async function ensureParcelSweeperAlarm() {
  const state = await getParcelSweeperState();
  await chrome.alarms.clear(PARCEL_SWEEPER_ALARM_NAME);
  if (!state.enabled) return;

  const when = Date.now() + PARCEL_SWEEPER_INTERVAL_MINUTES * 60 * 1000;
  await chrome.alarms.create(PARCEL_SWEEPER_ALARM_NAME, { when });
  await setParcelSweeperState({ nextRunAt: when });
}

function parcelSweeperSpxRunner(payload) {
  return (async () => {
    const stationId = Math.max(1, Number(payload?.stationId || 5264));
    const mode = String(payload?.mode || 'list');
    const pageSize = Math.max(1, Number(payload?.pageSize || 24));
    const concurrency = Math.max(1, Math.min(6, Number(payload?.concurrency || 4)));

    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    async function fetchJson(url) {
      let lastError;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await window.fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json, text/plain, */*' }
          });

          const text = await response.text();
          let json;

          try {
            json = JSON.parse(text);
          } catch (_) {
            throw new Error(text.slice(0, 300) || `HTTP ${response.status}`);
          }

          if (!response.ok || Number(json?.retcode || 0) !== 0) {
            throw new Error(json?.message || json?.error || `HTTP ${response.status}`);
          }

          return json;
        } catch (error) {
          lastError = error;
          if (attempt === 3) break;
          await wait(500 * attempt);
        }
      }

      throw lastError || new Error('Falha ao consultar API do Parcel Sweeper.');
    }

    if (mode === 'list') {
      const url = `/api/in-station/parcel/v2/task/list?station_id=${encodeURIComponent(stationId)}&pageno=1&count=50`;
      const json = await fetchJson(url);
      const list = Array.isArray(json?.data?.list) ? json.data.list : [];
      const limit = Math.max(1, Number(payload?.taskLimit || 5));

      return {
        ok: true,
        total: Number(json?.data?.total || list.length),
        tasks: list.slice(0, limit)
      };
    }

    if (mode !== 'orders') {
      throw new Error('Modo inválido do coletor Parcel Sweeper.');
    }

    const taskId = String(payload?.taskId || '').trim();
    if (!taskId) throw new Error('task_id do Parcel Sweeper não informado.');

    async function fetchPage(page) {
      const url = `/api/in-station/parcel/task/order/search?station_id=${encodeURIComponent(stationId)}&pageno=${encodeURIComponent(page)}&count=${encodeURIComponent(pageSize)}&task_id=${encodeURIComponent(taskId)}`;
      const json = await fetchJson(url);
      const data = json?.data || {};
      return {
        page,
        total: Number(data.total || 0),
        list: Array.isArray(data.list) ? data.list : []
      };
    }

    const first = await fetchPage(1);
    const total = Math.max(0, Number(first.total || first.list.length));
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const pageResults = new Array(pages);
    pageResults[0] = first;
    let nextPage = 2;

    async function worker() {
      while (true) {
        const page = nextPage;
        nextPage += 1;
        if (page > pages) return;
        pageResults[page - 1] = await fetchPage(page);
      }
    }

    const workerCount = Math.min(concurrency, Math.max(0, pages - 1));
    if (workerCount > 0) {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }

    const byShipment = new Map();
    for (const result of pageResults) {
      for (const order of (result?.list || [])) {
        const shipmentId = String(order?.shipment_id || '').trim();
        if (!shipmentId) continue;
        byShipment.set(shipmentId, order);
      }
    }

    const orders = Array.from(byShipment.values());

    return {
      ok: true,
      taskId,
      total,
      pages,
      pageSize,
      orders
    };
  })();
}

async function executeParcelSweeperRunnerWithRetry(tabId, payload) {
  let lastErr;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const injected = await withTimeout(chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: parcelSweeperSpxRunner,
        args: [payload]
      }), PARCEL_SWEEPER_MAX_RUNNING_MS, 'Tempo limite da coleta do Parcel Sweeper excedido.');

      const result = injected?.[0]?.result;
      if (!result?.ok) throw new Error(result?.error || 'Falha ao consultar Parcel Sweeper na SPX.');
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransientChromePortError(err) || attempt === 3) break;
      await sleep(1200 * attempt);
    }
  }

  throw new Error(normalizeChromeExecutionError(lastErr));
}

async function findReadySpxTabForParcelSweeper() {
  const tabs = await chrome.tabs.query({ url: 'https://spx.shopee.com.br/*' });
  const candidates = tabs
    .filter(tab => tab?.id && String(tab.url || '').startsWith('https://spx.shopee.com.br/'))
    .sort((a, b) => Number(b.active || false) - Number(a.active || false));

  return candidates.find(tab => tab.status === 'complete') || candidates[0] || null;
}

async function getParcelSweeperSheetStatus(taskIds) {
  const ids = Array.from(new Set((taskIds || []).map(id => String(id || '').trim()).filter(Boolean)));
  if (!ids.length) return {};

  const response = await requestJson(PARCEL_SWEEPER_SYNC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: 'parcelSweeperStatus',
      taskIds: ids
    }),
    timeoutMs: 60 * 1000
  });

  if (response && response.ok === false) {
    throw new Error(response.error || 'Falha ao consultar tarefas do Parcel Sweeper na planilha.');
  }

  return response?.tasks || {};
}

async function sendParcelSweeperTask(task, orders, complete) {
  const response = await requestJson(PARCEL_SWEEPER_SYNC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: 'parcelSweeperImport',
      sheetName: 'Relatório Parcel Sweeper',
      task,
      orders,
      complete: !!complete
    }),
    timeoutMs: 4 * 60 * 1000
  });

  if (response && response.ok === false) {
    throw new Error(response.error || 'Falha ao importar Parcel Sweeper na planilha.');
  }

  return response;
}

async function runParcelSweeperFlow(source = 'alarm') {
  let state = await getParcelSweeperState();
  const busyObj = await chrome.storage.local.get(['spxToolkitBusy']);
  const busy = busyObj.spxToolkitBusy || {};

  if (!state.enabled) return { skipped: true, reason: 'Automação desativada.' };

  if (isParcelSweeperRunStale(state)) {
    state = await setParcelSweeperState({
      running: false,
      lastStatus: 'Execução anterior expirou e foi liberada.'
    });
  }

  if (state.running) return { skipped: true, reason: 'Automação já está rodando.' };

  if (busy.running) {
    await setParcelSweeperState({
      lastStatus: `Ignorado: ${busy.scope || 'extensão'} em execução.`,
      nextRunAt: Date.now() + PARCEL_SWEEPER_INTERVAL_MINUTES * 60 * 1000
    });
    return { skipped: true, reason: 'Extensão ocupada.' };
  }

  if (!PARCEL_SWEEPER_SYNC_ENDPOINT || !/^https?:\/\//i.test(PARCEL_SWEEPER_SYNC_ENDPOINT)) {
    throw new Error('Endpoint da planilha do Parcel Sweeper não está configurado.');
  }

  await setParcelSweeperState({
    running: true,
    lastStatus: 'Consultando as 5 tarefas mais recentes do Parcel Sweeper...',
    lastRunAt: Date.now()
  });

  const summaryRows = [];
  let totalOrders = 0;
  let errors = 0;

  try {
    const tab = await findReadySpxTabForParcelSweeper();
    if (!tab?.id) throw new Error('Nenhuma aba SPX encontrada. Abra a SPX logada em uma aba.');
    if (tab.status !== 'complete') throw new Error('A aba SPX ainda está carregando. A próxima execução tentará novamente.');

    const listResult = await executeParcelSweeperRunnerWithRetry(tab.id, {
      mode: 'list',
      stationId: PARCEL_SWEEPER_STATION_ID,
      taskLimit: PARCEL_SWEEPER_TASK_LIMIT
    });

    const tasks = Array.isArray(listResult.tasks)
      ? listResult.tasks.slice(0, PARCEL_SWEEPER_TASK_LIMIT)
      : [];

    const sheetStatus = await getParcelSweeperSheetStatus(tasks.map(task => task?.task_id));

    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i] || {};
      const taskId = String(task.task_id || '').trim();
      const taskStatus = Number(task.status || 0);
      const taskDate = String(task.date || '');
      const known = sheetStatus?.[taskId] || {};

      if (!taskId) continue;

      await setParcelSweeperState({
        lastStatus: `Tarefa ${i + 1}/${tasks.length}: ${taskId} • status ${taskStatus}.`
      });

      if (taskStatus === 5 && known.complete === true && Number(known.orderCount || 0) >= Number(task.total || 0)) {
        summaryRows.push([
          taskDate,
          taskId,
          taskStatus,
          'Completa',
          Number(known.orderCount || task.total || 0),
          'Já completa na planilha • nenhuma nova coleta'
        ]);
        continue;
      }

      if (taskStatus !== 4 && taskStatus !== 5) {
        summaryRows.push([
          taskDate,
          taskId,
          taskStatus,
          known.complete ? 'Completa' : 'Sem atualização',
          Number(known.orderCount || 0),
          'Status ignorado'
        ]);
        continue;
      }

      try {
        const orderResult = await executeParcelSweeperRunnerWithRetry(tab.id, {
          mode: 'orders',
          stationId: PARCEL_SWEEPER_STATION_ID,
          taskId,
          pageSize: PARCEL_SWEEPER_ORDER_PAGE_SIZE,
          concurrency: PARCEL_SWEEPER_ORDER_CONCURRENCY
        });

        const orders = Array.isArray(orderResult.orders) ? orderResult.orders : [];
        const importResponse = await sendParcelSweeperTask(task, orders, taskStatus === 5);
        const imported = Number(importResponse?.orderCount ?? orders.length ?? 0);
        const isComplete = importResponse?.complete === true;
        totalOrders += imported;

        summaryRows.push([
          taskDate,
          taskId,
          taskStatus,
          isComplete ? 'Completa' : 'Em andamento',
          imported,
          taskStatus === 5
            ? (isComplete ? 'Coleta final enviada e tarefa marcada como completa' : 'Coleta final enviada, mas a planilha ainda não confirmou completude')
            : 'Snapshot atualizado na planilha'
        ]);
      } catch (taskError) {
        errors += 1;
        summaryRows.push([
          taskDate,
          taskId,
          taskStatus,
          known.complete ? 'Completa' : 'Erro',
          Number(known.orderCount || 0),
          'Erro: ' + String(taskError?.message || taskError)
        ]);
      }
    }

    await setParcelSweeperState({
      running: false,
      lastStatus: `Auto concluído • ${tasks.length} tarefa(s) verificadas • ${totalOrders} pedido(s) coletados • ${errors} erro(s).`,
      lastTasks: tasks.length,
      lastOrders: totalOrders,
      lastErrors: errors,
      lastHeaders: PARCEL_SWEEPER_SUMMARY_HEADERS,
      lastRows: summaryRows,
      nextRunAt: Date.now() + PARCEL_SWEEPER_INTERVAL_MINUTES * 60 * 1000
    });

    return {
      ok: errors === 0,
      taskCount: tasks.length,
      orderCount: totalOrders,
      errors,
      rows: summaryRows
    };
  } catch (err) {
    errors += 1;
    await setParcelSweeperState({
      running: false,
      lastStatus: 'Erro no auto: ' + String(err?.message || err),
      lastTasks: summaryRows.length,
      lastOrders: totalOrders,
      lastErrors: errors,
      lastHeaders: PARCEL_SWEEPER_SUMMARY_HEADERS,
      lastRows: summaryRows,
      nextRunAt: Date.now() + PARCEL_SWEEPER_INTERVAL_MINUTES * 60 * 1000
    });

    return { ok: false, error: String(err?.message || err), errors };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureParcelSweeperAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureParcelSweeperAlarm().catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === PARCEL_SWEEPER_ALARM_NAME) {
    runParcelSweeperFlow('alarm').finally(() => ensureParcelSweeperAlarm().catch(() => {}));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'PARCEL_SWEEPER_STATUS') {
    (async () => {
      try {
        let state = await getParcelSweeperState();

        if (isParcelSweeperRunStale(state)) {
          state = await setParcelSweeperState({
            running: false,
            lastStatus: 'Execução anterior expirou e foi liberada.',
            nextRunAt: Date.now() + PARCEL_SWEEPER_INTERVAL_MINUTES * 60 * 1000
          });
          await ensureParcelSweeperAlarm();
        }

        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'PARCEL_SWEEPER_SET_ENABLED') {
    (async () => {
      try {
        const enabled = !!msg.enabled;
        const patch = {
          enabled,
          lastStatus: enabled ? 'Automação ativa.' : 'Automação desativada.'
        };

        if (enabled) {
          patch.nextRunAt = Date.now() + PARCEL_SWEEPER_INTERVAL_MINUTES * 60 * 1000;
        }

        const state = await setParcelSweeperState(patch);
        await ensureParcelSweeperAlarm();
        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'PARCEL_SWEEPER_RUN_NOW') {
    (async () => {
      try {
        const data = await runParcelSweeperFlow('manual-message');
        await ensureParcelSweeperAlarm();
        sendResponse({ ok: true, data });
      } catch (err) {
        await ensureParcelSweeperAlarm().catch(() => {});
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'PARCEL_SWEEPER_CLEAR_RESULTS') {
    (async () => {
      try {
        const state = await setParcelSweeperState({
          lastTasks: 0,
          lastOrders: 0,
          lastErrors: 0,
          lastHeaders: PARCEL_SWEEPER_SUMMARY_HEADERS,
          lastRows: [],
          lastStatus: 'Resultado limpo.'
        });

        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
});


const PENDING_RETURNS_SYNC_ENDPOINT = AUDIT_SYNC_ENDPOINT;
const PENDING_RETURNS_ALARM_NAME = 'spx-toolkit-pending-returns-auto-run';
const PENDING_RETURNS_INTERVAL_MINUTES = 60;
const PENDING_RETURNS_MAX_RUNNING_MS = 7 * 60 * 1000;
const PENDING_RETURNS_EXPORT_LOOKBACK_DAYS = 30;
const PENDING_RETURNS_EXPORT_POLL_MS = 3000;
const PENDING_RETURNS_EXPORT_MAX_POLLS = 40;
const PENDING_RETURNS_ORDER_ACCOUNTS = '51,9,81,8,82,38,62,63,10,11,50,52,13,26,56,45,59,2,41,32,24,76,16,65,33,35,22,53,37,12,44,74,75,4,80,40,25,31,64,7,28,29,39,5,48,54,6,49,70,73,67,43,55,1,23,14,21,17,3,27,18,66,30,46,71,47,42,69,68,34,36';
const PENDING_RETURNS_ORDER_ACCOUNT_NAMES = 'AMS Free Sample,Bulky Marketplace,Bulky Marketplace Carry Up,Bulky Shopee Xpress,Bulky Shopee Xpress Carry Up,CB Five Day Collection,Economy Bulky,Economy Bulky Marketplace,Economy Delivery,Economy Marketplace Delivery,Express Collection,Fulfillment Pickup,Groceries Delivery,Groceries Delivery Collection,MP Crossdock(IDMY),MP Direct Selling,MP Package Free,Marketplace,Marketplace 2DD,Marketplace 3PL Locker,Marketplace Air Freight,Marketplace Air Haul,Marketplace Collection,Marketplace Inhouse Locker,Marketplace Next Day,Marketplace Next Day Collection,Marketplace Same Day,NS Economy,NS Marketplace Collection,NS Marketplace Standard,NS Reverse Logistics,NS Trucking FTL,NS Trucking LTL,Premium Express,Reverse Bulky,SPX Domestic Economy,SPX Eco-Friendly Collection,SPX Eco-Friendly Marketplace Collection,SPX Liquidation,SPX Point-to-Point Delivery,SPX Reverse Logistics,SPX Reverse Logistics Collection,SPX Reverse Logistics Locker,SPX Standard,SPX Standard Collection,SPX Standard Locker,SPX Standard Marketplace,SPX Standard Marketplace Collection,SPX Warehouse Return,Shopee Choice HD Instant,Shopee Choice HD Next Day,Shopee Choice Same Day Collection,Shopee Choice Standard Collection,Shopee Xpress,Shopee Xpress Air Freight,Shopee Xpress Collection,Shopee Xpress Same Day,Standard Economy,Standard Express,Standard Express 3PL Locker,Standard Express Collection,Standard Express Inhouse Locker,Standard Seashipping,WHS Direct Selling,WHS RR Local RTB,WHS Stock Transfer,Warehouse 2DD,Warehouse 3PL Locker,Warehouse Inhouse Locker,Warehouse Next Day,Warehouse Next Day Collection';

function isPendingReturnsRunStale(state) {
  return !!state.running &&
    Number(state.lastRunAt || 0) > 0 &&
    (Date.now() - Number(state.lastRunAt || 0)) > PENDING_RETURNS_MAX_RUNNING_MS;
}

async function getPendingReturnsState() {
  const obj = await chrome.storage.local.get(['spxPendingReturnsState']);
  const state = obj.spxPendingReturnsState || {};

  return {
    enabled: state.enabled !== false,
    running: !!state.running,
    lastStatus: state.lastStatus || 'Automação ativa.',
    lastRunAt: Number(state.lastRunAt || 0),
    nextRunAt: Number(state.nextRunAt || 0),
    lastOrders: Number(state.lastOrders || 0),
    lastTaskId: String(state.lastTaskId || ''),
    lastFileName: String(state.lastFileName || ''),
    lastErrors: Number(state.lastErrors || 0),
    lastHeaders: Array.isArray(state.lastHeaders) ? state.lastHeaders : [],
    lastRows: Array.isArray(state.lastRows) ? state.lastRows : []
  };
}

async function setPendingReturnsState(patch) {
  const current = await getPendingReturnsState();
  const next = { ...current, ...(patch || {}) };
  await chrome.storage.local.set({ spxPendingReturnsState: next });
  return next;
}

async function ensurePendingReturnsAlarm() {
  const state = await getPendingReturnsState();
  await chrome.alarms.clear(PENDING_RETURNS_ALARM_NAME);
  if (!state.enabled) return;

  const when = Date.now() + PENDING_RETURNS_INTERVAL_MINUTES * 60 * 1000;
  await chrome.alarms.create(PENDING_RETURNS_ALARM_NAME, { when });
  await setPendingReturnsState({ nextRunAt: when });
}

function parsePendingReturnsCsv(csvText) {
  const text = String(csvText || '').replace(/^\uFEFF/, '');
  const matrix = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell.replace(/\r$/, ''));
      if (row.some(value => String(value || '').trim() !== '')) matrix.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  row.push(cell.replace(/\r$/, ''));
  if (row.some(value => String(value || '').trim() !== '')) matrix.push(row);

  if (!matrix.length) {
    throw new Error('CSV de Devoluções Pendentes vazio.');
  }

  const headers = matrix[0].map((value, index) => {
    const name = String(value || '').replace(/^\uFEFF/, '').trim();
    return name || `col_${index + 1}`;
  });

  const rows = matrix.slice(1).map(source => {
    const out = new Array(headers.length).fill('');
    for (let i = 0; i < headers.length; i += 1) {
      out[i] = source[i] === undefined || source[i] === null ? '' : source[i];
    }
    return out;
  });

  return { headers, rows };
}

function pendingReturnsSpxRunner(payload) {
  return (async () => {
    const exportEndpoint = 'https://spx.shopee.com.br/api/in-station/uni_receive/on_hold/list/export';
    const taskListEndpoint = 'https://spx.shopee.com.br/spxdata/api/export_platform/export_task/list_for_portal';
    const downloadPrefix = 'https://spx.shopee.com.br/shopee-live-spx-temp-data/';
    const lookbackDays = Math.max(1, Math.min(90, Number(payload?.lookbackDays) || 30));
    const pollMs = Math.max(1000, Number(payload?.pollMs) || 3000);
    const maxPolls = Math.max(1, Math.min(80, Number(payload?.maxPolls) || 40));
    const orderAccounts = String(payload?.orderAccounts || '');
    const orderAccountNames = String(payload?.orderAccountNames || '');

    function sleepMs(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    function getCookie(name) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : '';
    }

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    function formatLocalDateTime(date) {
      return [
        date.getFullYear(),
        pad2(date.getMonth() + 1),
        pad2(date.getDate())
      ].join('-') + ' 00:00:00';
    }

    function getDateRange(days) {
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - days, 0, 0, 0, 0);

      return {
        startEpoch: Math.floor(start.getTime() / 1000),
        endEpoch: Math.floor(end.getTime() / 1000),
        startText: formatLocalDateTime(start),
        endText: formatLocalDateTime(end)
      };
    }

    async function fetchJson(url, options = {}) {
      const csrftoken = getCookie('csrftoken');
      const deviceId = getCookie('spx-admin-device-id');
      const response = await window.fetch(url, {
        credentials: 'include',
        redirect: 'follow',
        ...options,
        headers: {
          accept: 'application/json, text/plain, */*',
          app: 'FMS Portal',
          ...(deviceId ? { 'device-id': deviceId } : {}),
          ...(csrftoken ? { 'x-csrftoken': csrftoken } : {}),
          ...(options.headers || {})
        }
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (err) {
        throw new Error('Resposta JSON inválida: ' + text.slice(0, 220));
      }

      if (json && json.is_login === false) {
        throw new Error('SPX retornou is_login:false.');
      }

      if (typeof json?.retcode !== 'undefined' && Number(json.retcode) !== 0) {
        throw new Error(`retcode ${json.retcode}: ${json.message || ''}`);
      }

      return json;
    }

    const range = getDateRange(lookbackDays);
    const formatCondition = [
      'Status= Pending Receive',
      `Order Account= ${orderAccountNames}`,
      'Bulky Type= Bulky,N/A,Non-Bulky',
      `Created Date= ${range.startText},${range.endText}`
    ].join('; ');

    const createResponse = await fetchJson(exportEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=UTF-8'
      },
      body: JSON.stringify({
        status: '1',
        tracking_status: '1',
        bulky_type: '1,0,2',
        order_account: orderAccounts,
        ctime: `${range.startEpoch},${range.endEpoch}`,
        type: 1,
        format_condition: formatCondition
      })
    });

    const taskId = String(createResponse?.data?.task_id || createResponse?.data?.fms_task_id || '').trim();
    if (!taskId) {
      throw new Error('A SPX não retornou o task_id da exportação.');
    }

    const startTime = Math.max(0, Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60);
    let task = null;

    for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
      const listUrl = `${taskListEndpoint}?start_time=${startTime}&count=20&pageno=1`;
      const listResponse = await fetchJson(listUrl, { method: 'GET' });
      const taskList = Array.isArray(listResponse?.data?.task_list) ? listResponse.data.task_list : [];
      task = taskList.find(item => String(item?.task_id || '').trim() === taskId) || null;

      if (task) {
        const status = Number(task.export_status || 0);

        if (status === 2 && task.file_name) break;

        if (status === 3 || status === 4) {
          throw new Error(task.failed_reason || `Exportação ${taskId} falhou com status ${status}.`);
        }
      }

      if (attempt < maxPolls) await sleepMs(pollMs);
    }

    if (!task || Number(task.export_status || 0) !== 2 || !task.file_name) {
      throw new Error(`A exportação ${taskId} não ficou pronta dentro do limite de espera.`);
    }

    const rawFileName = String(task.file_name || '').trim();
    const mediaId = String(task.media_id || '').trim() || rawFileName.replace(/^mms:\/\//i, '').trim();

    // O novo fluxo de exportação pode retornar um URI interno mms:// em vez de uma URL HTTP.
    // Esse arquivo precisa ser resolvido/baixado pelo service worker da extensão, fora do MAIN world,
    // para evitar CORS e permitir seguir o redirecionamento para a URL assinada da Shopee.
    if (/^mms:\/\//i.test(rawFileName)) {
      return {
        ok: true,
        csvText: '',
        externalDownload: {
          type: 'mms',
          mediaId
        },
        task: {
          task_id: task.task_id,
          station_id: task.station_id,
          station_name: task.station_name,
          user_name: task.user_name,
          file_name: rawFileName,
          media_id: mediaId,
          is_mms_gray: task.is_mms_gray,
          export_status: task.export_status,
          ctime: task.ctime,
          mtime: task.mtime
        },
        range: {
          start: range.startText,
          end: range.endText
        }
      };
    }

    let downloadUrl = rawFileName;

    // A SPX pode retornar o próprio link assinado do arquivo em file_name.
    // Nesses casos, não devemos prefixar a URL com spx.shopee.com.br.
    if (!/^https?:\/\//i.test(downloadUrl)) {
      const normalizedFileName = rawFileName.replace(/^\/+/, '');
      downloadUrl = rawFileName.startsWith('/')
        ? `https://spx.shopee.com.br${rawFileName}`
        : downloadPrefix + normalizedFileName;
    }

    let fileName = rawFileName;
    if (/^https?:\/\//i.test(rawFileName)) {
      try {
        const parsedUrl = new URL(rawFileName);
        const disposition = parsedUrl.searchParams.get('response-content-disposition') || '';
        const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        const regularMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
        const encodedName = utf8Match?.[1] || regularMatch?.[1] || '';
        fileName = encodedName ? decodeURIComponent(encodedName) : rawFileName;
      } catch (_) {
        fileName = rawFileName;
      }
    }

    const csvResponse = await window.fetch(downloadUrl, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow'
    });

    const csvText = await csvResponse.text();

    if (!csvResponse.ok) {
      throw new Error(`Falha ao baixar CSV: HTTP ${csvResponse.status}. URL: ${downloadUrl}`);
    }

    if (!String(csvText || '').trim()) {
      throw new Error('O arquivo CSV exportado está vazio.');
    }

    if (/^\s*<!doctype html/i.test(csvText) || /^\s*<html/i.test(csvText)) {
      throw new Error('A SPX retornou HTML no lugar do CSV.');
    }

    return {
      ok: true,
      csvText,
      task: {
        task_id: task.task_id,
        station_id: task.station_id,
        station_name: task.station_name,
        user_name: task.user_name,
        file_name: fileName,
        export_status: task.export_status,
        ctime: task.ctime,
        mtime: task.mtime,
        download_url: downloadUrl
      },
      range: {
        ctime: `${range.startEpoch},${range.endEpoch}`,
        start: range.startText,
        end: range.endText
      }
    };
  })().catch(err => ({ ok: false, error: String(err?.message || err) }));
}

function resolvePendingReturnsMmsUrl(mediaId) {
  const cleanMediaId = String(mediaId || '').replace(/^mms:\/\//i, '').trim();
  if (!cleanMediaId) {
    throw new Error('A exportação MMS não retornou media_id.');
  }

  const accountMatch = cleanMediaId.match(/^[a-z]{2}-(\d+)-/i);
  if (!accountMatch) {
    throw new Error(`Formato de media_id MMS não reconhecido: ${cleanMediaId}`);
  }

  return `https://mms.file.susercontent.com/api/v4/${accountMatch[1]}/mms/${encodeURIComponent(cleanMediaId)}`;
}

function getPendingReturnsDownloadFileName(response, fallback) {
  const disposition = String(response?.headers?.get('content-disposition') || '');
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const regularMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
  const encodedName = utf8Match?.[1] || regularMatch?.[1] || '';

  if (encodedName) {
    try {
      return decodeURIComponent(encodedName);
    } catch (_) {
      return encodedName;
    }
  }

  try {
    const finalUrl = new URL(response?.url || '');
    const queryDisposition = finalUrl.searchParams.get('response-content-disposition') || '';
    const queryUtf8Match = queryDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    const queryRegularMatch = queryDisposition.match(/filename=\"?([^\";]+)\"?/i);
    const queryName = queryUtf8Match?.[1] || queryRegularMatch?.[1] || '';
    if (queryName) return decodeURIComponent(queryName);
  } catch (_) {}

  return fallback || 'export_onHold_order_list.csv';
}

async function downloadPendingReturnsMmsCsv(mediaId) {
  const resolverUrl = resolvePendingReturnsMmsUrl(mediaId);
  const response = await fetch(resolverUrl, {
    method: 'GET',
    redirect: 'follow',
    credentials: 'omit'
  });

  const csvText = await response.text();

  if (!response.ok) {
    throw new Error(`Falha ao baixar CSV MMS: HTTP ${response.status}. URL: ${response.url || resolverUrl}`);
  }

  if (!String(csvText || '').trim()) {
    throw new Error('O arquivo CSV MMS exportado está vazio.');
  }

  if (/^\s*<!doctype html/i.test(csvText) || /^\s*<html/i.test(csvText)) {
    throw new Error(`A Shopee retornou HTML no lugar do CSV MMS. URL: ${response.url || resolverUrl}`);
  }

  return {
    csvText,
    downloadUrl: response.url || resolverUrl,
    fileName: getPendingReturnsDownloadFileName(response, `${String(mediaId || '').replace(/^mms:\/\//i, '')}.csv`)
  };
}

async function executePendingReturnsRunnerWithRetry(tabId, payload) {
  let lastErr;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const injected = await withTimeout(chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: pendingReturnsSpxRunner,
        args: [payload]
      }), PENDING_RETURNS_MAX_RUNNING_MS, 'Tempo limite da coleta de Devoluções Pendentes excedido.');

      const result = injected?.[0]?.result;
      if (!result?.ok) {
        throw new Error(result?.error || 'Falha ao exportar Devoluções Pendentes na SPX.');
      }

      if (result?.externalDownload?.type === 'mms') {
        const downloaded = await downloadPendingReturnsMmsCsv(result.externalDownload.mediaId);
        result.csvText = downloaded.csvText;
        result.task = {
          ...(result.task || {}),
          file_name: downloaded.fileName || result.task?.file_name,
          media_id: result.externalDownload.mediaId,
          download_url: downloaded.downloadUrl
        };
      }

      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransientChromePortError(err) || attempt === 3) break;
      await sleep(1200 * attempt);
    }
  }

  throw new Error(normalizeChromeExecutionError(lastErr));
}

async function findReadySpxTabForPendingReturns() {
  const tabs = await chrome.tabs.query({ url: 'https://spx.shopee.com.br/*' });
  const candidates = tabs
    .filter(tab => tab?.id && String(tab.url || '').startsWith('https://spx.shopee.com.br/'))
    .sort((a, b) => Number(b.active || false) - Number(a.active || false));

  return candidates.find(tab => tab.status === 'complete') || candidates[0] || null;
}

async function runPendingReturnsFlow(source = 'alarm') {
  let state = await getPendingReturnsState();
  const busyObj = await chrome.storage.local.get(['spxToolkitBusy']);
  const busy = busyObj.spxToolkitBusy || {};

  if (!state.enabled) return { skipped: true, reason: 'Automação desativada.' };

  if (isPendingReturnsRunStale(state)) {
    state = await setPendingReturnsState({
      running: false,
      lastStatus: 'Execução anterior expirou e foi liberada.'
    });
  }

  if (state.running) return { skipped: true, reason: 'Automação já está rodando.' };

  if (busy.running) {
    await setPendingReturnsState({
      lastStatus: `Ignorado: ${busy.scope || 'extensão'} em execução.`,
      nextRunAt: Date.now() + PENDING_RETURNS_INTERVAL_MINUTES * 60 * 1000
    });
    return { skipped: true, reason: 'Extensão ocupada.' };
  }

  if (!PENDING_RETURNS_SYNC_ENDPOINT || !/^https?:\/\//i.test(PENDING_RETURNS_SYNC_ENDPOINT)) {
    throw new Error('Endpoint da planilha de Conferência não está configurado.');
  }

  await setPendingReturnsState({
    running: true,
    lastStatus: 'Solicitando exportação de Devoluções Pendentes...',
    lastRunAt: Date.now()
  });

  try {
    const tab = await findReadySpxTabForPendingReturns();

    if (!tab?.id) {
      throw new Error('Nenhuma aba SPX encontrada. Abra a SPX logada em uma aba.');
    }

    if (tab.status !== 'complete') {
      throw new Error('A aba SPX ainda está carregando. A próxima execução tentará novamente.');
    }

    const result = await executePendingReturnsRunnerWithRetry(tab.id, {
      lookbackDays: PENDING_RETURNS_EXPORT_LOOKBACK_DAYS,
      pollMs: PENDING_RETURNS_EXPORT_POLL_MS,
      maxPolls: PENDING_RETURNS_EXPORT_MAX_POLLS,
      orderAccounts: PENDING_RETURNS_ORDER_ACCOUNTS,
      orderAccountNames: PENDING_RETURNS_ORDER_ACCOUNT_NAMES
    });

    await setPendingReturnsState({
      lastStatus: `Exportação ${result.task?.task_id || ''} pronta. Enviando para a planilha...`
    });

    const parsed = parsePendingReturnsCsv(result.csvText);
    const postResponse = await requestJson(PENDING_RETURNS_SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        sheetName: 'Devoluções Pendentes',
        importType: 'PendingReturns',
        csvText: result.csvText,
        task: result.task
      }),
      timeoutMs: 3 * 60 * 1000
    });

    if (postResponse && postResponse.ok === false) {
      throw new Error(postResponse.error || 'Apps Script retornou falha.');
    }

    const importResult = Array.isArray(postResponse?.results)
      ? postResponse.results.find(item => item?.sheetName === 'Devoluções Pendentes') || postResponse.results[0]
      : postResponse;

    const orders = Number(importResult?.inserted ?? parsed.rows.length ?? 0);
    const taskId = String(result.task?.task_id || '');
    const fileName = String(result.task?.file_name || '');

    await setPendingReturnsState({
      running: false,
      lastStatus: `Auto concluído • ${orders} pedido(s) • aba substituída • tarefa ${taskId}.`,
      lastOrders: orders,
      lastTaskId: taskId,
      lastFileName: fileName,
      lastErrors: 0,
      lastHeaders: parsed.headers,
      lastRows: parsed.rows,
      nextRunAt: Date.now() + PENDING_RETURNS_INTERVAL_MINUTES * 60 * 1000
    });

    return {
      ok: true,
      orders,
      taskId,
      fileName
    };
  } catch (err) {
    await setPendingReturnsState({
      running: false,
      lastStatus: 'Erro no auto: ' + String(err?.message || err),
      lastErrors: Number(state.lastErrors || 0) + 1,
      nextRunAt: Date.now() + PENDING_RETURNS_INTERVAL_MINUTES * 60 * 1000
    });

    return { ok: false, error: String(err?.message || err) };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensurePendingReturnsAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensurePendingReturnsAlarm().catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === PENDING_RETURNS_ALARM_NAME) {
    runPendingReturnsFlow('alarm').finally(() => ensurePendingReturnsAlarm().catch(() => {}));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'PENDING_RETURNS_STATUS') {
    (async () => {
      try {
        let state = await getPendingReturnsState();

        if (isPendingReturnsRunStale(state)) {
          state = await setPendingReturnsState({
            running: false,
            lastStatus: 'Execução anterior expirou e foi liberada.',
            nextRunAt: Date.now() + PENDING_RETURNS_INTERVAL_MINUTES * 60 * 1000
          });
          await ensurePendingReturnsAlarm();
        }

        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();

    return true;
  }

  if (msg.type === 'PENDING_RETURNS_SET_ENABLED') {
    (async () => {
      try {
        const enabled = !!msg.enabled;
        const patch = {
          enabled,
          lastStatus: enabled ? 'Automação ativa.' : 'Automação desativada.'
        };

        if (enabled) {
          patch.nextRunAt = Date.now() + PENDING_RETURNS_INTERVAL_MINUTES * 60 * 1000;
        }

        const state = await setPendingReturnsState(patch);
        await ensurePendingReturnsAlarm();
        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();

    return true;
  }

  if (msg.type === 'PENDING_RETURNS_RUN_NOW') {
    (async () => {
      try {
        const data = await runPendingReturnsFlow('manual-message');
        await ensurePendingReturnsAlarm();
        sendResponse({ ok: true, data });
      } catch (err) {
        await ensurePendingReturnsAlarm().catch(() => {});
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();

    return true;
  }

  if (msg.type === 'PENDING_RETURNS_CLEAR_RESULTS') {
    (async () => {
      try {
        const state = await setPendingReturnsState({
          lastOrders: 0,
          lastTaskId: '',
          lastFileName: '',
          lastErrors: 0,
          lastHeaders: [],
          lastRows: [],
          lastStatus: 'Resultado limpo.'
        });

        sendResponse({ ok: true, data: state });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();

    return true;
  }
});
