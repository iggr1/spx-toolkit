const ACTIONS = [
  'NOME DO PRODUTO',
  'ULTIMO STATUS',
  'ULTIMA AT DO PEDIDO',
  'MOTIVO DO ULTIMO ON HOLD',
  'ESTACAO DE DESTINO',
  'CIDADE DE DESTINO',
  'RECEBEDORES',
  'HISTORICO DE ESTACOES',
  'AGING DOS PEDIDOS'
];

const $ = id => document.getElementById(id);
const SHEET_ENDPOINT = 'https://script.google.com/a/macros/shopee.com/s/AKfycbwOgrYhn4WkEEsjBE_Q4YUVrRxvH_gh2cPUyQg24DgPOsWJamCgOJdi5X80oTUkF7a-4A/exec';
const AVARIAS_ENDPOINT = 'https://script.google.com/a/macros/shopee.com/s/AKfycbxEoPu2cpB498v1BVGIKdxIBwRcGFt2JJX1rkz7eWNOCkKMdPSO06SGnedGh8o7c-mJ/exec';
const PROGRESS_MESSAGE_TYPE = 'SPX_TOOLKIT_PROGRESS';

let lastRows = [];
let lastHeaders = ['BR', 'RESULTADO'];
let lastReportRows = [];
let lastReportHeaders = [];
let lastReportName = '';
let lastSheetReportUrl = '';
let lastSpxActionHeaders = ['Pedido', 'Última AT', 'Ação', 'Resultado'];
let lastSpxActionRows = [];
let lastAvariasHeaders = ['SPX TN', 'ITEM/PRODUTO', 'STATUS SPX', 'RETORNO'];
let lastAvariasRows = [];
let spxTabId = null;
let running = false;
let currentRunId = '';
let currentRunScope = '';
let currentFunctionErrors = 0;
let lastReportTaskType = '';
let lastReportTasks = [];
let loadingReportTasks = false;
let reportTaskLoadSeq = 0;

const AVARIAS_AUTO_INTERVAL_MS = 10 * 60 * 1000;
let avariasAutoTimer = null;
let lastAvariasAutoState = null;

async function setToolkitBusy(scope, isRunning) {
  try {
    await chrome.storage.local.set({
      spxToolkitBusy: {
        running: !!isRunning,
        scope: isRunning ? scope : '',
        updatedAt: Date.now()
      }
    });
  } catch (e) {}
}

ACTIONS.forEach(a => {
  const o = document.createElement('option');
  o.value = a;
  o.textContent = a;
  $('action').appendChild(o);
});

document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tabPage').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  $(btn.dataset.tab).classList.add('active');
  document.body.dataset.activeTab = btn.dataset.tab || 'spxActions';
}));

document.body.dataset.activeTab = 'spxActions';

function applyTheme(theme) {
  const nextTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem('spxToolkitTheme', nextTheme);
  const text = $('themeToggleText');
  if (text) text.textContent = nextTheme === 'light' ? 'Tema claro' : 'Tema escuro';
}

applyTheme(localStorage.getItem('spxToolkitTheme') || 'dark');
if ($('themeToggle')) {
  $('themeToggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    applyTheme(current === 'light' ? 'dark' : 'light');
  });
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function splitCodes(text) {
  return String(text || '')
    .split(/[,\n;\t\r ]+/g)
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);
}

function parseBRs(text) {
  const seen = new Set();
  const out = [];
  splitCodes(text).forEach(x => {
    if (/^BR[0-9A-Z]{13}$/i.test(x) && !seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  });
  return out;
}

function parseByRx(text, rx) {
  const seen = new Set();
  const out = [];
  splitCodes(text).forEach(x => {
    if (rx.test(x) && !seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  });
  return out;
}

function setSite(ok, text, url = '') {
  $('siteDot').className = 'dot ' + (ok ? 'ok' : 'err');
  $('siteStatus').textContent = text;
  $('siteUrl').textContent = url || 'Abra uma aba da SPX para iniciar';
}

async function findSpxTab() {
  const tabs = await chrome.tabs.query({ url: 'https://spx.shopee.com.br/*' });
  const active = tabs.find(t => t.active) || tabs[0];
  spxTabId = active ? active.id : null;
  if (active) setSite(true, 'Aba SPX encontrada', active.url || 'https://spx.shopee.com.br/');
  else setSite(false, 'Nenhuma aba SPX encontrada');
  return active;
}

function esc(v) {
  return String(v == null ? '' : v);
}

function renderTable(theadId, tbodyId, headers, rows) {
  const th = $(theadId);
  const tb = $(tbodyId);
  th.innerHTML = '<tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>';
  tb.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    headers.forEach((_, i) => {
      const td = document.createElement('td');
      td.textContent = esc(r[i]);
      if (String(td.textContent).startsWith('❌')) td.className = 'errText';
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
}

function setSpxActionProgress(done, total, text = '') {
  const safeTotal = Math.max(Number(total) || 0, Number(done) || 0);
  const pct = safeTotal ? Math.round((done * 100) / safeTotal) : 0;
  if ($('spxActionBarFill')) $('spxActionBarFill').style.width = pct + '%';
  if ($('spxActionDoneCount')) $('spxActionDoneCount').textContent = String(done || 0);
  if ($('spxActionProgress')) $('spxActionProgress').textContent = text || (safeTotal ? `${done}/${safeTotal} processados` : 'Aguardando execução.');
}

function resetSpxActionUi() {
  lastSpxActionRows = [];
  renderTable('spxActionThead', 'spxActionTbody', lastSpxActionHeaders, []);
  if ($('spxActionValidCount')) $('spxActionValidCount').textContent = '0';
  if ($('spxActionDoneCount')) $('spxActionDoneCount').textContent = '0';
  if ($('spxActionErrCount')) $('spxActionErrCount').textContent = '0';
  setSpxActionProgress(0, 0, 'Aguardando execução.');
}

function beginSpxActionRun(total) {
  lastSpxActionHeaders = ['Pedido', 'Última AT', 'Ação', 'Resultado'];
  lastSpxActionRows = [];
  renderTable('spxActionThead', 'spxActionTbody', lastSpxActionHeaders, []);
  if ($('spxActionErrCount')) $('spxActionErrCount').textContent = '0';
  setSpxActionProgress(0, total, total ? `0/${total} processados` : 'Preparando ação...');
}

function appendSpxActionRows(rows) {
  if (!rows?.length) return;
  lastSpxActionRows.push(...rows);
  renderTable('spxActionThead', 'spxActionTbody', lastSpxActionHeaders, lastSpxActionRows);
  const errors = lastSpxActionRows.filter(r => String(r?.[3] || '').startsWith('❌')).length;
  if ($('spxActionErrCount')) $('spxActionErrCount').textContent = String(errors);
}

function renderFunctionTables(rows) {
  const inputRows = rows.map(r => [r[0] ?? '']);
  const outputRows = rows.map(r => [r[1] ?? '']);
  renderTable('inputThead', 'inputTbody', ['BR'], inputRows);
  renderTable('outputThead', 'outputTbody', ['Resultado'], outputRows);
}

function clearFunctionTables() {
  renderFunctionTables([]);
}

function getFunctionOutputRows(rows) {
  return rows.map(r => [r[1] ?? '']);
}

function toTsv(headers, rows) {
  return [
    headers.join('\t'),
    ...rows.map(r => headers.map((_, i) => esc(r[i]).replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t'))
  ].join('\n');
}

function toCsv(headers, rows) {
  const q = v => '"' + esc(v).replace(/"/g, '""') + '"';
  return [headers.map(q).join(','), ...rows.map(r => headers.map((_, i) => q(r[i])).join(','))].join('\n');
}

function downloadCsv(name, headers, rows) {
  const blob = new Blob(['\ufeff' + toCsv(headers, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyRows(headers, rows, includeHeader = true) {
  const text = includeHeader
    ? toTsv(headers, rows)
    : rows.map(r => r.map(v => esc(v).replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t')).join('\n');
  await navigator.clipboard.writeText(text);
  toast('Copiado.');
}

function getProgressEvery() {
  return 5;
}

function getConcurrency() {
  return 3;
}

function newRunId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function setProgress(done, total, report = false, text = '') {
  const safeTotal = Math.max(Number(total) || 0, Number(done) || 0);
  const pct = safeTotal ? Math.round((done * 100) / safeTotal) : 0;
  $(report ? 'reportBarFill' : 'barFill').style.width = pct + '%';

  if (report) {
    $('reportProgress').textContent = text || (safeTotal ? `${done}/${safeTotal} processados` : 'Executando...');
    return;
  }

  $('doneCount').textContent = String(done || 0);
  $('progressText').textContent = text || (safeTotal ? `${done}/${safeTotal} processados` : 'Aguardando execução.');
}

function beginFunctionRun(runId, total) {
  currentRunId = runId;
  currentRunScope = 'function';
  currentFunctionErrors = 0;
  lastHeaders = ['BR', 'RESULTADO'];
  lastRows = [];
  $('errCount').textContent = '0';
  clearFunctionTables();
  setProgress(0, total, false, total ? `0/${total} processados` : 'Preparando consulta...');
}

function appendFunctionRows(rows) {
  if (!rows?.length) return;
  lastRows.push(...rows);
  renderFunctionTables(lastRows);
  currentFunctionErrors = lastRows.filter(r => String(r?.[1] || '').startsWith('❌')).length;
  $('errCount').textContent = String(currentFunctionErrors);
}

function beginReportRun(runId, headers = [], name = '') {
  currentRunId = runId;
  currentRunScope = 'report';
  lastReportRows = [];
  lastReportHeaders = headers || [];
  lastReportName = name || '';
  setReportLink('');
  renderTable('reportThead', 'reportTbody', lastReportHeaders, []);
  $('reportTitle').textContent = name || 'Relatório';
  setProgress(0, 0, true, 'Preparando relatório...');
}

function appendReportRows(rows) {
  if (!rows?.length) return;
  lastReportRows.push(...rows);
  if (lastReportHeaders.length) {
    renderTable('reportThead', 'reportTbody', lastReportHeaders, lastReportRows);
  }
}

function handleProgressMessage(msg) {
  if (!msg || msg.type !== PROGRESS_MESSAGE_TYPE) return;
  if (!running) return;
  if (!msg.runId || msg.runId !== currentRunId) return;

  if (msg.scope === 'function') {
    if (msg.phase === 'start') {
      beginFunctionRun(msg.runId, msg.total || 0);
    }
    appendFunctionRows(msg.rows || []);
    setProgress(msg.done || lastRows.length, msg.total || lastRows.length, false, msg.text || '');
    if (typeof msg.errors === 'number') {
      $('errCount').textContent = String(msg.errors);
    }
    return;
  }

  if (msg.scope === 'spxAction') {
    if (msg.phase === 'start') {
      beginSpxActionRun(msg.total || 0);
    }
    appendSpxActionRows(msg.rows || []);
    setSpxActionProgress(msg.done || lastSpxActionRows.length, msg.total || lastSpxActionRows.length, msg.text || '');
    if (typeof msg.errors === 'number' && $('spxActionErrCount')) {
      $('spxActionErrCount').textContent = String(msg.errors);
    }
    return;
  }

  if (msg.scope === 'report') {
    if (msg.phase === 'start') {
      beginReportRun(msg.runId, msg.headers || lastReportHeaders, msg.name || lastReportName || 'Relatório');
    } else if (msg.headers?.length && !lastReportHeaders.length) {
      lastReportHeaders = msg.headers;
      renderTable('reportThead', 'reportTbody', lastReportHeaders, lastReportRows);
    }

    if (msg.name) {
      lastReportName = msg.name;
      $('reportTitle').textContent = msg.name;
    }

    appendReportRows(msg.rows || []);
    setProgress(msg.done || lastReportRows.length, msg.total || lastReportRows.length, true, msg.text || '');
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  handleProgressMessage(msg);
});

function spxRunner(payload) {
  return (async () => {
    const STATION_NAME = 'LM Hub_SC_Chapecó_Eldorado';
    const PROGRESS_TYPE = 'SPX_TOOLKIT_PROGRESS';
    const runId = String(payload?.runId || '');
    const progressEvery = Math.max(1, Number(payload?.progressEvery) || 5);
    const concurrency = Math.max(1, Math.min(5, Number(payload?.concurrency) || 3));

    const API = {
      trackingInfo: id => `https://spx.shopee.com.br/api/fleet_order/order/detail/tracking_info?shipment_id=${encodeURIComponent(id)}`,
      tradeInfo: id => `https://spx.shopee.com.br/api/fleet_order/order/detail/trade_info?shipment_id=${encodeURIComponent(id)}`,
      sensitive: (id, field, extra = '') => `https://spx.shopee.com.br/api/fleet_order/order/detail/show_sensitive_data?shipment_id=${encodeURIComponent(id)}&data_field=${encodeURIComponent(field)}${extra ? '&' + extra : ''}`,
      trackListSearch: () => 'https://spx.shopee.com.br/api/fleet_order/order/tracking_list/search',
      toOutboundOrderSearch: to => `https://spx.shopee.com.br/api/in-station/general_to/outbound/order/search?pageno=1&count=1000000&to_number=${encodeURIComponent(to)}`,
      parcelTaskSearch: ps => `https://spx.shopee.com.br/api/in-station/parcel/task/order/search?station_id=5264&pageno=1&count=100000&task_id=${encodeURIComponent(ps)}`,
      parcelTaskList: () => 'https://spx.shopee.com.br/api/in-station/parcel/v2/task/list?station_id=5264&pageno=1&count=24',
      auditTaskList: () => 'https://spx.shopee.com.br/api/in-station/lmhub/audit/task/list?page_no=1&count=24',
      auditTargetListByTask: vt => `https://spx.shopee.com.br/api/in-station/lmhub/audit/target/list?page_no=1&count=9999&task_id=${encodeURIComponent(vt)}`,
      auditParcelList: (vt, targetId, type, page, perPage, auditTargetType = 2) => type === 'missing'
        ? `https://spx.shopee.com.br/api/in-station/lmhub/audit/parcel/list?validation_task_id=${encodeURIComponent(vt)}&target_id=${encodeURIComponent(targetId)}&audit_target_type=${encodeURIComponent(auditTargetType)}&page_no=${page}&count=${perPage}&result=5&shipment_id=`
        : `https://spx.shopee.com.br/api/in-station/lmhub/audit/parcel/list?validation_task_id=${encodeURIComponent(vt)}&target_id=${encodeURIComponent(targetId)}&audit_target_type=${encodeURIComponent(auditTargetType)}&page_no=${page}&count=${perPage}&parcel_scan_status=2`,
      assignmentDetail: at => `https://spx.shopee.com.br/spx_delivery/admin/assignment/assignment_task/detail?assignment_task_id=${encodeURIComponent(at)}`,
      assignmentSearch: () => 'https://spx.shopee.com.br/spx_delivery/admin/assignment/assignment_task/search/v2',
      assignmentAddOrder: () => 'https://spx.shopee.com.br/spx_delivery/admin/assignment/assignment_task/add_order',
      assignmentRemoveOrder: () => 'https://spx.shopee.com.br/spx_delivery/admin/assignment/assignment_task/remove_order',
      auditTargetView: (vt, at) => `https://spx.shopee.com.br/api/in-station/lmhub/audit/target/view?validation_task_id=${encodeURIComponent(vt)}&target_id=${encodeURIComponent(at)}&audit_target_type=2`,
      auditTargetListByShipment: (vt, br) => `https://spx.shopee.com.br/api/in-station/lmhub/audit/target/list?shipment_id=${encodeURIComponent(br)}&task_id=${encodeURIComponent(vt)}&page_no=1&count=24`
    };

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function runPool(items, maxConcurrency, worker) {
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return [];
      const results = new Array(list.length);
      let cursor = 0;

      async function runner() {
        while (true) {
          const index = cursor++;
          if (index >= list.length) break;
          results[index] = await worker(list[index], index);
        }
      }

      const size = Math.max(1, Math.min(maxConcurrency || 1, list.length));
      await Promise.all(Array.from({ length: size }, () => runner()));
      return results;
    }

    function sendProgress(scope, data = {}) {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({
            type: PROGRESS_TYPE,
            runId,
            scope,
            ...data
          });
        }
      } catch (e) {}
    }

    function flushBatch(scope, state, force = false, text = '') {
      const safeTotal = Math.max(Number(state.total) || 0, Number(state.done) || 0);
      if (!force && (!state.batchRows || !state.batchRows.length)) return;
      sendProgress(scope, {
        phase: state.phase || 'progress',
        name: state.name || '',
        headers: state.headers || [],
        done: state.done || 0,
        total: safeTotal,
        errors: state.errors || 0,
        rows: (state.batchRows || []).splice(0),
        text
      });
    }

    function flattenTracking(arr) {
      return (arr || []).reduce((acc, n) => {
        acc.push(n);
        if (Array.isArray(n.children)) acc.push(...flattenTracking(n.children));
        return acc;
      }, []);
    }

    function formatEpoch(sec) {
      const n = Number(sec);
      if (!n || !isFinite(n)) return '';
      const d = new Date(n * 1000);
      return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    }

    function formatDate(sec) {
      const n = Number(sec);
      if (!n || !isFinite(n)) return '';
      const d = new Date(n * 1000);
      return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    }

    function formatDuration(seconds) {
      let s = Math.max(0, Math.floor(Number(seconds) || 0));
      const d = Math.floor(s / 86400);
      s -= d * 86400;
      const h = Math.floor(s / 3600);
      s -= h * 3600;
      const m = Math.floor(s / 60);
      return `${d}dias ${h}horas ${m}minutos`;
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

    async function postJson(url, body, headers = {}) {
      return getJson(url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers
      });
    }

    function readCookie(name) {
      const wanted = `${name}=`;
      return String(document.cookie || '')
        .split(';')
        .map(v => v.trim())
        .find(v => v.startsWith(wanted))
        ?.slice(wanted.length) || '';
    }

    function getSpxWriteHeaders() {
      const csrf = readCookie('csrftoken');
      const deviceId = readCookie('spx-admin-device-id') || readCookie('device-id');
      const headers = { app: 'FMS Portal' };
      if (csrf) headers['x-csrftoken'] = csrf;
      if (deviceId) headers['device-id'] = deviceId;
      return headers;
    }

    function okMessage(json, fallback = 'OK') {
      const message = String(json?.message || json?.msg || '').trim();
      return message || fallback;
    }

    const AVARIAS_STATUS_PRIORIDADE = [
      'Status DAMAGED [Colocar na Gaiola de Salvados - Status Finalizador]',
      'Pedido descartado',
      'Fraude - Offline Resolve',
      'Ticket Submitted'
    ];

    function normalizeText(v) {
      return String(v || '').replace(/\s+/g, ' ').trim();
    }

    async function lastStatus(br) {
      const j = await getJson(API.trackingInfo(br));
      const all = flattenTracking(j?.data?.tracking_list || []);
      if (!all.length) return '';
      const last = all.reduce((m, v) => Number(v.timestamp) > Number(m.timestamp) ? v : m, all[0]);
      return last.message || '';
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

    async function lastAssignment(br) {
      const j = await getJson(API.trackingInfo(br));
      const all = flattenTracking(j?.data?.tracking_list || []);
      const cand = all.filter(n => {
        const st = String(n.event_type || n.event_code || n.biz_code || n.status_text || '');
        const msg = String(n.message || '');
        return (/LMHub_Assign(?:ed|ing)/i.test(st) || /Pedido em processamento na Assignment Task/i.test(msg)) && /\[(AT[0-9A-Z]+)\]/i.test(msg);
      });
      if (!cand.length) return '❌ não encontrado';
      const last = cand.reduce((m, v) => Number(v.timestamp) > Number(m.timestamp) ? v : m, cand[0]);
      const m = String(last.message || '').match(/\[(AT[0-9A-Z]+)\]/i);
      return m ? m[1] : '❌ não encontrado';
    }

    function isAssignmentTaskId(v) {
      return /^AT[0-9A-Z]+$/i.test(String(v || '').trim());
    }

    async function addOrderToLastAssignment(br, at) {
      const json = await postJson(API.assignmentAddOrder(), {
        order_type: 1,
        assignment_task_id: at,
        shipment_id: br,
        business_id: br,
        need_pass: 1,
        new_flag: 2,
        is_relabel_later: false
      }, getSpxWriteHeaders());
      return okMessage(json, 'OK - adicionado');
    }

    async function removeOrderFromLastAssignment(br, at) {
      const json = await postJson(API.assignmentRemoveOrder(), {
        assignment_task_id: at,
        shipment_id: br,
        business_id: br,
        at_type: 1
      }, getSpxWriteHeaders());
      return okMessage(json, 'OK - removido');
    }

    function spxActionLabel(action) {
      if (action === 'ADD_LAST_AT') return 'Adicionar na última AT';
      if (action === 'REMOVE_LAST_AT') return 'Remover da última AT';
      return 'Ação';
    }

    async function lastOnHold(br) {
      const j = await getJson(API.trackingInfo(br));
      const all = flattenTracking(j?.data?.tracking_list || []);
      const hold = all.filter(n => typeof n.message === 'string' && /^\s*Pedido em espera\s*:/i.test(n.message));
      if (!hold.length) return '❌ não encontrado';
      const last = hold.reduce((m, v) => Number(v.timestamp) > Number(m.timestamp) ? v : m, hold[0]);
      const matches = String(last.message || '').match(/\[([^\]]+)\]/g);
      if (!matches?.length) return '❌ não encontrado';
      return matches[matches.length - 1].replace(/^\[|\]$/g, '').trim();
    }

    async function receiver(br) {
      const j = await getJson(API.trackingInfo(br));
      const all = flattenTracking(j?.data?.tracking_list || []).filter(n => n.status === 1);
      if (!all.length) return '❌ Sem recebimentos.';
      const last = all.reduce((m, v) => Number(v.timestamp) > Number(m.timestamp) ? v : m, all[0]);
      return last.operator === 'spx@shopee.com' ? 'backlog' : (last.operator || '');
    }

    async function history(br) {
      const j = await getJson(API.trackingInfo(br));
      const all = flattenTracking(j?.data?.tracking_list || []);
      all.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
      return all
        .map(n => n.station_name || '')
        .filter((s, i, arr) => s && (i === 0 || s !== arr[i - 1]))
        .join('   >   ');
    }

    async function aging(br) {
      const j = await getJson(API.trackingInfo(br));
      const all = flattenTracking(j?.data?.tracking_list || []);
      const hits = all.filter(n => String(n.station_name || '') === STATION_NAME && Number(n.timestamp));
      if (!hits.length) return '❌ sem registros na estação';
      let first = hits[0];
      let last = hits[0];
      for (const h of hits) {
        if (Number(h.timestamp) < Number(first.timestamp)) first = h;
        if (Number(h.timestamp) > Number(last.timestamp)) last = h;
      }
      return formatDuration(Number(last.timestamp) - Number(first.timestamp));
    }

    async function station(br) {
      const j = await postJson(API.trackListSearch(), { shipment_id: br, count: 24, page_no: 1 });
      const list = j?.data?.list || [];
      if (!list.length) return '❌ sem tracking';
      return list[0]?.station_name || '❌ sem station_name';
    }

    async function buyerCity(br) {
      const cityJ = await getJson(API.sensitive(br, 'buyer_addr_city'));
      const stateJ = await getJson(API.sensitive(br, 'buyer_addr_state'));
      const city = String(cityJ?.data?.data_detail || '').trim();
      const state = String(stateJ?.data?.data_detail || '').trim();
      if (city && state) return `${city} – ${state}`;
      if (city) return city;
      if (state) return state;
      return '❌ cidade/estado não encontrado';
    }

    async function skuName(br) {
      const trade = await getJson(API.tradeInfo(br));
      const sku = trade?.data?.sku_list?.[0]?.id;
      if (!sku) return '❌ nenhum SKU encontrado';
      const nameJ = await getJson(API.sensitive(br, 'name', `id=${encodeURIComponent(String(sku))}`));
      const name = String(nameJ?.data?.data_detail || '').trim();
      return name || '❌ resposta inesperada';
    }

    async function runOne(action, br) {
      if (action === 'NOME DO PRODUTO') return skuName(br);
      if (action === 'ULTIMO STATUS') return lastStatus(br);
      if (action === 'ULTIMA AT DO PEDIDO') return lastAssignment(br);
      if (action === 'MOTIVO DO ULTIMO ON HOLD') return lastOnHold(br);
      if (action === 'ESTACAO DE DESTINO') return station(br);
      if (action === 'CIDADE DE DESTINO') return buyerCity(br);
      if (action === 'RECEBEDORES') return receiver(br);
      if (action === 'HISTORICO DE ESTACOES') return history(br);
      if (action === 'AGING DOS PEDIDOS') return aging(br);
      return '❌ função não mapeada';
    }

    async function reportTos(tos) {
      const headers = ['TO', 'BR', 'station_name', 'third_party_sorting_code', 'status', 'receiver_name', 'ctime', 'mtime'];
      const rows = [];
      const state = { phase: 'start', name: 'BRs_por_TO', headers, done: 0, total: tos.length, batchRows: [], errors: 0 };
      sendProgress('report', { ...state, rows: [], text: `0/${tos.length} TOs consultadas` });
      state.phase = 'progress';

      await runPool(tos, concurrency, async (to) => {
        try {
          const j = await getJson(API.toOutboundOrderSearch(to));
          const list = Array.isArray(j?.data?.list) ? j.data.list : [];
          if (!list.length) {
            const row = [to, '', '', '', '', '', '', ''];
            rows.push(row);
            state.batchRows.push(row);
          }
          for (const it of list) {
            const br = it?.sls_tracking_number || it?.shipment_id || it?.fleet_order_id || '';
            const row = [
              to,
              String(br),
              it?.station_name || '',
              it?.third_party_sorting_code || '',
              typeof it?.status === 'number' ? it.status : (it?.status || ''),
              it?.receiver_name || '',
              formatEpoch(it?.ctime),
              formatEpoch(it?.mtime)
            ];
            rows.push(row);
            state.batchRows.push(row);
          }
        } catch (e) {
          const row = [to, '❌ ' + e.message, '', '', '', '', '', ''];
          rows.push(row);
          state.batchRows.push(row);
          state.errors += 1;
        }

        state.done += 1;
        if (state.done % progressEvery === 0 || state.done === state.total) {
          flushBatch('report', state, true, `${state.done}/${state.total} TOs consultadas • ${rows.length} linha(s)`);
        }
      });

      flushBatch('report', state, true, `Concluído • ${rows.length} linha(s)`);
      return { name: 'BRs_por_TO', headers, rows };
    }

    async function reportParcel(ps) {
      const headersStart = ['PS', 'ERRO'];
      sendProgress('report', {
        phase: 'start',
        name: 'relatorio_parcel',
        headers: headersStart,
        done: 0,
        total: 1,
        rows: [],
        text: `Consultando PS ${ps}...`
      });

      const j = await getJson(API.parcelTaskSearch(ps));
      const list = Array.isArray(j?.data?.list) ? j.data.list : [];
      if (!list.length) {
        const rows = [[ps, 'Nenhum parcel encontrado']];
        sendProgress('report', {
          phase: 'progress',
          name: 'relatorio_parcel',
          headers: headersStart,
          done: 1,
          total: 1,
          rows,
          text: 'Concluído • 1 linha'
        });
        return { name: 'relatorio_parcel', headers: headersStart, rows };
      }

      const keys = Object.keys(list[0]);
      const rows = list.map(it => keys.map(k => /time/i.test(k) && Number(it[k]) ? formatEpoch(it[k]) : (it[k] ?? '')));
      sendProgress('report', {
        phase: 'progress',
        name: 'relatorio_parcel',
        headers: keys,
        done: 1,
        total: 1,
        rows,
        text: `Concluído • ${rows.length} linha(s)`
      });
      return { name: 'relatorio_parcel', headers: keys, rows };
    }

    async function reportReturns(codes) {
      const headers = ['SPX TN', 'DATA', 'TO', 'LH'];
      const rows = [];
      const RX_MSG = /(?:Parcel\s+\[(TO[0-9A-Z]+)\]\s+added\s+into\s+LH\s+Task\s+\[([^\]]+)\])|(?:Parcel's\s+TO\s+\[(TO[0-9A-Z]+)\]\s+adding\s+into\s+LH\s+Task\s+\[([^\]]+)\])/i;
      const state = { phase: 'start', name: 'relatorio_returns', headers, done: 0, total: codes.length, batchRows: [], errors: 0 };

      sendProgress('report', { ...state, rows: [], text: `0/${codes.length} pedidos consultados` });
      state.phase = 'progress';

      await runPool(codes, concurrency, async (code) => {
        try {
          const j = await getJson(API.trackingInfo(code));
          const all = flattenTracking(j?.data?.tracking_list || []);
          const cand = all.filter(n => String(n.station_name || '') === STATION_NAME && RX_MSG.test(String(n.message || '')));
          if (!cand.length) {
            const row = [code, '', '', ''];
            rows.push(row);
            state.batchRows.push(row);
          } else {
            const last = cand.reduce((m, v) => Number(v.timestamp) > Number(m.timestamp) ? v : m, cand[0]);
            const m = String(last.message || '').match(RX_MSG);
            const row = [code, formatDate(last.timestamp), m ? (m[1] || m[3] || '') : '', m ? (m[2] || m[4] || '') : ''];
            rows.push(row);
            state.batchRows.push(row);
          }
        } catch (e) {
          const row = [code, '❌ ' + e.message, '', ''];
          rows.push(row);
          state.batchRows.push(row);
          state.errors += 1;
        }

        state.done += 1;
        if (state.done % progressEvery === 0 || state.done === state.total) {
          flushBatch('report', state, true, `${state.done}/${state.total} pedidos consultados • ${rows.length} linha(s)`);
        }
      });

      flushBatch('report', state, true, `Concluído • ${rows.length} linha(s)`);
      return { name: 'relatorio_returns', headers, rows };
    }

    async function reportConferencia(vts) {
      const headers = ['DATA_HORA', 'VT', 'AT', 'BR', 'ROTA_ENCONTRADA', 'ROTA_CORRETA', 'OPERADOR', 'DRIVER_ID', 'DRIVER_NAME', 'TIPO_DE_ERRO'];
      const rows = [];
      const assignmentCache = {};
      const targetViewCache = {};
      const correctRouteCache = {};

      const state = { phase: 'start', name: 'relatorio_final', headers, done: 0, total: 0, batchRows: [], errors: 0 };
      sendProgress('report', {
        ...state,
        rows: [],
        text: 'Mapeando targets Missing/Missort...'
      });
      state.phase = 'progress';

      async function routeFromAssignmentTask(atId) {
        if (!atId) return '';

        const key = `at:${String(atId)}`;

        if (typeof correctRouteCache[key] !== 'undefined') {
          return correctRouteCache[key];
        }

        try {
          const json = await postJson(
            API.assignmentSearch(),
            {
              assignment_task_id: atId,
              pageno: 1,
              count: 20,
              search_type: 0
            },
            {
              app: 'FMS Portal'
            }
          );

          correctRouteCache[key] = json?.data?.list?.[0]?.corridor_cage || '';
        } catch (e) {
          correctRouteCache[key] = '';
        }

        return correctRouteCache[key];
      }

      async function routeFromAuditTarget(vt, targetId) {
        if (!targetId) return '';

        const key = `target:${String(vt)}:${String(targetId)}`;

        if (typeof correctRouteCache[key] !== 'undefined') {
          return correctRouteCache[key];
        }

        let route = '';

        try {
          const view = (await getJson(API.auditTargetView(vt, targetId)))?.data || {};
          route = view.binding_entity || view.corridor_cage || view.route_name || '';
        } catch (e) {}

        if (!route) {
          route = await routeFromAssignmentTask(targetId);
        }

        correctRouteCache[key] = route || '';
        return correctRouteCache[key];
      }

      function pickRouteFromObject(obj) {
        if (!obj || typeof obj !== 'object') return '';

        const keys = [
          'correct_corridor_cage',
          'correct_route',
          'expected_route',
          'expected_corridor_cage',
          'should_be_route',
          'route_correct',
          'corridor_cage',
          'binding_entity'
        ];

        for (const key of keys) {
          const val = obj[key];
          if (val !== undefined && val !== null && String(val).trim()) return String(val).trim();
        }

        return '';
      }

      async function correctRoute(vt, br, currentAT, type, item = {}) {
        const key = `correct:${String(vt)}:${String(br)}:${String(currentAT)}:${String(type)}`;

        if (typeof correctRouteCache[key] !== 'undefined') {
          return correctRouteCache[key];
        }

        let route = '';

        if (type === 'missort' && br) {
          route = pickRouteFromObject(item);

          if (!route) {
            try {
              const json = await getJson(API.auditTargetListByShipment(vt, br));
              const list = json?.data?.list || [];
              const current = String(currentAT || '');
              const candidates = list.filter(t => String(t.target_id || t.assignment_task_id || '') !== current);

              const preferred =
                candidates.find(t => Number(t.missing_qty || 0) > 0) ||
                candidates.find(t => Number(t.missort_qty || 0) === 0) ||
                candidates[0] ||
                null;

              if (preferred) {
                route = pickRouteFromObject(preferred);
                if (!route) {
                  route = await routeFromAuditTarget(vt, preferred.target_id || preferred.assignment_task_id);
                }
              }
            } catch (e) {}
          }
        }

        if (!route) {
          route = await routeFromAssignmentTask(currentAT);
        }

        correctRouteCache[key] = route || '';
        return correctRouteCache[key];
      }

      const jobs = [];

      for (const vt of vts) {
        let targets = [];
        try {
          const tr = await getJson(API.auditTargetListByTask(vt));
          targets = (tr?.data?.list || []).filter(t => (t.missing_qty && t.missing_qty > 0) || (t.missort_qty && t.missort_qty > 0));
        } catch (e) {
          const row = ['', vt, '❌ ' + e.message, '', '', '', '', '', '', ''];
          rows.push(row);
          state.batchRows.push(row);
          state.errors += 1;
          flushBatch('report', state, true, `Falha ao mapear ${vt}`);
          continue;
        }

        for (const target of targets) {
          if (target.missing_qty > 0) {
            jobs.push({ vt, target, type: 'missing', estimated: Number(target.missing_qty) || 0 });
            state.total += Number(target.missing_qty) || 0;
          }
          if (target.missort_qty > 0) {
            jobs.push({ vt, target, type: 'missort', estimated: Number(target.missort_qty) || 0 });
            state.total += Number(target.missort_qty) || 0;
          }
        }

        sendProgress('report', {
          phase: 'progress',
          name: state.name,
          headers,
          done: state.done,
          total: Math.max(state.total, state.done),
          rows: [],
          text: `VT ${vt} mapeada • ${jobs.length} coleta(s) encontrada(s)`
        });
      }

      if (!jobs.length && !rows.length) {
        sendProgress('report', {
          phase: 'progress',
          name: state.name,
          headers,
          done: 0,
          total: 0,
          rows: [],
          text: 'Nenhum Missing/Missort encontrado para os VTs informados.'
        });
        return { name: 'relatorio_final', headers, rows };
      }

      await runPool(jobs, Math.min(concurrency, 3), async (job) => {
        const vt = job.vt;
        const target = job.target;
        const at = target.target_id;
        const auditType = target.audit_target_type || 2;

        if (!assignmentCache[at]) {
          try {
            assignmentCache[at] = (await getJson(API.assignmentDetail(at)))?.data || {};
          } catch (e) {
            assignmentCache[at] = {};
          }
        }

        if (!targetViewCache[at]) {
          try {
            targetViewCache[at] = (await getJson(API.auditTargetView(vt, at)))?.data || {};
          } catch (e) {
            targetViewCache[at] = {};
          }
        }

        const assign = assignmentCache[at] || {};
        const tv = targetViewCache[at] || {};

        sendProgress('report', {
          phase: 'progress',
          name: state.name,
          headers,
          done: state.done,
          total: Math.max(state.total, state.done),
          rows: [],
          text: `Coletando ${job.type} • VT ${vt} • AT ${at}`
        });

        try {
          let page = 1;
          let total = null;
          const perPage = 200;

          while (true) {
            const pr = await getJson(API.auditParcelList(vt, at, job.type, page, perPage, auditType));
            const data = pr?.data || {};

            if (total === null) {
              total = Number(data.total) || 0;
              if (!job.estimated && total > 0) {
                state.total += total;
              }
            }

            let list = data.list || [];
            if (job.type === 'missort') {
              list = list.filter(i => i.validation_status === 7);
            }

            for (const item of list) {
              const br = item.shipment_id || '';
              const row = [
                formatEpoch(assign.assigned_time),
                vt,
                at,
                br,
                tv.binding_entity || '',
                await correctRoute(vt, br, at, job.type, item),
                tv.validation_operator || '',
                assign.driver_id || '',
                assign.driver_name || '',
                job.type
              ];
              rows.push(row);
              state.batchRows.push(row);
              state.done += 1;

              if (state.done % progressEvery === 0 || state.done === state.total) {
                flushBatch(
                  'report',
                  state,
                  true,
                  `${state.done}/${Math.max(state.total, state.done)} itens coletados • ${job.type}`
                );
              }
            }

            if (!data.list?.length || page * perPage >= (total || 0)) break;
            page += 1;
            await sleep(90);
          }
        } catch (e) {
          const row = ['', vt, at, '❌ ' + e.message, '', '', '', '', '', job.type];
          rows.push(row);
          state.batchRows.push(row);
          state.errors += 1;
        }

        flushBatch(
          'report',
          state,
          true,
          `${state.done}/${Math.max(state.total, state.done)} itens coletados • ${rows.length} linha(s)`
        );
      });

      flushBatch('report', state, true, `Concluído • ${rows.length} linha(s)`);
      return { name: 'relatorio_final', headers, rows };
    }


    async function listReportTasks(reportType) {
      const type = String(reportType || '').toUpperCase();
      const url = type === 'PARCEL' ? API.parcelTaskList() : type === 'CONFERENCIA' ? API.auditTaskList() : '';
      if (!url) throw new Error('Lista de tarefas indisponível para esse relatório.');

      const json = await getJson(url);
      const list = Array.isArray(json?.data?.list) ? json.data.list : [];

      if (type === 'PARCEL') {
        const tasks = list
          .filter(it => it?.task_id)
          .map(it => ({
            id: String(it.task_id || ''),
            title: String(it.task_id || ''),
            date: String(it.date || ''),
            badge: String(it.expected_scanned_rate_str || (it.status ? `Status ${it.status}` : '')),
            detail: [
              it.date ? `Data ${it.date}` : '',
              it.start_time ? `Início ${formatEpoch(it.start_time)}` : '',
              it.end_time ? `Fim ${formatEpoch(it.end_time)}` : ''
            ].filter(Boolean).join(' • '),
            sub: ''
          }));
        return { ok: true, reportType: type, tasks };
      }

      const tasks = list
        .filter(it => it?.validation_task_id)
        .map(it => ({
          id: String(it.validation_task_id || ''),
          title: String(it.validation_task_id || ''),
          date: it.create_time ? formatDate(it.create_time) : '',
          badge: String(it.validated_target_qty_ratio || (it.task_status ? `Status ${it.task_status}` : '')),
          detail: [
            it.create_time ? `Criada ${formatEpoch(it.create_time)}` : '',
            it.end_time ? `Fim ${formatEpoch(it.end_time)}` : ''
          ].filter(Boolean).join(' • '),
          sub: ''
        }));

      return { ok: true, reportType: type, tasks };
    }

    if (payload.mode === 'spxAction') {
      const brs = Array.isArray(payload.brs) ? payload.brs : [];
      const action = String(payload.spxAction || '');
      const label = spxActionLabel(action);
      const rows = [];
      const state = {
        phase: 'start',
        headers: ['Pedido', 'Última AT', 'Ação', 'Resultado'],
        done: 0,
        total: brs.length,
        errors: 0,
        batchRows: []
      };

      sendProgress('spxAction', {
        ...state,
        rows: [],
        text: `0/${state.total} processados`
      });
      state.phase = 'progress';

      const orderedRows = new Array(brs.length);

      await runPool(brs, concurrency, async (br, index) => {
        let at = '';
        try {
          at = await lastAssignment(br);
          if (!isAssignmentTaskId(at)) throw new Error('Última AT não encontrada para este pedido.');

          let result;
          if (action === 'ADD_LAST_AT') result = await addOrderToLastAssignment(br, at);
          else if (action === 'REMOVE_LAST_AT') result = await removeOrderFromLastAssignment(br, at);
          else throw new Error('Ação inválida.');

          const row = [br, at, label, result];
          orderedRows[index] = row;
          state.batchRows.push(row);
        } catch (e) {
          const row = [br, at || '', label, '❌ ' + e.message];
          orderedRows[index] = row;
          state.batchRows.push(row);
          state.errors += 1;
        }

        state.done += 1;
        if (state.done % progressEvery === 0 || state.done === state.total) {
          flushBatch('spxAction', state, true, `${state.done}/${state.total} processados`);
        }
      });

      rows.push(...orderedRows.filter(Boolean));
      flushBatch('spxAction', state, true, `Concluído • ${rows.length}/${state.total}`);
      return { ok: true, headers: ['Pedido', 'Última AT', 'Ação', 'Resultado'], rows };
    }

    if (payload.mode === 'function') {
      const rows = [];
      const state = {
        phase: 'start',
        headers: ['BR', 'RESULTADO'],
        done: 0,
        total: payload.brs.length,
        errors: 0,
        batchRows: []
      };

      sendProgress('function', {
        ...state,
        rows: [],
        text: `0/${state.total} processados`
      });
      state.phase = 'progress';

      const orderedRows = new Array(payload.brs.length);

      await runPool(payload.brs, concurrency, async (br, index) => {
        try {
          const row = [br, await runOne(payload.action, br)];
          orderedRows[index] = row;
          state.batchRows.push(row);
        } catch (e) {
          const row = [br, '❌ ' + e.message];
          orderedRows[index] = row;
          state.batchRows.push(row);
          state.errors += 1;
        }

        state.done += 1;
        if (state.done % progressEvery === 0 || state.done === state.total) {
          flushBatch('function', state, true, `${state.done}/${state.total} processados`);
        }
      });

      rows.push(...orderedRows.filter(Boolean));
      flushBatch('function', state, true, `Concluído • ${rows.length}/${state.total}`);
      return { ok: true, headers: ['BR', 'RESULTADO'], rows };
    }

    if (payload.mode === 'avarias') {
      const pending = Array.isArray(payload.pending) ? payload.pending : [];
      const rows = new Array(pending.length);
      const errors = [];

      await runPool(pending, concurrency, async (item, index) => {
        const br = String(item?.spx_tn || item?.spx || item?.SPX_TN || item?.['SPX TN'] || '').trim().toUpperCase();
        if (!br) {
          rows[index] = ['', '', '', '❌ SPX TN vazio'];
          errors.push(index);
          return;
        }

        const shouldFetchItem = item?.fetch_item !== false;
        const shouldRefreshStatus = item?.refresh_status !== false;
        let productName = String(item?.item || '').trim();
        let status = String(item?.status || '').trim();
        const errParts = [];

        if (shouldFetchItem) {
          try {
            productName = await skuName(br);
          } catch (e) {
            productName = '';
            errParts.push('item: ' + e.message);
          }
        }

        if (shouldRefreshStatus) {
          try {
            status = await avariasStatus(br);
          } catch (e) {
            status = '';
            errParts.push('status: ' + e.message);
          }
        }

        rows[index] = [br, productName, status, errParts.length ? '❌ ' + errParts.join(' | ') : 'OK'];
        if (errParts.length) errors.push(index);
      });

      return {
        ok: true,
        headers: ['SPX TN', 'ITEM/PRODUTO', 'STATUS SPX', 'RETORNO'],
        rows: rows.filter(Boolean),
        errors: errors.length
      };
    }

    if (payload.mode === 'reportTaskList') {
      return await listReportTasks(payload.reportType);
    }

    if (payload.mode === 'report') {
      let out;
      if (payload.reportType === 'TOS') out = await reportTos(payload.codes);
      else if (payload.reportType === 'PARCEL') out = await reportParcel(payload.codes[0]);
      else if (payload.reportType === 'RETURNS') out = await reportReturns(payload.codes);
      else if (payload.reportType === 'CONFERENCIA') out = await reportConferencia(payload.codes);
      else throw new Error('Relatório inválido');
      return { ok: true, ...out };
    }

    throw new Error('Modo inválido');
  })();
}

async function runInSpx(payload) {
  const tab = await findSpxTab();
  if (!tab) throw new Error('Abra uma aba da SPX logada.');
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'ISOLATED',
    func: spxRunner,
    args: [payload]
  });
  return result;
}

if ($('spxActionInput')) {
  $('spxActionInput').addEventListener('input', () => {
    $('spxActionValidCount').textContent = parseBRs($('spxActionInput').value).length;
  });
}

if ($('runSpxAction')) {
  $('runSpxAction').addEventListener('click', async () => {
    if (running) return;
    const brs = parseBRs($('spxActionInput').value);
    $('spxActionValidCount').textContent = brs.length;
    if (!brs.length) {
      toast('Nenhum BR válido.');
      return;
    }

    running = true;
    await setToolkitBusy('Funções', true);
    $('runSpxAction').disabled = true;
    const runId = newRunId('spxAction');
    currentRunId = runId;
    currentRunScope = 'spxAction';
    beginSpxActionRun(brs.length);

    try {
      const res = await runInSpx({
        mode: 'spxAction',
        spxAction: $('spxActionType').value,
        brs,
        runId,
        progressEvery: getProgressEvery(),
        concurrency: getConcurrency()
      });

      if (!res?.ok) throw new Error(res?.error || 'Falha');
      lastSpxActionHeaders = res.headers;
      lastSpxActionRows = res.rows;
      renderTable('spxActionThead', 'spxActionTbody', lastSpxActionHeaders, lastSpxActionRows);
      const errors = lastSpxActionRows.filter(r => String(r[3] || '').startsWith('❌')).length;
      $('spxActionErrCount').textContent = String(errors);
      setSpxActionProgress(lastSpxActionRows.length, brs.length, `Concluído • ${lastSpxActionRows.length}/${brs.length}`);
      toast('Concluído.');
    } catch (e) {
      toast(e.message);
      $('spxActionProgress').textContent = e.message;
      $('spxActionBarFill').style.width = '0';
    } finally {
      running = false;
      currentRunId = '';
      currentRunScope = '';
      await setToolkitBusy('', false);
      $('runSpxAction').disabled = false;
    }
  });
}

if ($('clearSpxAction')) {
  $('clearSpxAction').addEventListener('click', () => {
    $('spxActionInput').value = '';
    resetSpxActionUi();
  });
}

if ($('copySpxAction')) {
  $('copySpxAction').addEventListener('click', () => lastSpxActionRows.length ? copyRows(lastSpxActionHeaders, lastSpxActionRows, true) : toast('Sem resultado.'));
}

if ($('downloadSpxAction')) {
  $('downloadSpxAction').addEventListener('click', () => lastSpxActionRows.length ? downloadCsv('spx_acoes.csv', lastSpxActionHeaders, lastSpxActionRows) : toast('Sem resultado.'));
}

$('brs').addEventListener('input', () => {
  $('validCount').textContent = parseBRs($('brs').value).length;
});

$('run').addEventListener('click', async () => {
  if (running) return;
  const brs = parseBRs($('brs').value);
  $('validCount').textContent = brs.length;
  if (!brs.length) {
    toast('Nenhum BR válido.');
    return;
  }

  running = true;
  await setToolkitBusy('Consultas', true);
  $('run').disabled = true;
  const runId = newRunId('function');
  beginFunctionRun(runId, brs.length);

  try {
    const res = await runInSpx({
      mode: 'function',
      action: $('action').value,
      brs,
      runId,
      progressEvery: getProgressEvery(),
      concurrency: getConcurrency()
    });

    if (!res?.ok) throw new Error(res?.error || 'Falha');
    lastHeaders = res.headers;
    lastRows = res.rows;
    renderFunctionTables(lastRows);
    $('errCount').textContent = String(lastRows.filter(r => String(r[1] || '').startsWith('❌')).length);
    setProgress(lastRows.length, brs.length, false, `Concluído • ${lastRows.length}/${brs.length}`);
    toast('Concluído.');
  } catch (e) {
    toast(e.message);
    $('progressText').textContent = e.message;
    $('barFill').style.width = '0';
  } finally {
    running = false;
    currentRunId = '';
    currentRunScope = '';
    await setToolkitBusy('', false);
    $('run').disabled = false;
  }
});

$('clear').addEventListener('click', () => {
  $('brs').value = '';
  lastRows = [];
  $('validCount').textContent = '0';
  $('doneCount').textContent = '0';
  $('errCount').textContent = '0';
  clearFunctionTables();
  setProgress(0, 0, false, 'Aguardando execução.');
});

$('copy').addEventListener('click', () => lastRows.length ? copyRows(['Resultado'], getFunctionOutputRows(lastRows), false) : toast('Sem resultado.'));
$('download').addEventListener('click', () => lastRows.length ? downloadCsv('spx_consultas.csv', lastHeaders, lastRows) : toast('Sem resultado.'));

function reportUsesTaskPicker(type) {
  return type === 'PARCEL' || type === 'CONFERENCIA';
}

function reportTaskLimit(type) {
  return type === 'CONFERENCIA' ? 2 : 1;
}

function clearReportTaskSelection() {
  document.querySelectorAll('#reportTaskList input').forEach(input => {
    input.checked = false;
    const item = input.closest('.taskItem');
    if (item) item.classList.remove('selected');
  });
}

function selectedReportTaskIds() {
  return Array.from(document.querySelectorAll('#reportTaskList input:checked')).map(input => input.value).filter(Boolean);
}

function updateReportTaskCards() {
  document.querySelectorAll('#reportTaskList input').forEach(input => {
    const item = input.closest('.taskItem');
    if (item) item.classList.toggle('selected', input.checked);
  });
}

function renderReportTasks(type, tasks) {
  const list = $('reportTaskList');
  const limit = reportTaskLimit(type);
  list.innerHTML = '';

  if (!tasks.length) {
    $('reportTaskStatus').textContent = 'Nenhuma tarefa recente encontrada.';
    return;
  }

  $('reportTaskStatus').textContent = type === 'CONFERENCIA'
    ? `Selecione até ${limit} VTs.`
    : 'Selecione 1 PS.';

  tasks.forEach(task => {
    const item = document.createElement('label');
    item.className = 'taskItem';

    const input = document.createElement('input');
    input.type = type === 'CONFERENCIA' ? 'checkbox' : 'radio';
    input.name = 'reportTaskChoice';
    input.value = task.id;

    input.addEventListener('change', () => {
      if (type === 'CONFERENCIA' && selectedReportTaskIds().length > limit) {
        input.checked = false;
        toast('Selecione no máximo 2 VTs.');
      }
      updateReportTaskCards();
    });

    const body = document.createElement('span');
    body.className = 'taskBody';

    const top = document.createElement('span');
    top.className = 'taskLine';

    const title = document.createElement('strong');
    title.textContent = task.title || task.id;
    top.appendChild(title);

    const detail = document.createElement('small');
    detail.textContent = task.detail || '';

    const sub = document.createElement('small');
    sub.textContent = task.sub || '';

    body.appendChild(top);
    if (detail.textContent) body.appendChild(detail);
    if (sub.textContent) body.appendChild(sub);

    item.appendChild(input);
    item.appendChild(body);
    list.appendChild(item);
  });
}

async function loadReportTasksForType(type, force = false) {
  if (!reportUsesTaskPicker(type)) return;
  if (loadingReportTasks && lastReportTaskType === type) return;
  if (!force && lastReportTaskType === type && lastReportTasks.length) return;

  const seq = ++reportTaskLoadSeq;
  loadingReportTasks = true;
  lastReportTaskType = type;
  lastReportTasks = [];
  $('refreshReportTasks').disabled = true;
  $('reportTaskList').innerHTML = '';
  $('reportTaskStatus').textContent = 'Carregando tarefas recentes da SPX...';

  try {
    const res = await runInSpx({ mode: 'reportTaskList', reportType: type });
    if (seq !== reportTaskLoadSeq || $('reportType').value !== type) return;
    if (!res?.ok) throw new Error(res?.error || 'Falha ao carregar tarefas.');
    lastReportTasks = Array.isArray(res.tasks) ? res.tasks : [];
    renderReportTasks(type, lastReportTasks);
  } catch (e) {
    if (seq === reportTaskLoadSeq && $('reportType').value === type) {
      $('reportTaskStatus').textContent = e.message;
      toast(e.message);
    }
  } finally {
    if (seq === reportTaskLoadSeq) {
      loadingReportTasks = false;
      $('refreshReportTasks').disabled = false;
    }
  }
}

function updateReportHint() {
  const t = $('reportType').value;
  const map = {
    TOS: ['TOs', 'Cole TOs. Gera TO, BR, station, sorting code, status, recebedor, ctime e mtime.'],
    PARCEL: ['Tarefa PS', 'Carrega as últimas tarefas Parcel PS da SPX. Escolha 1 tarefa para gerar o relatório bruto do Parcel.'],
    RETURNS: ['BR/SPX', 'Cole BRs ou SPXs. Gera DATA, TO e LH.'],
    CONFERENCIA: ['Tarefas VT', 'Carrega as últimas tarefas de Conferência da SPX. Escolha até 2 VTs para gerar Missing & Missort.']
  };

  const usePicker = reportUsesTaskPicker(t);
  $('reportInputLabel').textContent = map[t][0];
  $('reportHint').textContent = map[t][1];
  $('reportInputLabel').classList.toggle('hidden', usePicker);
  $('reportInput').classList.toggle('hidden', usePicker);
  $('reportTaskPicker').classList.toggle('hidden', !usePicker);
  $('reportTaskTitle').textContent = t === 'CONFERENCIA' ? 'Últimas Conferências' : 'Últimos Parcel PS';

  if (usePicker) {
    loadReportTasksForType(t);
  }
}

$('reportType').addEventListener('change', () => {
  updateReportHint();
});

$('refreshReportTasks').addEventListener('click', () => loadReportTasksForType($('reportType').value, true));
updateReportHint();

$('runReport').addEventListener('click', async () => {
  if (running) return;

  const type = $('reportType').value;
  let codes = [];

  if (reportUsesTaskPicker(type)) {
    codes = selectedReportTaskIds().slice(0, reportTaskLimit(type));
  } else {
    if (type === 'TOS') codes = parseByRx($('reportInput').value, /^TO[0-9A-Z]+$/i);
    if (type === 'RETURNS') codes = parseByRx($('reportInput').value, /^(BR[0-9A-Z]{13}|SPX[0-9A-Z]+)$/i);
  }

  if (!codes.length) {
    toast(reportUsesTaskPicker(type) ? 'Selecione uma tarefa da lista.' : 'Entrada inválida para esse relatório.');
    return;
  }

  running = true;
  await setToolkitBusy('Relatórios', true);
  $('runReport').disabled = true;
  const runId = newRunId('report');
  beginReportRun(runId, [], 'Relatório');

  try {
    const res = await runInSpx({
      mode: 'report',
      reportType: type,
      codes,
      runId,
      progressEvery: getProgressEvery(),
      concurrency: getConcurrency()
    });

    if (!res?.ok) throw new Error(res?.error || 'Falha');
    lastReportName = res.name + '_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '_');
    lastReportHeaders = res.headers;
    lastReportRows = res.rows;
    renderTable('reportThead', 'reportTbody', lastReportHeaders, lastReportRows);
    $('reportTitle').textContent = res.name;
    setProgress(lastReportRows.length, Math.max(lastReportRows.length, 1), true, `${lastReportRows.length} linha(s) geradas.`);
    $('reportBarFill').style.width = '100%';
    toast('Relatório gerado.');
  } catch (e) {
    toast(e.message);
    $('reportProgress').textContent = e.message;
    $('reportBarFill').style.width = '0';
  } finally {
    running = false;
    currentRunId = '';
    currentRunScope = '';
    await setToolkitBusy('', false);
    $('runReport').disabled = false;
  }
});

$('clearReport').addEventListener('click', () => {
  $('reportInput').value = '';
  clearReportTaskSelection();
  lastReportRows = [];
  lastReportHeaders = [];
  setReportLink('');
  renderTable('reportThead', 'reportTbody', [], []);
  $('reportProgress').textContent = 'Aguardando execução.';
  $('reportBarFill').style.width = '0';
});

$('copyReport').addEventListener('click', () => lastReportRows.length ? copyRows(lastReportHeaders, lastReportRows) : toast('Sem relatório.'));
$('downloadReport').addEventListener('click', () => lastReportRows.length ? downloadCsv((lastReportName || 'spx_relatorio') + '.csv', lastReportHeaders, lastReportRows) : toast('Sem relatório.'));

function loadSettings() {
  const fixed = $('fixedSheetEndpoint');
  if (fixed) fixed.textContent = SHEET_ENDPOINT;
}

function setReportLink(url) {
  lastSheetReportUrl = String(url || '').trim();
  let box = $('reportLinkBox');
  if (!box) {
    const progress = $('reportProgress');
    box = document.createElement('div');
    box.id = 'reportLinkBox';
    box.style.marginTop = '8px';
    progress.insertAdjacentElement('afterend', box);
  }
  box.innerHTML = '';
  if (!lastSheetReportUrl) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'secondary';
  btn.textContent = 'Abrir relatório';
  btn.addEventListener('click', () => chrome.tabs.create({ url: lastSheetReportUrl }));
  box.appendChild(btn);
}

async function sendReportToSheets(endpoint, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'SEND_TO_SHEETS',
      url: endpoint,
      payload
    }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!resp || !resp.ok) {
        reject(new Error(resp?.error || 'Falha ao enviar para a planilha.'));
        return;
      }

      resolve(resp.data);
    });
  });
}

$('sendSheets').addEventListener('click', async () => {
  if (!lastReportRows.length) {
    toast('Gere um relatório primeiro.');
    return;
  }

  const endpoint = SHEET_ENDPOINT;
  const token = '';

  $('sendSheets').disabled = true;
  toast('Enviando para a planilha...');

  try {
    const payload = {
      token,
      reportName: lastReportName || 'SPX_Relatorio',
      name: lastReportName || 'SPX_Relatorio',
      headers: lastReportHeaders,
      rows: lastReportRows
    };

    const data = await sendReportToSheets(endpoint, payload);

    if (!data || data.ok === false) {
      throw new Error(data?.error || 'Apps Script retornou falha.');
    }

    const url = data.sheetUrl || data.spreadsheetUrl || data.url;
    setReportLink(url);
    $('reportProgress').textContent = url ? 'Enviado para planilha. Abrir relatório disponível.' : 'Enviado para planilha.';
    toast(url ? 'Enviado. Clique em Abrir relatório.' : 'Enviado para planilha.');
  } catch (e) {
    toast('Erro ao enviar: ' + (e?.message || e));
  } finally {
    $('sendSheets').disabled = false;
  }
});

function setAvariasProgress(done, total, text) {
  const safeTotal = Math.max(Number(total) || 0, Number(done) || 0);
  const pct = safeTotal ? Math.round((done * 100) / safeTotal) : 0;
  const bar = $('avariasBarFill');
  if (bar) bar.style.width = pct + '%';
  if ($('avariasProgress')) $('avariasProgress').textContent = text || (safeTotal ? `${done}/${safeTotal} processados` : 'Aguardando execução.');
}

async function gasGetJson(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GAS_GET_JSON', url }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error(resp?.error || 'Falha no GET.'));
      resolve(resp.data);
    });
  });
}

async function gasPostJson(url, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GAS_POST_JSON', url, payload }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error(resp?.error || 'Falha no POST.'));
      resolve(resp.data);
    });
  });
}

const AVARIAS_ITEM_AUTO_TEXT = 'o nome do item é preenchido automaticamente...';
const AVARIAS_STATUS_AUTO_TEXT = 'o status é preenchido automaticamente...';
const AVARIAS_STATUS_REFRESH_TEXTS = ['Ticket Submitted', 'Tratativa pendente'];

function normalizeLooseText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normCompareAvariasText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function shouldFetchAvariasItem(item) {
  const txt = normalizeLooseText(item);
  return !txt || txt === normalizeLooseText(AVARIAS_ITEM_AUTO_TEXT);
}

function shouldRefreshAvariasStatus(status) {
  const txt = normalizeLooseText(status);
  return !txt ||
    txt === normalizeLooseText(AVARIAS_STATUS_AUTO_TEXT) ||
    AVARIAS_STATUS_REFRESH_TEXTS.some(target => txt === normalizeLooseText(target));
}

function normalizeAvariasPending(data) {
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
      fetch_item: shouldFetchAvariasItem(item),
      refresh_status: shouldRefreshAvariasStatus(status)
    };
  }).filter(x => {
    if (!x.spx_tn) return false;
    if (seen.has(x.spx_tn)) return false;
    seen.add(x.spx_tn);
    return x.fetch_item || x.refresh_status;
  });
}

function resetAvariasUi() {
  lastAvariasRows = [];
  renderTable('avariasThead', 'avariasTbody', lastAvariasHeaders, []);
  $('avariasTotal').textContent = '0';
  $('avariasUpdated').textContent = '0';
  $('avariasErrors').textContent = '0';
  setAvariasProgress(0, 0, 'Aguardando execução.');
}

if ($('runAvarias')) {
  $('runAvarias').addEventListener('click', async () => {
    if (running) return;
    running = true;
    await setToolkitBusy('Avarias manual', true);
    $('runAvarias').disabled = true;
    resetAvariasUi();
    toast('Buscando pendentes na planilha...');

    try {
      setAvariasProgress(0, 1, 'Buscando pendentes na planilha...');
      const pendingResp = await gasGetJson(AVARIAS_ENDPOINT);
      if (pendingResp && pendingResp.success === false) throw new Error(pendingResp.error || 'GET retornou falha.');

      const pending = normalizeAvariasPending(pendingResp);
      $('avariasTotal').textContent = String(pending.length);

      if (!pending.length) {
        setAvariasProgress(0, 0, 'Nenhum SPX TN pendente encontrado.');
        toast('Nenhum pendente.');
        return;
      }

      setAvariasProgress(0, pending.length, `Consultando ${pending.length} pedido(s) na SPX...`);
      const res = await runInSpx({
        mode: 'avarias',
        pending,
        runId: newRunId('avarias'),
        progressEvery: getProgressEvery(),
        concurrency: getConcurrency()
      });

      if (!res?.ok) throw new Error(res?.error || 'Falha ao consultar SPX.');

      lastAvariasHeaders = res.headers || lastAvariasHeaders;
      lastAvariasRows = res.rows || [];
      renderTable('avariasThead', 'avariasTbody', lastAvariasHeaders, lastAvariasRows);
      setAvariasProgress(lastAvariasRows.length, pending.length, 'Consulta SPX concluída. Gravando na planilha...');

      let updated = 0;
      let unchanged = 0;
      let postErrors = 0;
      const pendingBySpx = new Map(pending.map(x => [String(x.spx_tn || '').trim().toUpperCase(), x]));

      for (let i = 0; i < lastAvariasRows.length; i++) {
        const row = lastAvariasRows[i];
        const br = String(row[0] || '').trim().toUpperCase();
        const item = String(row[1] || '').trim();
        const status = String(row[2] || '').trim();
        const hasLookupError = String(row[3] || '').startsWith('❌');
        const original = pendingBySpx.get(br) || {};

        if (!br || hasLookupError) {
          postErrors += 1;
          $('avariasErrors').textContent = String(postErrors);
          continue;
        }

        const itemChanged = !!item && original.fetch_item !== false && normCompareAvariasText(item) !== normCompareAvariasText(original.item);
        const statusChanged = !!status && original.refresh_status !== false && normCompareAvariasText(status) !== normCompareAvariasText(original.status);

        if (!itemChanged && !statusChanged) {
          row[3] = 'Sem alteração';
          unchanged += 1;
        } else {
          const payload = { spx_tn: br };
          if (itemChanged) payload.item = item;
          if (statusChanged) payload.status = status;

          try {
            const postResp = await gasPostJson(AVARIAS_ENDPOINT, payload);
            if (postResp && postResp.success === false) throw new Error(postResp.error || 'POST retornou falha.');
            row[3] = statusChanged ? 'Status atualizado' : 'Item atualizado';
            updated += 1;
          } catch (e) {
            row[3] = '❌ POST: ' + e.message;
            postErrors += 1;
          }
        }

        $('avariasUpdated').textContent = String(updated);
        $('avariasErrors').textContent = String(postErrors);
        if ((i + 1) % getProgressEvery() === 0 || i + 1 === lastAvariasRows.length) {
          renderTable('avariasThead', 'avariasTbody', lastAvariasHeaders, lastAvariasRows);
          setAvariasProgress(i + 1, lastAvariasRows.length, `${i + 1}/${lastAvariasRows.length} processados • ${unchanged} sem alteração`);
        }
      }

      renderTable('avariasThead', 'avariasTbody', lastAvariasHeaders, lastAvariasRows);
      setAvariasProgress(lastAvariasRows.length, lastAvariasRows.length, `Concluído • ${updated} atualizado(s) • ${unchanged} sem alteração • ${postErrors} erro(s)`);
      toast('Avarias atualizadas.');
    } catch (e) {
      $('avariasProgress').textContent = e.message;
      toast(e.message);
    } finally {
      running = false;
      await setToolkitBusy('', false);
      $('runAvarias').disabled = false;
    }
  });
}

if ($('clearAvarias')) $('clearAvarias').addEventListener('click', resetAvariasUi);
if ($('copyAvarias')) $('copyAvarias').addEventListener('click', () => lastAvariasRows.length ? copyRows(lastAvariasHeaders, lastAvariasRows) : toast('Sem resultado.'));
if ($('downloadAvarias')) $('downloadAvarias').addEventListener('click', () => lastAvariasRows.length ? downloadCsv('spx_avarias_atualizadas.csv', lastAvariasHeaders, lastAvariasRows) : toast('Sem resultado.'));

function formatAvariasCountdown(ms) {
  const total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${m}:${s}` : `${m}:${s}`;
}

function runtimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, resp => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error(resp?.error || 'Falha na comunicação com background.'));
      resolve(resp.data);
    });
  });
}

function renderAvariasAutoState(state) {
  lastAvariasAutoState = state || lastAvariasAutoState || {};
  const enabled = lastAvariasAutoState.enabled !== false;
  const runningAuto = !!lastAvariasAutoState.running;
  const nextRunAt = Number(lastAvariasAutoState.nextRunAt || 0);
  const left = nextRunAt ? nextRunAt - Date.now() : AVARIAS_AUTO_INTERVAL_MS;
  const counter = runningAuto ? 'rodando' : (enabled ? formatAvariasCountdown(left) : 'off');

  if ($('avariasTabCounter')) $('avariasTabCounter').textContent = 'AV ' + counter;
  if ($('avariasAutoEnabled')) $('avariasAutoEnabled').checked = enabled;

  if ($('avariasAutoStatus')) {
    const base = runningAuto
      ? 'Auto rodando agora...'
      : enabled
        ? `Auto ativo • próxima execução em ${formatAvariasCountdown(left)}`
        : 'Auto desativado';
    const last = lastAvariasAutoState.lastStatus ? ` • ${lastAvariasAutoState.lastStatus}` : '';
    $('avariasAutoStatus').textContent = base + last;
  }
}

async function refreshAvariasAutoState() {
  try {
    const state = await runtimeMessage({ type: 'AVARIAS_AUTO_STATUS' });
    renderAvariasAutoState(state);
  } catch (e) {
    if ($('avariasTabCounter')) $('avariasTabCounter').textContent = 'erro';
    if ($('avariasAutoStatus')) $('avariasAutoStatus').textContent = 'Erro no auto: ' + e.message;
  }
}

function startAvariasAutoCounter() {
  if (avariasAutoTimer) clearInterval(avariasAutoTimer);
  avariasAutoTimer = setInterval(() => {
    if (lastAvariasAutoState) renderAvariasAutoState(lastAvariasAutoState);
    refreshAvariasAutoState();
  }, 1000);
  refreshAvariasAutoState();
}

if ($('avariasAutoEnabled')) {
  $('avariasAutoEnabled').addEventListener('change', async () => {
    try {
      const enabled = $('avariasAutoEnabled').checked;
      const state = await runtimeMessage({ type: 'AVARIAS_AUTO_SET_ENABLED', enabled });
      renderAvariasAutoState(state);
      toast(enabled ? 'Automação de avarias ativada.' : 'Automação de avarias desativada.');
    } catch (e) {
      toast(e.message);
      refreshAvariasAutoState();
    }
  });
}

clearFunctionTables();
resetAvariasUi();
findSpxTab();
loadSettings();
startAvariasAutoCounter();


const AUDIT_AUTO_INTERVAL_MS = 10 * 60 * 1000;
let auditAutoTimer = null;
let lastAuditAutoState = null;
let lastAuditAutoHeaders = ['VT', 'CRIADA_EM', 'ENCERRADA_EM', 'TOTAL_TARGETS', 'VALIDADOS', 'EM_PROGRESSO', 'NAO_INICIADOS', 'TARGETS_BAIXADOS', 'TASK_STATUS', 'RETORNO'];
let lastAuditAutoRows = [];

function setAuditAutoProgress(done, total, text) {
  const safeTotal = Math.max(Number(total) || 0, Number(done) || 0);
  const pct = safeTotal ? Math.round((done * 100) / safeTotal) : 0;
  const bar = $('auditAutoBarFill');
  if (bar) bar.style.width = pct + '%';
  if ($('auditAutoProgress')) {
    $('auditAutoProgress').textContent = text || (safeTotal ? `${done}/${safeTotal} processados` : 'Aguardando execução.');
  }
}

function resetAuditAutoUi() {
  lastAuditAutoRows = [];
  renderTable('auditAutoThead', 'auditAutoTbody', lastAuditAutoHeaders, []);
  if ($('auditAutoTasks')) $('auditAutoTasks').textContent = '0';
  if ($('auditAutoTargets')) $('auditAutoTargets').textContent = '0';
  if ($('auditAutoErrors')) $('auditAutoErrors').textContent = '0';
  setAuditAutoProgress(0, 0, 'Aguardando execução.');
}

function renderAuditAutoState(state) {
  lastAuditAutoState = state || lastAuditAutoState || {};
  const enabled = lastAuditAutoState.enabled !== false;
  const runningAuto = !!lastAuditAutoState.running;
  const nextRunAt = Number(lastAuditAutoState.nextRunAt || 0);
  const left = nextRunAt ? nextRunAt - Date.now() : AUDIT_AUTO_INTERVAL_MS;
  const counter = runningAuto ? 'rodando' : (enabled ? formatAvariasCountdown(left) : 'off');

  lastAuditAutoHeaders = Array.isArray(lastAuditAutoState.lastHeaders) && lastAuditAutoState.lastHeaders.length
    ? lastAuditAutoState.lastHeaders
    : lastAuditAutoHeaders;
  lastAuditAutoRows = Array.isArray(lastAuditAutoState.lastRows) ? lastAuditAutoState.lastRows : lastAuditAutoRows;

  if ($('auditAutoTabCounter')) $('auditAutoTabCounter').textContent = 'CF ' + counter;
  if ($('auditAutoEnabled')) $('auditAutoEnabled').checked = enabled;
  if ($('auditAutoTasks')) $('auditAutoTasks').textContent = String(lastAuditAutoState.lastTasks || 0);
  if ($('auditAutoTargets')) $('auditAutoTargets').textContent = String(lastAuditAutoState.lastTargets || 0);
  if ($('auditAutoErrors')) $('auditAutoErrors').textContent = String(lastAuditAutoState.lastErrors || 0);

  if ($('auditAutoStatus')) {
    const base = runningAuto
      ? 'Auto rodando agora...'
      : enabled
        ? `Auto ativo • próxima execução em ${formatAvariasCountdown(left)}`
        : 'Auto desativado';
    const last = lastAuditAutoState.lastStatus ? ` • ${lastAuditAutoState.lastStatus}` : '';
    $('auditAutoStatus').textContent = base + last;
  }

  renderTable('auditAutoThead', 'auditAutoTbody', lastAuditAutoHeaders, lastAuditAutoRows);
  setAuditAutoProgress(
    Number(lastAuditAutoState.lastTasks || 0),
    Number(lastAuditAutoState.lastTasks || 0),
    runningAuto
      ? 'Coletando e enviando dados da SPX...'
      : (lastAuditAutoState.lastStatus || (lastAuditAutoRows.length ? `${lastAuditAutoRows.length} linha(s)` : 'Aguardando execução.'))
  );
}

async function refreshAuditAutoState() {
  try {
    const state = await runtimeMessage({ type: 'AUDIT_AUTO_STATUS' });
    renderAuditAutoState(state);
  } catch (e) {
    if ($('auditAutoTabCounter')) $('auditAutoTabCounter').textContent = 'erro';
    if ($('auditAutoStatus')) $('auditAutoStatus').textContent = 'Erro no auto: ' + e.message;
  }
}

function startAuditAutoCounter() {
  if (auditAutoTimer) clearInterval(auditAutoTimer);
  auditAutoTimer = setInterval(() => {
    if (lastAuditAutoState) renderAuditAutoState(lastAuditAutoState);
    refreshAuditAutoState();
  }, 1000);
  refreshAuditAutoState();
}

if ($('auditAutoEnabled')) {
  $('auditAutoEnabled').addEventListener('change', async () => {
    try {
      const enabled = $('auditAutoEnabled').checked;
      const state = await runtimeMessage({ type: 'AUDIT_AUTO_SET_ENABLED', enabled });
      renderAuditAutoState(state);
      toast(enabled ? 'Automação de Conferência ativada.' : 'Automação de Conferência desativada.');
    } catch (e) {
      toast(e.message);
      refreshAuditAutoState();
    }
  });
}

if ($('runAuditAuto')) {
  $('runAuditAuto').addEventListener('click', async () => {
    try {
      $('runAuditAuto').disabled = true;
      setAuditAutoProgress(0, 1, 'Iniciando automação de Conferência...');
      await runtimeMessage({ type: 'AUDIT_AUTO_RUN_NOW' });
      toast('Automação de Conferência iniciada.');
      refreshAuditAutoState();
    } catch (e) {
      toast(e.message);
      refreshAuditAutoState();
    } finally {
      setTimeout(() => {
        if ($('runAuditAuto')) $('runAuditAuto').disabled = false;
      }, 1200);
    }
  });
}

if ($('clearAuditAuto')) {
  $('clearAuditAuto').addEventListener('click', async () => {
    try {
      const state = await runtimeMessage({ type: 'AUDIT_AUTO_CLEAR_RESULTS' });
      renderAuditAutoState(state);
    } catch (e) {
      toast(e.message);
    }
  });
}

if ($('copyAuditAuto')) {
  $('copyAuditAuto').addEventListener('click', () => {
    lastAuditAutoRows.length ? copyRows(lastAuditAutoHeaders, lastAuditAutoRows) : toast('Sem resultado.');
  });
}

if ($('downloadAuditAuto')) {
  $('downloadAuditAuto').addEventListener('click', () => {
    lastAuditAutoRows.length ? downloadCsv('spx_conferencia_auto.csv', lastAuditAutoHeaders, lastAuditAutoRows) : toast('Sem resultado.');
  });
}



const ASSIGNMENT_AUTO_INTERVAL_MS = 60 * 60 * 1000;
let assignmentAutoTimer = null;
let lastAssignmentAutoState = null;
let lastAssignmentAutoHeaders = [
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
let lastAssignmentAutoRows = [];

function setAssignmentAutoProgress(done, total, text) {
  const safeTotal = Math.max(Number(total) || 0, Number(done) || 0);
  const pct = safeTotal ? Math.round((done * 100) / safeTotal) : 0;
  const bar = $('assignmentAutoBarFill');
  if (bar) bar.style.width = pct + '%';
  if ($('assignmentAutoProgress')) {
    $('assignmentAutoProgress').textContent = text || (safeTotal ? `${done}/${safeTotal} processados` : 'Aguardando execução.');
  }
}

function resetAssignmentAutoUi() {
  lastAssignmentAutoRows = [];
  renderTable('assignmentAutoThead', 'assignmentAutoTbody', lastAssignmentAutoHeaders, []);
  if ($('assignmentAutoTasks')) $('assignmentAutoTasks').textContent = '0';
  if ($('assignmentAutoSent')) $('assignmentAutoSent').textContent = '0';
  if ($('assignmentAutoErrors')) $('assignmentAutoErrors').textContent = '0';
  setAssignmentAutoProgress(0, 0, 'Aguardando execução.');
}

function renderAssignmentAutoState(state) {
  lastAssignmentAutoState = state || lastAssignmentAutoState || {};
  const enabled = lastAssignmentAutoState.enabled !== false;
  const runningAuto = !!lastAssignmentAutoState.running;
  const nextRunAt = Number(lastAssignmentAutoState.nextRunAt || 0);
  const left = nextRunAt ? nextRunAt - Date.now() : ASSIGNMENT_AUTO_INTERVAL_MS;

  lastAssignmentAutoHeaders = Array.isArray(lastAssignmentAutoState.lastHeaders) && lastAssignmentAutoState.lastHeaders.length
    ? lastAssignmentAutoState.lastHeaders
    : lastAssignmentAutoHeaders;
  lastAssignmentAutoRows = Array.isArray(lastAssignmentAutoState.lastRows) ? lastAssignmentAutoState.lastRows : lastAssignmentAutoRows;

  if ($('assignmentAutoEnabled')) $('assignmentAutoEnabled').checked = enabled;
  if ($('assignmentAutoTasks')) $('assignmentAutoTasks').textContent = String(lastAssignmentAutoState.lastTasks || 0);
  if ($('assignmentAutoSent')) $('assignmentAutoSent').textContent = String(lastAssignmentAutoState.lastSent || 0);
  if ($('assignmentAutoErrors')) $('assignmentAutoErrors').textContent = String(lastAssignmentAutoState.lastErrors || 0);

  if ($('assignmentAutoStatus')) {
    const base = runningAuto
      ? 'Auto rodando agora...'
      : enabled
        ? `Auto ativo • próxima execução em ${formatAvariasCountdown(left)}`
        : 'Auto desativado';
    const last = lastAssignmentAutoState.lastStatus ? ` • ${lastAssignmentAutoState.lastStatus}` : '';
    $('assignmentAutoStatus').textContent = base + last;
  }

  renderTable('assignmentAutoThead', 'assignmentAutoTbody', lastAssignmentAutoHeaders, lastAssignmentAutoRows);
  setAssignmentAutoProgress(
    Number(lastAssignmentAutoState.lastTasks || 0),
    Number(lastAssignmentAutoState.lastTasks || 0),
    runningAuto
      ? 'Coletando e enviando ATs da SPX...'
      : (lastAssignmentAutoState.lastStatus || (lastAssignmentAutoRows.length ? `${lastAssignmentAutoRows.length} AT(s)` : 'Aguardando execução.'))
  );
}

async function refreshAssignmentAutoState() {
  try {
    const state = await runtimeMessage({ type: 'ASSIGNMENT_AUTO_STATUS' });
    renderAssignmentAutoState(state);
  } catch (e) {
    if ($('assignmentAutoStatus')) $('assignmentAutoStatus').textContent = 'Erro no auto: ' + e.message;
  }
}

function startAssignmentAutoCounter() {
  if (assignmentAutoTimer) clearInterval(assignmentAutoTimer);
  assignmentAutoTimer = setInterval(() => {
    if (lastAssignmentAutoState) renderAssignmentAutoState(lastAssignmentAutoState);
    refreshAssignmentAutoState();
  }, 1000);
  refreshAssignmentAutoState();
}

if ($('assignmentAutoEnabled')) {
  $('assignmentAutoEnabled').addEventListener('change', async () => {
    try {
      const enabled = $('assignmentAutoEnabled').checked;
      const state = await runtimeMessage({ type: 'ASSIGNMENT_AUTO_SET_ENABLED', enabled });
      renderAssignmentAutoState(state);
      toast(enabled ? 'Automação de ATs ativada.' : 'Automação de ATs desativada.');
    } catch (e) {
      toast(e.message);
      refreshAssignmentAutoState();
    }
  });
}

if ($('runAssignmentAuto')) {
  $('runAssignmentAuto').addEventListener('click', async () => {
    try {
      $('runAssignmentAuto').disabled = true;
      setAssignmentAutoProgress(0, 1, 'Iniciando sincronização de ATs...');
      const result = await runtimeMessage({ type: 'ASSIGNMENT_AUTO_RUN_NOW' });
      await refreshAssignmentAutoState();
      if (result && result.skipped) {
        toast(result.reason || 'Sincronização ignorada.');
      } else if (result && result.ok === false) {
        toast(result.error || 'Erro na sincronização de ATs.');
      } else {
        toast('Sincronização de ATs concluída.');
      }
    } catch (e) {
      toast(e.message);
      refreshAssignmentAutoState();
    } finally {
      setTimeout(() => {
        if ($('runAssignmentAuto')) $('runAssignmentAuto').disabled = false;
      }, 1200);
    }
  });
}

if ($('clearAssignmentAuto')) {
  $('clearAssignmentAuto').addEventListener('click', async () => {
    try {
      const state = await runtimeMessage({ type: 'ASSIGNMENT_AUTO_CLEAR_RESULTS' });
      renderAssignmentAutoState(state);
    } catch (e) {
      toast(e.message);
    }
  });
}

if ($('copyAssignmentAuto')) {
  $('copyAssignmentAuto').addEventListener('click', () => {
    lastAssignmentAutoRows.length ? copyRows(lastAssignmentAutoHeaders, lastAssignmentAutoRows) : toast('Sem resultado.');
  });
}

if ($('downloadAssignmentAuto')) {
  $('downloadAssignmentAuto').addEventListener('click', () => {
    lastAssignmentAutoRows.length ? downloadCsv('spx_assignment_tasks.csv', lastAssignmentAutoHeaders, lastAssignmentAutoRows) : toast('Sem resultado.');
  });
}

resetAssignmentAutoUi();
startAssignmentAutoCounter();


const PARCEL_SWEEPER_INTERVAL_MS = 60 * 60 * 1000;
let parcelSweeperTimer = null;
let lastParcelSweeperState = null;
let lastParcelSweeperHeaders = ['Data', 'Tarefa PS', 'Status', 'Planilha', 'Pedidos', 'Resultado'];
let lastParcelSweeperRows = [];

function setParcelSweeperProgress(done, total, text) {
  const safeTotal = Math.max(Number(total) || 0, Number(done) || 0);
  const pct = safeTotal ? Math.round((done * 100) / safeTotal) : 0;
  const bar = $('parcelSweeperBarFill');

  if (bar) bar.style.width = pct + '%';
  if ($('parcelSweeperProgress')) {
    $('parcelSweeperProgress').textContent = text || (safeTotal ? `${done}/${safeTotal} tarefa(s)` : 'Aguardando execução.');
  }
}

function resetParcelSweeperUi() {
  lastParcelSweeperRows = [];
  renderTable('parcelSweeperThead', 'parcelSweeperTbody', lastParcelSweeperHeaders, []);
  if ($('parcelSweeperTasks')) $('parcelSweeperTasks').textContent = '0';
  if ($('parcelSweeperOrders')) $('parcelSweeperOrders').textContent = '0';
  if ($('parcelSweeperErrors')) $('parcelSweeperErrors').textContent = '0';
  setParcelSweeperProgress(0, 0, 'Aguardando execução.');
}

function renderParcelSweeperState(state) {
  lastParcelSweeperState = state || lastParcelSweeperState || {};
  const enabled = lastParcelSweeperState.enabled !== false;
  const runningAuto = !!lastParcelSweeperState.running;
  const nextRunAt = Number(lastParcelSweeperState.nextRunAt || 0);
  const left = nextRunAt ? nextRunAt - Date.now() : PARCEL_SWEEPER_INTERVAL_MS;

  lastParcelSweeperHeaders = Array.isArray(lastParcelSweeperState.lastHeaders) && lastParcelSweeperState.lastHeaders.length
    ? lastParcelSweeperState.lastHeaders
    : lastParcelSweeperHeaders;
  lastParcelSweeperRows = Array.isArray(lastParcelSweeperState.lastRows)
    ? lastParcelSweeperState.lastRows
    : lastParcelSweeperRows;

  if ($('parcelSweeperAutoEnabled')) $('parcelSweeperAutoEnabled').checked = enabled;
  if ($('parcelSweeperTasks')) $('parcelSweeperTasks').textContent = String(lastParcelSweeperState.lastTasks || 0);
  if ($('parcelSweeperOrders')) $('parcelSweeperOrders').textContent = String(lastParcelSweeperState.lastOrders || 0);
  if ($('parcelSweeperErrors')) $('parcelSweeperErrors').textContent = String(lastParcelSweeperState.lastErrors || 0);

  if ($('parcelSweeperStatus')) {
    const base = runningAuto
      ? 'Auto rodando agora...'
      : enabled
        ? `Auto ativo • próxima execução em ${formatAvariasCountdown(left)}`
        : 'Auto desativado';
    const last = lastParcelSweeperState.lastStatus ? ` • ${lastParcelSweeperState.lastStatus}` : '';
    $('parcelSweeperStatus').textContent = base + last;
  }

  renderTable('parcelSweeperThead', 'parcelSweeperTbody', lastParcelSweeperHeaders, lastParcelSweeperRows);
  setParcelSweeperProgress(
    Number(lastParcelSweeperState.lastTasks || 0),
    Math.max(5, Number(lastParcelSweeperState.lastTasks || 0)),
    runningAuto
      ? 'Consultando Parcel Sweeper e sincronizando a planilha...'
      : (lastParcelSweeperState.lastStatus || 'Aguardando execução.')
  );
}

async function refreshParcelSweeperState() {
  try {
    const state = await runtimeMessage({ type: 'PARCEL_SWEEPER_STATUS' });
    renderParcelSweeperState(state);
  } catch (e) {
    if ($('parcelSweeperStatus')) $('parcelSweeperStatus').textContent = 'Erro no auto: ' + e.message;
  }
}

function startParcelSweeperCounter() {
  if (parcelSweeperTimer) clearInterval(parcelSweeperTimer);
  parcelSweeperTimer = setInterval(() => {
    if (lastParcelSweeperState) renderParcelSweeperState(lastParcelSweeperState);
    refreshParcelSweeperState();
  }, 1000);
  refreshParcelSweeperState();
}

if ($('parcelSweeperAutoEnabled')) {
  $('parcelSweeperAutoEnabled').addEventListener('change', async () => {
    try {
      const enabled = $('parcelSweeperAutoEnabled').checked;
      const state = await runtimeMessage({ type: 'PARCEL_SWEEPER_SET_ENABLED', enabled });
      renderParcelSweeperState(state);
      toast(enabled ? 'Automação do Parcel Sweeper ativada.' : 'Automação do Parcel Sweeper desativada.');
    } catch (e) {
      toast(e.message);
      refreshParcelSweeperState();
    }
  });
}

if ($('runParcelSweeper')) {
  $('runParcelSweeper').addEventListener('click', async () => {
    try {
      $('runParcelSweeper').disabled = true;
      setParcelSweeperProgress(0, 5, 'Consultando as 5 tarefas mais recentes...');
      const result = await runtimeMessage({ type: 'PARCEL_SWEEPER_RUN_NOW' });
      await refreshParcelSweeperState();

      if (result && result.skipped) {
        toast(result.reason || 'Execução ignorada.');
      } else if (result && result.ok === false) {
        toast(result.error || `Parcel Sweeper concluído com ${result.errors || 1} erro(s).`);
      } else {
        toast(`Parcel Sweeper atualizado • ${result?.orderCount || 0} pedido(s) coletados.`);
      }
    } catch (e) {
      toast(e.message);
      refreshParcelSweeperState();
    } finally {
      setTimeout(() => {
        if ($('runParcelSweeper')) $('runParcelSweeper').disabled = false;
      }, 1200);
    }
  });
}

if ($('clearParcelSweeper')) {
  $('clearParcelSweeper').addEventListener('click', async () => {
    try {
      const state = await runtimeMessage({ type: 'PARCEL_SWEEPER_CLEAR_RESULTS' });
      renderParcelSweeperState(state);
    } catch (e) {
      toast(e.message);
    }
  });
}

if ($('copyParcelSweeper')) {
  $('copyParcelSweeper').addEventListener('click', () => {
    lastParcelSweeperRows.length
      ? copyRows(lastParcelSweeperHeaders, lastParcelSweeperRows)
      : toast('Sem resultado.');
  });
}

if ($('downloadParcelSweeper')) {
  $('downloadParcelSweeper').addEventListener('click', () => {
    lastParcelSweeperRows.length
      ? downloadCsv('spx_parcel_sweeper_resumo.csv', lastParcelSweeperHeaders, lastParcelSweeperRows)
      : toast('Sem resultado.');
  });
}

resetParcelSweeperUi();
startParcelSweeperCounter();


const PENDING_RETURNS_INTERVAL_MS = 60 * 60 * 1000;
let pendingReturnsTimer = null;
let lastPendingReturnsState = null;
let lastPendingReturnsHeaders = [];
let lastPendingReturnsRows = [];

function setPendingReturnsProgress(done, total, text) {
  const safeTotal = Math.max(Number(total) || 0, Number(done) || 0);
  const pct = safeTotal ? Math.round((done * 100) / safeTotal) : 0;
  const bar = $('pendingReturnsBarFill');

  if (bar) bar.style.width = pct + '%';

  if ($('pendingReturnsProgress')) {
    $('pendingReturnsProgress').textContent = text || (safeTotal ? `${done}/${safeTotal} processados` : 'Aguardando execução.');
  }
}

function resetPendingReturnsUi() {
  lastPendingReturnsHeaders = [];
  lastPendingReturnsRows = [];
  renderTable('pendingReturnsThead', 'pendingReturnsTbody', [], []);

  if ($('pendingReturnsOrders')) $('pendingReturnsOrders').textContent = '0';
  if ($('pendingReturnsTaskId')) $('pendingReturnsTaskId').textContent = '-';
  if ($('pendingReturnsErrors')) $('pendingReturnsErrors').textContent = '0';

  setPendingReturnsProgress(0, 0, 'Aguardando execução.');
}

function renderPendingReturnsState(state) {
  lastPendingReturnsState = state || lastPendingReturnsState || {};
  const enabled = lastPendingReturnsState.enabled !== false;
  const runningAuto = !!lastPendingReturnsState.running;
  const nextRunAt = Number(lastPendingReturnsState.nextRunAt || 0);
  const left = nextRunAt ? nextRunAt - Date.now() : PENDING_RETURNS_INTERVAL_MS;

  lastPendingReturnsHeaders = Array.isArray(lastPendingReturnsState.lastHeaders)
    ? lastPendingReturnsState.lastHeaders
    : lastPendingReturnsHeaders;

  lastPendingReturnsRows = Array.isArray(lastPendingReturnsState.lastRows)
    ? lastPendingReturnsState.lastRows
    : lastPendingReturnsRows;

  if ($('pendingReturnsAutoEnabled')) $('pendingReturnsAutoEnabled').checked = enabled;
  if ($('pendingReturnsOrders')) $('pendingReturnsOrders').textContent = String(lastPendingReturnsState.lastOrders || 0);
  if ($('pendingReturnsTaskId')) $('pendingReturnsTaskId').textContent = String(lastPendingReturnsState.lastTaskId || '-');
  if ($('pendingReturnsErrors')) $('pendingReturnsErrors').textContent = String(lastPendingReturnsState.lastErrors || 0);

  if ($('pendingReturnsStatus')) {
    const base = runningAuto
      ? 'Auto rodando agora...'
      : enabled
        ? `Auto ativo • próxima execução em ${formatAvariasCountdown(left)}`
        : 'Auto desativado';

    const last = lastPendingReturnsState.lastStatus
      ? ` • ${lastPendingReturnsState.lastStatus}`
      : '';

    $('pendingReturnsStatus').textContent = base + last;
  }

  renderTable(
    'pendingReturnsThead',
    'pendingReturnsTbody',
    lastPendingReturnsHeaders,
    lastPendingReturnsRows
  );

  setPendingReturnsProgress(
    Number(lastPendingReturnsState.lastOrders || 0),
    Number(lastPendingReturnsState.lastOrders || 0),
    runningAuto
      ? 'Gerando exportação e atualizando a planilha...'
      : (lastPendingReturnsState.lastStatus || 'Aguardando execução.')
  );
}

async function refreshPendingReturnsState() {
  try {
    const state = await runtimeMessage({ type: 'PENDING_RETURNS_STATUS' });
    renderPendingReturnsState(state);
  } catch (e) {
    if ($('pendingReturnsStatus')) {
      $('pendingReturnsStatus').textContent = 'Erro no auto: ' + e.message;
    }
  }
}

function startPendingReturnsCounter() {
  if (pendingReturnsTimer) clearInterval(pendingReturnsTimer);

  pendingReturnsTimer = setInterval(() => {
    if (lastPendingReturnsState) renderPendingReturnsState(lastPendingReturnsState);
    refreshPendingReturnsState();
  }, 1000);

  refreshPendingReturnsState();
}

if ($('pendingReturnsAutoEnabled')) {
  $('pendingReturnsAutoEnabled').addEventListener('change', async () => {
    try {
      const enabled = $('pendingReturnsAutoEnabled').checked;
      const state = await runtimeMessage({
        type: 'PENDING_RETURNS_SET_ENABLED',
        enabled
      });

      renderPendingReturnsState(state);
      toast(enabled
        ? 'Automação de Devoluções Pendentes ativada.'
        : 'Automação de Devoluções Pendentes desativada.');
    } catch (e) {
      toast(e.message);
      refreshPendingReturnsState();
    }
  });
}

if ($('runPendingReturns')) {
  $('runPendingReturns').addEventListener('click', async () => {
    try {
      $('runPendingReturns').disabled = true;
      setPendingReturnsProgress(0, 1, 'Solicitando exportação de Devoluções Pendentes...');

      const result = await runtimeMessage({ type: 'PENDING_RETURNS_RUN_NOW' });
      await refreshPendingReturnsState();

      if (result && result.skipped) {
        toast(result.reason || 'Execução ignorada.');
      } else if (result && result.ok === false) {
        toast(result.error || 'Erro na automação de Devoluções Pendentes.');
      } else {
        toast('Devoluções Pendentes atualizadas.');
      }
    } catch (e) {
      toast(e.message);
      refreshPendingReturnsState();
    } finally {
      setTimeout(() => {
        if ($('runPendingReturns')) $('runPendingReturns').disabled = false;
      }, 1200);
    }
  });
}

if ($('clearPendingReturns')) {
  $('clearPendingReturns').addEventListener('click', async () => {
    try {
      const state = await runtimeMessage({ type: 'PENDING_RETURNS_CLEAR_RESULTS' });
      renderPendingReturnsState(state);
    } catch (e) {
      toast(e.message);
    }
  });
}

if ($('copyPendingReturns')) {
  $('copyPendingReturns').addEventListener('click', () => {
    lastPendingReturnsRows.length
      ? copyRows(lastPendingReturnsHeaders, lastPendingReturnsRows)
      : toast('Sem resultado.');
  });
}

if ($('downloadPendingReturns')) {
  $('downloadPendingReturns').addEventListener('click', () => {
    const fileName = String(lastPendingReturnsState?.lastFileName || 'spx_devolucoes_pendentes.csv')
      .split('/')
      .pop();

    lastPendingReturnsRows.length
      ? downloadCsv(fileName, lastPendingReturnsHeaders, lastPendingReturnsRows)
      : toast('Sem resultado.');
  });
}

resetPendingReturnsUi();
startPendingReturnsCounter();


let packageLabelTemplates = [];
let localLabelTemplates = [];
let localLabelUrls = [];
let packageLabelLoadMessage = '';

function setLabelProgress(pct, text) {
  const bar = $('labelBarFill');
  if (bar) bar.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + '%';
  if ($('labelProgress') && text) $('labelProgress').textContent = text;
}

function setLabelStatus(text) {
  if ($('labelStatus')) $('labelStatus').textContent = text;
}

function getAllLabelTemplates() {
  return [...packageLabelTemplates, ...localLabelTemplates];
}

function labelNameFromPath(path) {
  const name = String(path || '').split('/').pop() || 'etiqueta.png';
  return name.replace(/\.(png|jpe?g|webp|gif|bmp|svg)$/i, '').replace(/[_-]+/g, ' ').trim() || name;
}

function isImageName(name) {
  return /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(String(name || ''));
}

function isImageFile(file) {
  return isImageName(file?.name) || String(file?.type || '').startsWith('image/');
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const readBatch = () => {
      reader.readEntries(batch => {
        if (!batch.length) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

function getEntryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function collectImageEntries(dirEntry, prefix = 'etiquetas') {
  const reader = dirEntry.createReader();
  const entries = await readDirectoryEntries(reader);
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory) {
      const nested = await collectImageEntries(entry, `${prefix}/${entry.name}`);
      files.push(...nested);
      continue;
    }

    if (!entry.isFile || !isImageName(entry.name)) continue;
    const path = `${prefix}/${entry.name}`;
    files.push({ path, name: entry.name });
  }

  return files;
}

function getPackageDirectoryEntry() {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.getPackageDirectoryEntry) {
      reject(new Error('Não foi possível carregar o catálogo automaticamente. Recarregue a tela ou confira a pasta /etiquetas.'));
      return;
    }

    chrome.runtime.getPackageDirectoryEntry(resolve);
  });
}

function getChildDirectory(parent, name) {
  return new Promise((resolve, reject) => {
    parent.getDirectory(name, {}, resolve, reject);
  });
}

async function loadPackageLabelTemplates() {
  packageLabelTemplates = [];
  packageLabelLoadMessage = '';

  try {
    const rootEntry = await getPackageDirectoryEntry();
    const etiquetasDir = await getChildDirectory(rootEntry, 'etiquetas');
    const images = await collectImageEntries(etiquetasDir, 'etiquetas');

    packageLabelTemplates = images
      .sort((a, b) => a.path.localeCompare(b.path, 'pt-BR', { numeric: true }))
      .map((file, index) => ({
        id: 'pkg_' + index + '_' + file.path,
        nome: labelNameFromPath(file.path),
        arquivo: file.path,
        url: chrome.runtime.getURL(file.path),
        source: 'package'
      }));

    if (!packageLabelTemplates.length) {
      packageLabelLoadMessage = 'Nenhuma imagem encontrada em /etiquetas.';
    }
  } catch (e) {
    packageLabelLoadMessage = e.message || 'Não foi possível ler a pasta /etiquetas.';
  }
}

function getLabelUrl(template) {
  return template.url || (template.source === 'package' ? chrome.runtime.getURL(template.arquivo) : '');
}

function openLabelImage(template) {
  const url = getLabelUrl(template);
  if (!url) {
    toast('Etiqueta não encontrada.');
    return;
  }
  chrome.tabs.create({ url });
}

function getNumberValue(id, fallback) {
  const el = $(id);
  const value = Number(el?.value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getSelectValue(id, fallback) {
  const el = $(id);
  return el?.value || fallback;
}

const LABEL_TYPES = {
  small: { key: 'small', labelType: 'Pequena', width: 70, height: 40 },
  large: { key: 'large', labelType: 'Grande', width: 100, height: 150 }
};

let activeLabelTemplate = null;
let activeLabelType = 'small';
let labelPrinting = false;

function getLabelPrintSettings(labelTypeKey = 'small') {
  const type = LABEL_TYPES[labelTypeKey] || LABEL_TYPES.small;
  return {
    ...type,
    scale: 100,
    padding: 0,
    rotate: '0',
    fit: 'contain',
    autoRotate: true
  };
}

function getAutoLabelRotation(imageWidth, imageHeight, labelWidth, labelHeight) {
  const imageLandscape = Number(imageWidth) >= Number(imageHeight);
  const labelLandscape = Number(labelWidth) >= Number(labelHeight);
  return imageLandscape === labelLandscape ? 0 : 90;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Não foi possível ler a imagem.'));
    reader.readAsDataURL(blob);
  });
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Não foi possível carregar a imagem da etiqueta.'));
    img.src = url;
  });
}

function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Não foi possível gerar o PDF.'));
    reader.readAsArrayBuffer(blob);
  });
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Não foi possível converter a imagem para impressão.'));
    }, type, quality);
  });
}

function getImageDrawRect(imageWidth, imageHeight, pageWidth, pageHeight, fit) {
  if (fit === 'fill') {
    return { x: 0, y: 0, width: pageWidth, height: pageHeight };
  }

  const imageRatio = imageWidth / imageHeight;
  const pageRatio = pageWidth / pageHeight;
  let width;
  let height;

  if (fit === 'cover') {
    if (imageRatio > pageRatio) {
      height = pageHeight;
      width = height * imageRatio;
    } else {
      width = pageWidth;
      height = width / imageRatio;
    }
  } else {
    if (imageRatio > pageRatio) {
      width = pageWidth;
      height = width / imageRatio;
    } else {
      height = pageHeight;
      width = height * imageRatio;
    }
  }

  return {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height
  };
}

async function getImageDataUrl(template, url) {
  if (template.file instanceof File) {
    return readBlobAsDataUrl(template.file);
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error('Não foi possível ler a imagem interna.');
  const blob = await res.blob();
  return readBlobAsDataUrl(blob);
}

async function renderLabelImageToJpeg(template, settings) {
  const url = getLabelUrl(template);
  const dataUrl = await getImageDataUrl(template, url);
  const img = await loadImageFromUrl(dataUrl);

  const dpi = 203;
  const pxPerMm = dpi / 25.4;
  const canvasWidth = Math.max(1, Math.round(settings.width * pxPerMm));
  const canvasHeight = Math.max(1, Math.round(settings.height * pxPerMm));
  const paddingPx = Math.max(0, Math.round(settings.padding * pxPerMm));
  const scaleFactor = Math.max(0.1, (Number(settings.scale) || 100) / 100);
  const manualRotate = Number(settings.rotate) || 0;
  const autoRotate = settings.autoRotate ? getAutoLabelRotation(img.naturalWidth, img.naturalHeight, settings.width, settings.height) : 0;
  const rotate = (autoRotate + manualRotate) % 360;

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  ctx.save();

  const availableWidth = Math.max(1, canvasWidth - paddingPx * 2);
  const availableHeight = Math.max(1, canvasHeight - paddingPx * 2);
  const rotated = rotate === 90 || rotate === 270;
  const sourceWidth = rotated ? img.naturalHeight : img.naturalWidth;
  const sourceHeight = rotated ? img.naturalWidth : img.naturalHeight;
  const rect = getImageDrawRect(sourceWidth, sourceHeight, availableWidth, availableHeight, settings.fit);
  const drawWidth = rect.width * scaleFactor;
  const drawHeight = rect.height * scaleFactor;
  const drawX = paddingPx + rect.x + (rect.width - drawWidth) / 2;
  const drawY = paddingPx + rect.y + (rect.height - drawHeight) / 2;

  ctx.beginPath();
  ctx.rect(paddingPx, paddingPx, availableWidth, availableHeight);
  ctx.clip();

  if (rotate) {
    ctx.translate(drawX + drawWidth / 2, drawY + drawHeight / 2);
    ctx.rotate((rotate * Math.PI) / 180);
    if (rotated) {
      ctx.drawImage(img, -drawHeight / 2, -drawWidth / 2, drawHeight, drawWidth);
    } else {
      ctx.drawImage(img, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    }
  } else {
    ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
  }

  ctx.restore();

  const jpegBlob = await canvasToBlob(canvas, 'image/jpeg', 0.94);
  const jpegBuffer = await blobToArrayBuffer(jpegBlob);

  return {
    bytes: new Uint8Array(jpegBuffer),
    widthPx: canvasWidth,
    heightPx: canvasHeight
  };
}

function makePdfFromJpeg(jpeg, widthMm, heightMm) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;

  const addText = text => {
    const bytes = encoder.encode(text);
    chunks.push(bytes);
    length += bytes.length;
  };

  const addBytes = bytes => {
    chunks.push(bytes);
    length += bytes.length;
  };

  const object = (id, content) => {
    offsets[id] = length;
    addText(`${id} 0 obj\n${content}\nendobj\n`);
  };

  const widthPt = widthMm * 72 / 25.4;
  const heightPt = heightMm * 72 / 25.4;
  const content = `q\n${widthPt.toFixed(4)} 0 0 ${heightPt.toFixed(4)} 0 0 cm\n/Im0 Do\nQ`;

  addText('%PDF-1.4\n%âãÏÓ\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt.toFixed(4)} ${heightPt.toFixed(4)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);

  offsets[4] = length;
  addText(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${jpeg.widthPx} /Height ${jpeg.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.bytes.length} >>\nstream\n`);
  addBytes(jpeg.bytes);
  addText('\nendstream\nendobj\n');

  object(5, `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`);

  const xrefOffset = length;
  addText('xref\n0 6\n0000000000 65535 f \n');
  for (let i = 1; i <= 5; i++) {
    addText(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  }
  addText(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const pdfBytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    pdfBytes.set(chunk, offset);
    offset += chunk.length;
  }

  return new Blob([pdfBytes], { type: 'application/pdf' });
}

function sendPdfToPrintProxy(pdfBlob, fileName, settings, repeatTimes) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('begin_page', '1');
    form.append('end_page', '1');
    form.append('file', pdfBlob, fileName || 'etiqueta.pdf');
    form.append('height', String(settings.height));
    form.append('orientation', '1');
    form.append('repeat_times', String(repeatTimes));
    form.append('scale', '100');
    form.append('width', String(settings.width));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://printproxy.wms.shopeemobile.com:21317/api/v2/print_pdf_file', true);
    xhr.onload = () => {
      const ok = xhr.status >= 200 && xhr.status < 300;
      if (!ok) {
        reject(new Error(`Serviço de impressão retornou HTTP ${xhr.status}.`));
        return;
      }

      try {
        const parsed = JSON.parse(xhr.responseText || '{}');
        if (parsed.retcode !== 0) {
          reject(new Error(parsed.message || `Serviço de impressão retornou retcode ${parsed.retcode}.`));
          return;
        }
      } catch (e) {}

      resolve(xhr.responseText);
    };
    xhr.onerror = () => reject(new Error('Falha ao enviar para a impressora. Verifique se o serviço de impressão está aberto.'));
    xhr.send(form);
  });
}

async function printLabelViaProxy(template, labelTypeKey, repeatTimes) {
  const url = getLabelUrl(template);
  if (!url) {
    toast('Etiqueta não encontrada.');
    return;
  }

  const settings = getLabelPrintSettings(labelTypeKey);
  const qty = Math.max(1, Math.min(999, Math.floor(Number(repeatTimes) || 1)));

  try {
    labelPrinting = true;
    updateLabelModalLoading(true);
    setLabelProgress(15, `Preparando etiqueta ${settings.labelType} (${settings.width}x${settings.height}mm)...`);
    const jpeg = await renderLabelImageToJpeg(template, settings);
    setLabelProgress(45, 'Montando arquivo de impressão...');
    const pdfBlob = makePdfFromJpeg(jpeg, settings.width, settings.height);
    setLabelProgress(70, 'Enviando para a impressora...');
    await sendPdfToPrintProxy(pdfBlob, `${template.nome || 'etiqueta'}.pdf`, settings, qty);
    setLabelProgress(100, `Enviado para impressão: ${qty}x • ${settings.labelType} ${settings.width}x${settings.height}mm • rotação automática.`);
    closeLabelPrintModal();
    toast('Etiqueta enviada para impressão.');
    setTimeout(() => setLabelProgress(0, 'Selecione uma etiqueta cadastrada para imprimir.'), 3500);
  } catch (e) {
    setLabelProgress(0, e.message || 'Erro ao imprimir etiqueta.');
    toast(e.message || 'Erro ao imprimir etiqueta.');
  } finally {
    labelPrinting = false;
    updateLabelModalLoading(false);
  }
}

function setLabelModalType(type) {
  activeLabelType = LABEL_TYPES[type] ? type : 'small';
  ['small', 'large'].forEach(key => {
    const btn = key === 'small' ? $('labelTypeSmall') : $('labelTypeLarge');
    if (btn) btn.classList.toggle('selected', key === activeLabelType);
  });
}

function getLabelModalQty() {
  const input = $('labelQtyInput');
  const value = Math.max(1, Math.min(999, Math.floor(Number(input?.value) || 1)));
  if (input) input.value = String(value);
  return value;
}

function setLabelModalQty(value) {
  const input = $('labelQtyInput');
  const qty = Math.max(1, Math.min(999, Math.floor(Number(value) || 1)));
  if (input) input.value = String(qty);
}

function updateLabelModalLoading(loading) {
  const printBtn = $('labelModalPrint');
  const cancelBtn = $('labelModalCancel');
  const closeBtn = $('labelModalClose');
  const smallBtn = $('labelTypeSmall');
  const largeBtn = $('labelTypeLarge');
  const qtyInput = $('labelQtyInput');
  const minusBtn = $('labelQtyMinus');
  const plusBtn = $('labelQtyPlus');

  [printBtn, cancelBtn, closeBtn, smallBtn, largeBtn, qtyInput, minusBtn, plusBtn].forEach(el => {
    if (el) el.disabled = !!loading;
  });

  if (printBtn) printBtn.textContent = loading ? 'Imprimindo...' : 'Imprimir etiqueta';
}

function openLabelPrintModal(template) {
  activeLabelTemplate = template;
  setLabelModalType('small');
  setLabelModalQty(1);

  if ($('labelModalTitle')) $('labelModalTitle').textContent = template.nome || 'Imprimir etiqueta';
  if ($('labelModalSubtitle')) $('labelModalSubtitle').textContent = 'Selecione o formato da etiqueta e a quantidade.';
  if ($('labelModalImage')) $('labelModalImage').src = getLabelUrl(template);

  const modal = $('labelPrintModal');
  if (modal) {
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
  }
}

function closeLabelPrintModal() {
  if (labelPrinting) return;
  const modal = $('labelPrintModal');
  if (modal) {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }
  activeLabelTemplate = null;
}

function submitLabelPrintModal() {
  if (!activeLabelTemplate || labelPrinting) return;
  printLabelViaProxy(activeLabelTemplate, activeLabelType, getLabelModalQty());
}

function renderLabelTemplates() {
  const list = $('labelList');
  if (!list) return;
  const templates = getAllLabelTemplates();
  list.innerHTML = '';

  if (!templates.length) {
    const empty = document.createElement('div');
    empty.className = 'emptyLabels';
    empty.innerHTML = '<strong>Nenhuma etiqueta cadastrada.</strong><span>Coloque imagens PNG, JPG, WEBP, GIF, BMP ou SVG na pasta /etiquetas e atualize o catálogo.</span>';
    list.appendChild(empty);
    setLabelStatus(packageLabelLoadMessage || 'Nenhuma etiqueta cadastrada.');
    return;
  }

  templates.forEach(template => {
    const card = document.createElement('article');
    card.className = 'labelCard';

    const preview = document.createElement('div');
    preview.className = 'labelPreview';
    const img = document.createElement('img');
    img.src = getLabelUrl(template);
    img.alt = template.nome;
    img.loading = 'lazy';
    preview.appendChild(img);

    const body = document.createElement('div');
    body.className = 'labelCardBody';

    const title = document.createElement('h3');
    title.textContent = template.nome;

    const meta = document.createElement('div');
    meta.className = 'labelMeta';
    meta.textContent = template.source === 'package' ? 'Pasta /etiquetas' : 'Etiqueta selecionada';

    const actions = document.createElement('div');
    actions.className = 'labelActions';

    const printBtn = document.createElement('button');
    printBtn.className = 'primary';
    printBtn.textContent = 'Imprimir';
    printBtn.addEventListener('click', () => openLabelPrintModal(template));

    actions.appendChild(printBtn);
    body.appendChild(title);
    body.appendChild(meta);
    body.appendChild(actions);
    card.appendChild(preview);
    card.appendChild(body);
    list.appendChild(card);
  });

  const packageCount = packageLabelTemplates.length;
  const localCount = localLabelTemplates.length;
  const parts = [];
  if (packageCount) parts.push(`${packageCount} etiqueta(s) cadastrada(s)`);
    if (packageLabelLoadMessage && !packageCount) parts.push(packageLabelLoadMessage);
  setLabelStatus(parts.join(' • ') || `${templates.length} etiqueta(s) carregada(s).`);
}

async function loadLabelTemplates() {
  setLabelStatus('Atualizando catálogo de etiquetas...');
  await loadPackageLabelTemplates();
  renderLabelTemplates();
}

function clearLocalLabelTemplates() {
  localLabelUrls.forEach(url => URL.revokeObjectURL(url));
  localLabelUrls = [];
  localLabelTemplates = [];
  if ($('labelLocalFiles')) $('labelLocalFiles').value = '';
  if ($('labelFolderFiles')) $('labelFolderFiles').value = '';
  renderLabelTemplates();
}

function addLocalLabelFiles(files, sourceLabel) {
  const images = Array.from(files || []).filter(isImageFile);
  localLabelUrls.forEach(url => URL.revokeObjectURL(url));
  localLabelUrls = [];
  localLabelTemplates = images.map((file, index) => {
    const url = URL.createObjectURL(file);
    localLabelUrls.push(url);
    const path = file.webkitRelativePath || file.name;
    return {
      id: 'local_' + index + '_' + path,
      nome: labelNameFromPath(path),
      file,
      path: sourceLabel ? `${sourceLabel}: ${path}` : path,
      url,
      source: 'local'
    };
  });
  renderLabelTemplates();
}

if ($('reloadLabels')) {
  $('reloadLabels').addEventListener('click', async () => {
    await loadLabelTemplates();
  });
}

if ($('clearLocalLabels')) {
  $('clearLocalLabels').addEventListener('click', clearLocalLabelTemplates);
}

if ($('labelFolderFiles')) {
  $('labelFolderFiles').addEventListener('change', () => {
    addLocalLabelFiles($('labelFolderFiles').files, 'Pasta selecionada');
  });
}

if ($('labelLocalFiles')) {
  $('labelLocalFiles').addEventListener('change', () => {
    addLocalLabelFiles($('labelLocalFiles').files, 'Arquivo local');
  });
}

if ($('labelTypeSmall')) $('labelTypeSmall').addEventListener('click', () => setLabelModalType('small'));
if ($('labelTypeLarge')) $('labelTypeLarge').addEventListener('click', () => setLabelModalType('large'));
if ($('labelQtyMinus')) $('labelQtyMinus').addEventListener('click', () => setLabelModalQty(getLabelModalQty() - 1));
if ($('labelQtyPlus')) $('labelQtyPlus').addEventListener('click', () => setLabelModalQty(getLabelModalQty() + 1));
if ($('labelQtyInput')) $('labelQtyInput').addEventListener('change', () => setLabelModalQty(getLabelModalQty()));
if ($('labelModalCancel')) $('labelModalCancel').addEventListener('click', closeLabelPrintModal);
if ($('labelModalClose')) $('labelModalClose').addEventListener('click', closeLabelPrintModal);
if ($('labelModalPrint')) $('labelModalPrint').addEventListener('click', submitLabelPrintModal);
if ($('labelPrintModal')) {
  $('labelPrintModal').addEventListener('click', event => {
    if (event.target === $('labelPrintModal')) closeLabelPrintModal();
  });
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('labelPrintModal')?.classList.contains('show')) {
    closeLabelPrintModal();
  }
});

resetAuditAutoUi();
startAuditAutoCounter();
loadLabelTemplates();
