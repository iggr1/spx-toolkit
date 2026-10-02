const SPREADSHEET_ID = '1AivxIuOF9oroLetGp5t4lVn1uARxNBl-3XCJtJrg37c';
const DEFAULT_SHEET_NAME = 'Base_ATs';
const DATE_TIME_FORMAT = 'dd/MM/yyyy HH:mm:ss';
const TIMEZONE = 'America/Sao_Paulo';

const DATE_TIME_FIELDS = new Set([
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
]);

function doGet() {
  return jsonOutput({ ok: true, service: 'SPX Toolkit Base ATs' });
}

function doPost(e) {
  const startedAt = Date.now();
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    const payload = parsePayload(e);
    const action = String(payload.action || '').trim();

    if (!['compareAssignmentTasks', 'upsertAssignmentTasks'].includes(action)) {
      throw new Error('Ação inválida.');
    }

    const sheetName = String(payload.sheetName || DEFAULT_SHEET_NAME).trim() || DEFAULT_SHEET_NAME;
    const keyField = String(payload.keyField || 'assignment_task_id').trim();
    const headers = normalizeHeaders(payload.headers);

    if (!headers.length) throw new Error('Cabeçalho vazio.');
    if (!headers.includes(keyField)) throw new Error('Campo chave não encontrado no cabeçalho.');

    const ss = SPREADSHEET_ID
      ? SpreadsheetApp.openById(SPREADSHEET_ID)
      : SpreadsheetApp.getActiveSpreadsheet();

    if (!ss) throw new Error('Planilha não encontrada.');

    try {
      ss.setSpreadsheetTimeZone(TIMEZONE);
    } catch (err) {}

    const sheet = getOrCreateSheet(ss, sheetName);
    ensureHeaders(sheet, headers);

    if (action === 'compareAssignmentTasks') {
      const signatures = Array.isArray(payload.signatures) ? payload.signatures : [];
      const result = compareAssignmentTasks(sheet, headers, keyField, signatures);

      return jsonOutput({
        ok: true,
        sheetName,
        received: signatures.length,
        changed: result.changedKeys.length,
        unchanged: result.unchanged,
        missing: result.missing,
        different: result.different,
        changedKeys: result.changedKeys,
        durationMs: Date.now() - startedAt
      });
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    const result = upsertRows(sheet, headers, keyField, items);

    return jsonOutput({
      ok: true,
      sheetName,
      received: items.length,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.unchanged,
      skipped: result.skipped,
      writeMode: result.writeMode,
      durationMs: Date.now() - startedAt
    });
  } catch (err) {
    return jsonOutput({
      ok: false,
      error: String(err && err.message ? err.message : err),
      durationMs: Date.now() - startedAt
    });
  } finally {
    try {
      lock.releaseLock();
    } catch (err) {}
  }
}

function parsePayload(e) {
  const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
  return JSON.parse(raw);
}

function normalizeHeaders(headers) {
  return (Array.isArray(headers) ? headers : [])
    .map(header => String(header || '').trim())
    .filter(Boolean);
}

function getOrCreateSheet(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function ensureHeaders(sheet, headers) {
  const lastColumn = sheet.getLastColumn();
  const current = lastColumn
    ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(value => String(value || '').trim())
    : [];

  if (!current.some(Boolean)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return;
  }

  const next = current.slice();
  let changed = false;

  headers.forEach((header, index) => {
    if (next.includes(header)) return;

    if (!next[index]) {
      next[index] = header;
    } else {
      next.push(header);
    }

    changed = true;
  });

  if (changed) {
    sheet.getRange(1, 1, 1, next.length).setValues([next]);
  }

  sheet.setFrozenRows(1);
}

function getHeaderMap(sheet) {
  const lastColumn = sheet.getLastColumn();

  if (!lastColumn) return {};

  const values = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const map = {};

  values.forEach((value, index) => {
    const key = String(value || '').trim();
    if (key && map[key] === undefined) map[key] = index + 1;
  });

  return map;
}

function compareAssignmentTasks(sheet, headers, keyField, signatures) {
  const headerMap = getHeaderMap(sheet);
  const keyColumn = headerMap[keyField];

  if (!keyColumn) throw new Error('Coluna chave não encontrada na planilha.');

  const writeWidth = getWriteWidth(headerMap, headers);
  const existingRowCount = Math.max(sheet.getLastRow() - 1, 0);
  const existingValues = existingRowCount
    ? sheet.getRange(2, 1, existingRowCount, writeWidth).getValues()
    : [];

  const existingSignatures = {};

  existingValues.forEach(row => {
    const key = String(row[keyColumn - 1] || '').trim();
    if (!key || existingSignatures[key] !== undefined) return;
    existingSignatures[key] = buildAssignmentRowSignature(row, headers, headerMap);
  });

  const changedKeys = [];
  const seen = {};
  let unchanged = 0;
  let missing = 0;
  let different = 0;

  signatures.forEach(entry => {
    const key = String(entry && entry.key != null ? entry.key : '').trim();
    const signature = String(entry && entry.signature != null ? entry.signature : '').trim();

    if (!key || !signature || seen[key]) return;

    seen[key] = true;
    const current = existingSignatures[key];

    if (current === undefined) {
      changedKeys.push(key);
      missing += 1;
      return;
    }

    if (current !== signature) {
      changedKeys.push(key);
      different += 1;
      return;
    }

    unchanged += 1;
  });

  return { changedKeys, unchanged, missing, different };
}

function upsertRows(sheet, headers, keyField, items) {
  const headerMap = getHeaderMap(sheet);
  const keyColumn = headerMap[keyField];

  if (!keyColumn) throw new Error('Coluna chave não encontrada na planilha.');

  const lastRow = sheet.getLastRow();
  const writeWidth = getWriteWidth(headerMap, headers);
  const existingRowCount = Math.max(lastRow - 1, 0);
  const existingValues = existingRowCount
    ? sheet.getRange(2, 1, existingRowCount, writeWidth).getValues()
    : [];

  const keyIndex = {};

  existingValues.forEach((row, index) => {
    const key = String(row[keyColumn - 1] || '').trim();
    if (key && keyIndex[key] === undefined) keyIndex[key] = index;
  });

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const rowsToAppend = [];
  const pendingNewIndex = {};
  const updatedIndexes = [];

  items.forEach(item => {
    const key = String(item && item[keyField] != null ? item[keyField] : '').trim();

    if (!key) {
      skipped += 1;
      return;
    }

    const existingIndex = keyIndex[key];

    if (existingIndex !== undefined) {
      const currentRow = existingValues[existingIndex];

      if (rowMatchesItem(currentRow, item, headers, headerMap)) {
        unchanged += 1;
        return;
      }

      existingValues[existingIndex] = mergeItemIntoRow(currentRow, item, headers, headerMap);
      updatedIndexes.push(existingIndex);
      updated += 1;
      return;
    }

    if (pendingNewIndex[key] !== undefined) {
      rowsToAppend[pendingNewIndex[key]] = buildRowValues(headers, headerMap, writeWidth, item);
      return;
    }

    pendingNewIndex[key] = rowsToAppend.length;
    rowsToAppend.push(buildRowValues(headers, headerMap, writeWidth, item));
    inserted += 1;
  });

  const writeMode = writeChangedRows(sheet, existingValues, updatedIndexes, writeWidth);

  if (rowsToAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, writeWidth).setValues(rowsToAppend);
  }

  if (updatedIndexes.length || rowsToAppend.length) {
    ensureDateTimeFormats(sheet, headers);
  }

  return { inserted, updated, unchanged, skipped, writeMode };
}

function getWriteWidth(headerMap, headers) {
  return headers.reduce((max, header) => Math.max(max, headerMap[header] || 0), 1);
}

function buildRowValues(headers, headerMap, width, item) {
  const row = Array(width).fill('');

  headers.forEach(header => {
    const column = headerMap[header];
    if (!column) return;

    const value = item && item[header] != null ? item[header] : '';
    row[column - 1] = normalizeCellValue(header, value);
  });

  return row;
}

function mergeItemIntoRow(currentRow, item, headers, headerMap) {
  const merged = currentRow.slice();

  headers.forEach(header => {
    const column = headerMap[header];
    if (!column) return;

    const value = item && item[header] != null ? item[header] : '';
    merged[column - 1] = normalizeCellValue(header, value);
  });

  return merged;
}

function rowMatchesItem(row, item, headers, headerMap) {
  return headers.every(header => {
    const column = headerMap[header];
    if (!column) return true;

    const currentValue = row[column - 1];
    const newValue = item && item[header] != null ? item[header] : '';

    return normalizeSignatureValue(header, currentValue) === normalizeSignatureValue(header, newValue);
  });
}

function writeChangedRows(sheet, existingValues, updatedIndexes, width) {
  if (!updatedIndexes.length) return 'append_only';

  const uniqueIndexes = Array.from(new Set(updatedIndexes)).sort((a, b) => a - b);
  let blockStart = uniqueIndexes[0];
  let previous = uniqueIndexes[0];
  let blocks = 0;

  for (let i = 1; i <= uniqueIndexes.length; i += 1) {
    const current = uniqueIndexes[i];

    if (current === previous + 1) {
      previous = current;
      continue;
    }

    const blockValues = existingValues.slice(blockStart, previous + 1);
    sheet.getRange(blockStart + 2, 1, blockValues.length, width).setValues(blockValues);
    blocks += 1;

    blockStart = current;
    previous = current;
  }

  return blocks === 1 ? 'single_block_update' : 'block_update';
}

function ensureDateTimeFormats(sheet, headers) {
  const headerMap = getHeaderMap(sheet);
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const rowCount = Math.max(lastRow - 1, 1);

  headers.forEach(header => {
    if (!isDateTimeField(header)) return;

    const column = headerMap[header];
    if (!column) return;

    sheet.getRange(2, column, rowCount, 1).setNumberFormat(DATE_TIME_FORMAT);
  });
}

function normalizeCellValue(header, value) {
  if (!isDateTimeField(header)) return value;

  const date = parseDateTimeValue(value);
  if (!date) return value === 0 || value === '0' ? '' : value;

  return date;
}

function isDateTimeField(header) {
  const key = String(header || '').trim().toLowerCase();

  if (DATE_TIME_FIELDS.has(key)) return true;
  if (key.endsWith('_at')) return true;
  if (key.endsWith('_date')) return true;
  if (key.endsWith('_datetime')) return true;

  return false;
}

function buildAssignmentRowSignature(row, headers, headerMap) {
  const values = headers.map(header => {
    const column = headerMap[header];
    return normalizeSignatureValue(header, column ? row[column - 1] : '');
  });

  return hashAssignmentSignature(JSON.stringify(values));
}

function normalizeSignatureValue(header, value) {
  if (isDateTimeField(header)) {
    const date = parseDateTimeValue(value);
    return date ? String(Math.floor(date.getTime() / 1000)) : value === 0 || value === '0' ? '' : stableAssignmentValue(value);
  }

  return stableAssignmentValue(value);
}

function stableAssignmentValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;

  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isValidDate(value) ? String(Math.floor(value.getTime() / 1000)) : '';
  }

  if (Array.isArray(value)) {
    return '[' + value.map(stableAssignmentValue).join(',') + ']';
  }

  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableAssignmentValue(value[key])).join(',') + '}';
  }

  return String(value);
}

function hashAssignmentSignature(text) {
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return ('00000000' + hash.toString(16)).slice(-8);
}

function parseDateTimeValue(value) {
  if (value === null || value === undefined || value === '') return null;

  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isValidDate(value) ? value : null;
  }

  if (typeof value === 'number') {
    return parseTimestamp(value);
  }

  const text = String(value).trim();
  if (!text) return null;

  if (/^\d+(\.\d+)?$/.test(text)) {
    return parseTimestamp(Number(text));
  }

  let match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    return buildDate(
      Number(match[3]),
      Number(match[2]),
      Number(match[1]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0)
    );
  }

  match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (match) {
    return buildDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0)
    );
  }

  const parsed = new Date(text);
  return isValidDate(parsed) && isAcceptableDate(parsed) ? parsed : null;
}

function parseTimestamp(value) {
  if (!Number.isFinite(value) || value <= 0) return null;

  let ms = value;

  if (value > 99999999999999) {
    ms = Math.floor(value / 1000);
  } else if (value > 9999999999) {
    ms = value;
  } else if (value > 999999999) {
    ms = value * 1000;
  } else {
    return null;
  }

  const date = new Date(ms);
  return isValidDate(date) && isAcceptableDate(date) ? date : null;
}

function buildDate(year, month, day, hour, minute, second) {
  const date = new Date(year, month - 1, day, hour, minute, second);

  if (!isValidDate(date)) return null;
  if (!isAcceptableDate(date)) return null;

  return date;
}

function isValidDate(date) {
  return date instanceof Date && !isNaN(date.getTime());
}

function isAcceptableDate(date) {
  const year = date.getFullYear();
  return year >= 2000 && year <= 2100;
}

function jsonOutput(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
