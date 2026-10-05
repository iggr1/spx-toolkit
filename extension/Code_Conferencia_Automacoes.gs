const ALLOWED_SHEETS = new Set([
  "Conferencia",
  "Conferencia_AT_List",
  "Order_Refresh",
  "OrderRefresh",
  "PendingReturns",
  "Devoluções Pendentes",
  "Devolucoes_Pendentes",
  "Relatório Parcel Sweeper"
]);

const CONFIG = {
  SPREADSHEET_ID: "1EUvWMH6zbLHiWEtzY9SmiW1W0bDHUKmLGjs_ZJGBw9c",
  KEY_FIELDS: {
    Conferencia: ["validation_task_id"],
    Conferencia_AT_List: ["vt_task_id", "target_id"],
    Order_Refresh: ["Order ID"]
  },
  RECENCY_FIELDS: {
    Conferencia: ["end_time", "create_time"],
    Conferencia_AT_List: ["validation_end_time", "validation_start_time", "revalidation_time"],
    Order_Refresh: [
      "Delivered Time",
      "Delivering Time",
      "OnHold Time",
      "Current Station Received Time",
      "LM Hub Receive time",
      "SLA Target Date"
    ]
  },
  WRITE_CHUNK: 400
};

const DATETIME_FIELDS = new Set([
  "create_time",
  "end_time",
  "validation_start_time",
  "validation_end_time",
  "revalidation_time",
  "conference_first_create_time",
  "conference_last_create_time",
  "LM Hub Receive time",
  "Pick Up Time",
  "SOC Received time",
  "Current Station Received Time",
  "Delivering Time",
  "Delivered Time",
  "OnHold Time",
  "Reschedule Date",
  "Reschedule Time",
  "SLA Target Date",
  "imported_at",
  "Data",
  "Início Tarefa",
  "Fim Tarefa",
  "Scanned Time",
  "Atualizado Em"
]);

const FORCE_TEXT_FIELDS = new Set([
  "validation_task_id",
  "vt_task_id",
  "target_id",
  "shipment_id",
  "task_id",
  "sls_tracking_number",
  "sort_code",
  "operator",
  "event_id",
  "Order ID",
  "SLS Tracking Number",
  "Shopee Order SN",
  "Zipcode Name",
  "Postal Code",
  "Buyer Phone",
  "Driver ID",
  "Driver Phone",
  "Manifest Number",
  "Shop ID",
  "3PL TN",
  "Return Destination",
  "export_task_id",
  "Tarefa PS",
  "BR",
  "Sort Code",
  "Operador Tarefa",
  "Operador Conclusão",
  "Operador Pedido"
]);

const CONFERENCIA_DERIVED_FIELDS = [
  "not_validate_qty",
  "in_progress_qty",
  "validated_qty",
  "deviated_qty",
  "ok_qty",
  "missort_qty",
  "duplicated_qty",
  "added_qty",
  "missing_qty",
  "unknown_qty",
  "exception_qty"
];

const ORDER_REFRESH_META_FIELDS = [
  "imported_at",
  "export_task_id",
  "export_file_name",
  "download_url"
];

const PENDING_RETURNS_META_FIELDS = [
  "imported_at",
  "export_task_id",
  "export_file_name",
  "download_url"
];

function doPost(e) {
  try {
    const payload = parsePostPayload_(e);
    const parcelSweeperResult = handleParcelSweeperAction_(payload);
    if (parcelSweeperResult) return jsonOutput_(parcelSweeperResult);

    const items = Array.isArray(payload.items) ? payload.items : [payload];

    if (!items.length) {
      throw new Error("Payload vazio.");
    }

    const results = importBatch_(items);

    return jsonOutput_({
      ok: true,
      count: results.length,
      results
    });
  } catch (err) {
    return jsonOutput_({
      ok: false,
      error: String(err && err.message ? err.message : err)
    });
  }
}

function parsePostPayload_(e) {
  const contents = e && e.postData && e.postData.contents ? String(e.postData.contents) : "";

  if (!contents.trim()) {
    throw new Error("Body vazio.");
  }

  try {
    return JSON.parse(contents);
  } catch (err) {
    return {
      sheetName: "Order_Refresh",
      importType: "OrderRefresh",
      csvText: contents
    };
  }
}

function importOneSheet_(payload) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const prepared = normalizeIncomingPayload_(payload);

  if (prepared.sheetName === "Order_Refresh") {
    const result = replaceOrderRefreshSheet_(
      ss,
      prepared.header,
      prepared.normalized.objects,
      prepared.meta
    );

    return {
      ok: true,
      sheetName: prepared.sheetName,
      ...result
    };
  }

  if (prepared.sheetName === "Devoluções Pendentes") {
    const result = replacePendingReturnsSheet_(
      ss,
      prepared.header,
      prepared.normalized.objects,
      prepared.meta
    );

    return {
      ok: true,
      sheetName: prepared.sheetName,
      ...result
    };
  }

  if (prepared.sheetName === "Conferencia") {
    addDurationToConferencia_(prepared.header, prepared.normalized);
  }

  const result = upsertSheetFast_(
    ss,
    prepared.sheetName,
    prepared.header,
    prepared.normalized.objects
  );

  return {
    ok: true,
    sheetName: prepared.sheetName,
    ...result
  };
}

function normalizeRows_(header, rows) {
  const objects = [];
  const values = [];
  const idxRatio = header.indexOf("validated_target_qty_ratio");

  for (let i = 0; i < rows.length; i++) {
    const arr = header.map((_, c) =>
      rows[i] && rows[i][c] !== undefined && rows[i][c] !== null ? rows[i][c] : ""
    );

    if (idxRatio !== -1) {
      arr[idxRatio] = parsePercent_(arr[idxRatio]);
    }

    values.push(arr);
    objects.push(rowArrayToObject_(header, arr));
  }

  return { values, objects };
}

function parsePercent_(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const m = s.match(/^(\d+(?:[.,]\d+)?)\s*%$/);
  if (!m) return v;
  const num = Number(m[1].replace(",", "."));
  return Number.isFinite(num) ? num / 100 : v;
}

function addDurationToConferencia_(header, normalized) {
  const idxCreate = header.indexOf("create_time");
  const idxEnd = header.indexOf("end_time");

  if (idxCreate === -1 || idxEnd === -1) return;
  if (header.includes("duration")) return;

  const insertAt = idxEnd + 1;
  header.splice(insertAt, 0, "duration");

  for (let i = 0; i < normalized.values.length; i++) {
    normalized.values[i].splice(
      insertAt,
      0,
      minutesDiff_(normalized.values[i][idxCreate], normalized.values[i][idxEnd])
    );
  }

  for (let i = 0; i < normalized.objects.length; i++) {
    normalized.objects[i].duration = minutesDiff_(
      normalized.objects[i].create_time,
      normalized.objects[i].end_time
    );
  }
}

function upsertSheetFast_(ss, sheetName, incomingHeader, incomingObjects) {
  sheetName = normalizeSheetName_(sheetName);

  const sh = getOrCreateSheet_(ss, sheetName);
  const existingLastRow = sh.getLastRow();
  const existingLastCol = sh.getLastColumn();

  if (existingLastRow === 0) {
    const data = incomingObjects.map(o => objectToRowArray_(incomingHeader, o));
    const cols = coerceDatesInMatrix_(incomingHeader, data);
    forceTextInMatrix_(incomingHeader, data);

    writeChunked_(sh, 1, incomingHeader.length, [incomingHeader].concat(data), CONFIG.WRITE_CHUNK);
    applyTextFormats_(sh, incomingHeader);
    applyDateFormats_(sh, cols.dateTimeCols);
    applyDurationFormat_(sh, incomingHeader);
    applyPercentFormats_(sh, incomingHeader);

    return {
      mode: "insert_all",
      headerColumns: incomingHeader.length,
      inserted: data.length,
      updated: 0,
      skipped: 0
    };
  }

  const existingHeader = sh.getRange(1, 1, 1, existingLastCol).getValues()[0].map(String);
  const mergedHeader = mergeHeaders_(existingHeader, incomingHeader);

  if (mergedHeader.length !== existingHeader.length) {
    sh.getRange(1, 1, 1, mergedHeader.length).setValues([mergedHeader]);
  }

  const keyFields = CONFIG.KEY_FIELDS[sheetName];
  const recFields = CONFIG.RECENCY_FIELDS[sheetName] || [];
  const colMap = headerIndexMap_(mergedHeader);

  const keyColIdxs = keyFields.map(f => colMap.get(f)).filter(i => i !== undefined);
  if (keyColIdxs.length !== keyFields.length) {
    throw new Error("Header faltando KEY_FIELDS em " + sheetName + ": " + keyFields.join(", "));
  }

  const recColIdxs = recFields.map(f => colMap.get(f)).filter(i => i !== undefined);
  const numExistingRows = Math.max(0, existingLastRow - 1);

  const existingMatrix = numExistingRows > 0
    ? sh.getRange(2, 1, numExistingRows, mergedHeader.length).getValues()
    : [];

  const index = new Map();

  for (let i = 0; i < numExistingRows; i++) {
    const row = existingMatrix[i];
    const key = buildKeyFromRow_(mergedHeader, row, keyColIdxs);
    if (!key) continue;

    index.set(key, {
      rowNumber: i + 2,
      recency: pickMaxTimeFromRow_(mergedHeader, row, recColIdxs),
      rowValues: row
    });
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const updatesByRow = new Map();
  const inserts = [];

  for (let i = 0; i < incomingObjects.length; i++) {
    const obj = incomingObjects[i];
    const key = buildKeyFromObj_(sheetName, obj);

    if (!key) {
      skipped++;
      continue;
    }

    const recNew = pickMaxTimeFromObj_(obj, recFields);
    const found = index.get(key);
    const rowValues = objectToRowArray_(mergedHeader, obj);

    coerceDatesInMatrix_(mergedHeader, [rowValues]);
    forceTextInMatrix_(mergedHeader, [rowValues]);

    if (!found) {
      inserts.push(rowValues);
      inserted++;
      index.set(key, { rowNumber: -1, recency: recNew, rowValues });
      continue;
    }

    const isOpen = isOpenAuditRow_(sheetName, obj, rowValues, mergedHeader);
    const changed = rowsAreDifferent_(found.rowValues, rowValues);

    if (recNew > found.recency || (isOpen && changed)) {
      updatesByRow.set(found.rowNumber, rowValues);
      updated++;
      index.set(key, {
        rowNumber: found.rowNumber,
        recency: Math.max(found.recency || 0, recNew || 0),
        rowValues
      });
    } else {
      skipped++;
    }
  }

  applyUpdatesChunked_(sh, mergedHeader.length, updatesByRow);
  appendChunked_(sh, mergedHeader.length, inserts, CONFIG.WRITE_CHUNK);

  const cols = getDateColsFromHeader_(mergedHeader);
  applyTextFormats_(sh, mergedHeader);
  applyDateFormats_(sh, cols.dateTimeCols);
  applyDurationFormat_(sh, mergedHeader);
  applyPercentFormats_(sh, mergedHeader);

  return {
    mode: "upsert",
    headerColumns: mergedHeader.length,
    inserted,
    updated,
    skipped
  };
}

function buildKeyFromRow_(header, row, keyColIdxs) {
  const parts = [];
  for (let i = 0; i < keyColIdxs.length; i++) {
    const c1 = keyColIdxs[i];
    parts.push(normalizeKeyValue_(header[c1 - 1], row[c1 - 1]));
  }
  return parts.join("|").replace(/\|+$/g, "").trim();
}

function pickMaxTimeFromRow_(header, row, recColIdxs) {
  let best = 0;
  for (let i = 0; i < recColIdxs.length; i++) {
    const c1 = recColIdxs[i];
    const t = parseDdMmYyyyHms_(row[c1 - 1]);
    if (t > best) best = t;
  }
  return best;
}

function isOpenAuditRow_(sheetName, obj, rowValues, header) {
  if (sheetName === "Conferencia") {
    const idx = header.indexOf("end_time");
    const raw = idx === -1 ? obj.end_time : rowValues[idx];
    return isBlankTimeValue_(raw);
  }

  if (sheetName === "Conferencia_AT_List") {
    const idxStart = header.indexOf("validation_start_time");
    const idxEnd = header.indexOf("validation_end_time");

    const startRaw = idxStart === -1 ? obj.validation_start_time : rowValues[idxStart];
    const endRaw = idxEnd === -1 ? obj.validation_end_time : rowValues[idxEnd];

    return isBlankTimeValue_(startRaw) || isBlankTimeValue_(endRaw);
  }

  return false;
}

function isBlankTimeValue_(v) {
  if (v === null || v === undefined || v === "") return true;
  if (v === 0) return true;
  const s = String(v).trim();
  if (!s || s === "0") return true;
  return parseToDate_(v) === null;
}

function rowsAreDifferent_(oldRow, newRow) {
  if (!oldRow || !newRow) return true;
  if (oldRow.length !== newRow.length) return true;

  for (let i = 0; i < oldRow.length; i++) {
    const a = normalizeCompareValue_(oldRow[i]);
    const b = normalizeCompareValue_(newRow[i]);
    if (a !== b) return true;
  }

  return false;
}

function normalizeCompareValue_(v) {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? "" : String(v.getTime());
  }
  if (typeof v === "number") return String(v);
  return String(v).trim();
}

const PARCEL_SWEEPER_SHEET = "Relatório Parcel Sweeper";
const PARCEL_SWEEPER_CONTROL_SHEET = "_Parcel Sweeper Controle";
const PARCEL_SWEEPER_HEADERS = [
  "Data",
  "Tarefa PS",
  "Task Type",
  "Status Tarefa",
  "Tarefa Completa",
  "Expected",
  "Total",
  "Scanned",
  "Exception",
  "Liquidate",
  "Backlog",
  "Misplaced",
  "Processed",
  "Missing",
  "Unscanned",
  "Can View Action",
  "Need Alert Scan Time",
  "Disposal",
  "Expected Scanned",
  "Expected Scanned Rate",
  "Expected Scanned Rate Str",
  "Unscanned Order Count",
  "Início Tarefa",
  "Fim Tarefa",
  "Operador Tarefa",
  "Operador Conclusão",
  "BR",
  "Order Status",
  "Sort Code",
  "Próxima Ação",
  "On Hold Times",
  "Count Type",
  "Inventory",
  "Operador Pedido",
  "Holding Time",
  "Scanned Time",
  "Scanned Order Status",
  "Final Order Status",
  "Next Step Action Int",
  "Expedite Tag",
  "Atualizado Em"
];
const PARCEL_SWEEPER_CONTROL_HEADERS = [
  "Tarefa PS",
  "Data",
  "Status Tarefa",
  "Completa",
  "Pedidos Importados",
  "Total Tarefa",
  "Atualizado Em"
];

function handleParcelSweeperAction_(payload) {
  const action = String(payload && payload.action || "").trim();

  if (action === "parcelSweeperStatus") {
    return {
      ok: true,
      tasks: getParcelSweeperTaskStatus_(payload && payload.taskIds)
    };
  }

  if (action === "parcelSweeperImport") {
    return importParcelSweeperTask_(payload || {});
  }

  return null;
}

function getParcelSweeperTaskStatus_(taskIds) {
  const ids = Array.isArray(taskIds)
    ? taskIds.map(v => String(v || "").trim()).filter(Boolean)
    : [];
  const wanted = new Set(ids);
  const out = {};

  ids.forEach(id => {
    out[id] = {
      complete: false,
      orderCount: 0,
      taskTotal: 0,
      status: 0,
      updatedAt: ""
    };
  });

  if (!ids.length) return out;

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName(PARCEL_SWEEPER_CONTROL_SHEET);
  if (!sh || sh.getLastRow() < 2) return out;

  const values = sh.getDataRange().getValues();
  const header = values[0].map(String);
  const idxTask = header.indexOf("Tarefa PS");
  const idxDate = header.indexOf("Data");
  const idxStatus = header.indexOf("Status Tarefa");
  const idxComplete = header.indexOf("Completa");
  const idxCount = header.indexOf("Pedidos Importados");
  const idxTotal = header.indexOf("Total Tarefa");
  const idxUpdated = header.indexOf("Atualizado Em");

  if (idxTask === -1) return out;

  for (let i = 1; i < values.length; i++) {
    const taskId = String(values[i][idxTask] || "").trim();
    if (!wanted.has(taskId)) continue;

    const rawComplete = idxComplete === -1 ? false : values[i][idxComplete];
    const complete = rawComplete === true || String(rawComplete).toLowerCase() === "true";
    const orderCount = idxCount === -1 ? 0 : Number(values[i][idxCount] || 0);
    const taskTotal = idxTotal === -1 ? 0 : Number(values[i][idxTotal] || 0);

    out[taskId] = {
      complete: !!complete && (taskTotal <= 0 || orderCount >= taskTotal),
      orderCount,
      taskTotal,
      status: idxStatus === -1 ? 0 : Number(values[i][idxStatus] || 0),
      date: idxDate === -1 ? "" : values[i][idxDate],
      updatedAt: idxUpdated === -1 ? "" : values[i][idxUpdated]
    };
  }

  return out;
}

function importParcelSweeperTask_(payload) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const task = payload && payload.task ? payload.task : {};
  const taskId = String(task.task_id || "").trim();
  const orders = Array.isArray(payload && payload.orders) ? payload.orders : [];

  if (!taskId) throw new Error("Parcel Sweeper: task_id vazio.");

  const expectedTotal = Math.max(0, Number(task.total || 0));
  const requestedComplete = payload && payload.complete === true;
  const complete = requestedComplete && (expectedTotal <= 0 || orders.length >= expectedTotal);
  const sh = getOrCreateSheet_(ss, PARCEL_SWEEPER_SHEET);

  let header = PARCEL_SWEEPER_HEADERS.slice();
  const existingLastRow = sh.getLastRow();
  const existingLastCol = sh.getLastColumn();

  if (existingLastRow === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
  } else {
    const existingHeader = sh.getRange(1, 1, 1, existingLastCol).getValues()[0].map(String);
    header = mergeHeaders_(existingHeader, header);
    if (header.length !== existingHeader.length) {
      sh.getRange(1, 1, 1, header.length).setValues([header]);
    }
  }

  const now = new Date();
  const incomingObjects = [];
  const seen = new Set();

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i] || {};
    const shipmentId = String(order.shipment_id || "").trim();
    if (!shipmentId || seen.has(shipmentId)) continue;
    seen.add(shipmentId);

    incomingObjects.push({
      "Data": task.date || "",
      "Tarefa PS": taskId,
      "Task Type": Number(task.task_type || 0),
      "Status Tarefa": Number(task.status || 0),
      "Tarefa Completa": complete,
      "Expected": Number(task.expected || 0),
      "Total": expectedTotal,
      "Scanned": Number(task.scanned || 0),
      "Exception": Number(task.exception || 0),
      "Liquidate": Number(task.liquidate || 0),
      "Backlog": Number(task.backlog || 0),
      "Misplaced": Number(task.misplaced || 0),
      "Processed": Number(task.processed || 0),
      "Missing": Number(task.missing || 0),
      "Unscanned": Number(task.unscanned || 0),
      "Can View Action": task.can_view_action === true,
      "Need Alert Scan Time": task.need_alert_scan_time === true,
      "Disposal": Number(task.disposal || 0),
      "Expected Scanned": Number(task.expected_scanned || 0),
      "Expected Scanned Rate": Number(task.expected_scanned_rate || 0),
      "Expected Scanned Rate Str": task.expected_scanned_rate_str || "",
      "Unscanned Order Count": JSON.stringify(task.unscanned_order_count || {}),
      "Início Tarefa": Number(task.start_time || 0),
      "Fim Tarefa": Number(task.end_time || 0),
      "Operador Tarefa": task.operator || "",
      "Operador Conclusão": task.complete_operator || "",
      "BR": shipmentId,
      "Order Status": Number(order.order_status ?? 0),
      "Sort Code": order.sort_code || "",
      "Próxima Ação": order.next_step_action || "",
      "On Hold Times": Number(order.onhold_times ?? 0),
      "Count Type": Number(order.count_type ?? 0),
      "Inventory": Number(order.inventory ?? 0),
      "Operador Pedido": order.operator || "",
      "Holding Time": order.holding_time_str || "",
      "Scanned Time": Number(order.scanned_time || 0),
      "Scanned Order Status": Number(order.scanned_order_status ?? 0),
      "Final Order Status": Number(order.final_order_status ?? 0),
      "Next Step Action Int": Number(order.next_step_action_int ?? 0),
      "Expedite Tag": Number(order.expedite_tag ?? 0),
      "Atualizado Em": now
    });
  }

  const taskCol = header.indexOf("Tarefa PS") + 1;
  const shipmentCol = header.indexOf("BR") + 1;
  if (!taskCol || !shipmentCol) throw new Error("Parcel Sweeper: cabeçalho inválido.");

  const existingRows = Math.max(0, sh.getLastRow() - 1);
  const index = new Map();

  if (existingRows > 0) {
    const taskValues = sh.getRange(2, taskCol, existingRows, 1).getValues();
    const shipmentValues = sh.getRange(2, shipmentCol, existingRows, 1).getValues();

    for (let i = 0; i < existingRows; i++) {
      const currentTask = String(taskValues[i][0] || "").trim();
      const currentShipment = String(shipmentValues[i][0] || "").trim();
      if (!currentTask || !currentShipment) continue;
      index.set(currentTask + "|" + currentShipment, i + 2);
    }
  }

  const updatesByRow = new Map();
  const inserts = [];

  for (let i = 0; i < incomingObjects.length; i++) {
    const obj = incomingObjects[i];
    const row = objectToRowArray_(header, obj);
    const key = String(obj["Tarefa PS"] || "") + "|" + String(obj.BR || "");
    const rowNumber = index.get(key);

    coerceDatesInMatrix_(header, [row]);
    forceTextInMatrix_(header, [row]);

    if (rowNumber) updatesByRow.set(rowNumber, row);
    else inserts.push(row);
  }

  applyUpdatesChunked_(sh, header.length, updatesByRow);
  appendChunked_(sh, header.length, inserts, CONFIG.WRITE_CHUNK);

  if (complete && sh.getLastRow() > 1) {
    const rows = sh.getLastRow() - 1;
    const taskValues = sh.getRange(2, taskCol, rows, 1).getValues();
    const statusCol = header.indexOf("Status Tarefa") + 1;
    const completeCol = header.indexOf("Tarefa Completa") + 1;
    const statusValues = sh.getRange(2, statusCol, rows, 1).getValues();
    const completeValues = sh.getRange(2, completeCol, rows, 1).getValues();
    let changed = false;

    for (let i = 0; i < rows; i++) {
      if (String(taskValues[i][0] || "").trim() !== taskId) continue;
      statusValues[i][0] = Number(task.status || 5);
      completeValues[i][0] = true;
      changed = true;
    }

    if (changed) {
      sh.getRange(2, statusCol, rows, 1).setValues(statusValues);
      sh.getRange(2, completeCol, rows, 1).setValues(completeValues);
    }
  }

  sh.setFrozenRows(1);
  applyTextFormats_(sh, header);
  applyDateFormats_(sh, getDateColsFromHeader_(header).dateTimeCols);
  const dataCol = header.indexOf("Data") + 1;
  if (dataCol > 0 && sh.getLastRow() > 1) {
    sh.getRange(2, dataCol, sh.getLastRow() - 1, 1).setNumberFormat("dd/MM/yyyy");
  }

  updateParcelSweeperControl_(ss, task, complete, incomingObjects.length, expectedTotal, now);

  return {
    ok: true,
    sheetName: PARCEL_SWEEPER_SHEET,
    taskId,
    status: Number(task.status || 0),
    complete,
    requestedComplete,
    orderCount: incomingObjects.length,
    taskTotal: expectedTotal,
    inserted: inserts.length,
    updated: updatesByRow.size
  };
}

function updateParcelSweeperControl_(ss, task, complete, orderCount, taskTotal, updatedAt) {
  const sh = getOrCreateSheet_(ss, PARCEL_SWEEPER_CONTROL_SHEET);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, PARCEL_SWEEPER_CONTROL_HEADERS.length)
      .setValues([PARCEL_SWEEPER_CONTROL_HEADERS]);
    sh.setFrozenRows(1);
  }

  const taskId = String(task.task_id || "").trim();
  const rows = Math.max(0, sh.getLastRow() - 1);
  let targetRow = 0;

  if (rows > 0) {
    const taskValues = sh.getRange(2, 1, rows, 1).getValues();
    for (let i = 0; i < taskValues.length; i++) {
      if (String(taskValues[i][0] || "").trim() === taskId) {
        targetRow = i + 2;
        break;
      }
    }
  }

  const row = [[
    taskId,
    task.date || "",
    Number(task.status || 0),
    !!complete,
    Number(orderCount || 0),
    Number(taskTotal || 0),
    updatedAt || new Date()
  ]];

  if (targetRow) sh.getRange(targetRow, 1, 1, row[0].length).setValues(row);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, row[0].length).setValues(row);

  sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 1).setNumberFormat("@");
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 7, sh.getLastRow() - 1, 1).setNumberFormat("dd/MM/yyyy HH:mm:ss");
  }

  try {
    if (!sh.isSheetHidden()) sh.hideSheet();
  } catch (_) {}
}


function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function rowArrayToObject_(header, row) {
  const obj = {};
  for (let i = 0; i < header.length; i++) {
    obj[String(header[i])] = row[i];
  }
  return obj;
}

function objectToRowArray_(header, obj) {
  const row = new Array(header.length).fill("");
  for (let i = 0; i < header.length; i++) {
    const k = String(header[i]);
    row[i] = obj[k] === undefined || obj[k] === null ? "" : obj[k];
  }
  return row;
}

function mergeHeaders_(existing, incoming) {
  const set = new Set(existing.map(String));
  const out = existing.slice();

  for (let i = 0; i < incoming.length; i++) {
    const h = String(incoming[i]);
    if (!set.has(h)) {
      set.add(h);
      out.push(h);
    }
  }

  return out;
}

function headerIndexMap_(header) {
  const m = new Map();
  for (let i = 0; i < header.length; i++) {
    m.set(String(header[i]), i + 1);
  }
  return m;
}

function uniqueSorted_(arr) {
  const s = Array.from(new Set(arr));
  s.sort((a, b) => a - b);
  return s;
}

function readColumns_(sh, startRow, numRows, colIdxs1based) {
  const out = {};
  for (let i = 0; i < colIdxs1based.length; i++) {
    const c = colIdxs1based[i];
    out[c] = sh.getRange(startRow, c, numRows, 1).getValues().map(r => r[0]);
  }
  return out;
}

function buildKeyFromObj_(sheetName, obj) {
  sheetName = normalizeSheetName_(sheetName);
  const fields = CONFIG.KEY_FIELDS[sheetName] || [];
  return fields.map(f => normalizeKeyValue_(f, obj[f])).join("|").trim();
}

function buildKeyFromCols_(mergedHeader, columnsData, keyColIdxs, i0) {
  const parts = [];
  for (let i = 0; i < keyColIdxs.length; i++) {
    const c = keyColIdxs[i];
    parts.push(normalizeKeyValue_(mergedHeader[c - 1], columnsData[c] ? columnsData[c][i0] : ""));
  }
  return parts.join("|").replace(/\|+$/g, "").trim();
}

function pickMaxTimeFromObj_(obj, fields) {
  let best = 0;
  for (let i = 0; i < fields.length; i++) {
    const t = parseDdMmYyyyHms_(obj[fields[i]]);
    if (t > best) best = t;
  }
  return best;
}

function pickMaxTimeFromCols_(columnsData, recColIdxs, i0) {
  let best = 0;
  for (let i = 0; i < recColIdxs.length; i++) {
    const c = recColIdxs[i];
    const t = parseDdMmYyyyHms_(columnsData[c] ? columnsData[c][i0] : "");
    if (t > best) best = t;
  }
  return best;
}

function normalizeKeyValue_(fieldName, v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function parseDdMmYyyyHms_(v) {
  const d = parseToDate_(v);
  return d ? d.getTime() : 0;
}

function parseToDate_(v) {
  if (v === null || v === undefined) return null;

  if (Object.prototype.toString.call(v) === "[object Date]") {
    return isNaN(v.getTime()) ? null : v;
  }

  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;

    if (v >= 1000000000000 && v < 1000000000000000) {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }

    if (v >= 1000000000 && v < 1000000000000) {
      const d = new Date(v * 1000);
      return isNaN(d.getTime()) ? null : d;
    }

    return null;
  }

  const s = String(v).trim();
  if (!s || s === "0" || s === "/") return null;

  if (/^\d+$/.test(s)) {
    const n = Number(s);

    if (n >= 1000000000000 && n < 1000000000000000) {
      const d = new Date(n);
      return isNaN(d.getTime()) ? null : d;
    }

    if (n >= 1000000000 && n < 1000000000000) {
      const d = new Date(n * 1000);
      return isNaN(d.getTime()) ? null : d;
    }
  }

  const d1 = parseBrSlashDate_(s);
  if (d1) return d1;

  const d2 = parseBrDashDate_(s);
  if (d2) return d2;

  const d3 = parseIsoDateTime_(s);
  if (d3) return d3;

  const d4 = parseYyyyMmDd_(s);
  if (d4) return d4;

  return null;
}

function parseBrSlashDate_(s) {
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;

  const d = new Date(
    Number(m[3]),
    Number(m[2]) - 1,
    Number(m[1]),
    Number(m[4] || 0),
    Number(m[5] || 0),
    Number(m[6] || 0)
  );

  return isNaN(d.getTime()) ? null : d;
}

function parseBrDashDate_(s) {
  const m = String(s).match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;

  const d = new Date(
    Number(m[3]),
    Number(m[2]) - 1,
    Number(m[1]),
    Number(m[4] || 0),
    Number(m[5] || 0),
    Number(m[6] || 0)
  );

  return isNaN(d.getTime()) ? null : d;
}

function parseIsoDateTime_(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?(?:\.\d+)?(?:Z)?$/);
  if (!m) return null;

  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] || 0),
    Number(m[5] || 0),
    Number(m[6] || 0)
  );

  return isNaN(d.getTime()) ? null : d;
}

function parseYyyyMmDd_(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;

  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

function coerceDatesInMatrix_(header, matrix) {
  const cols = getDateColsFromHeader_(header);

  for (let r = 0; r < matrix.length; r++) {
    for (let i = 0; i < cols.dateTimeCols.length; i++) {
      const c = cols.dateTimeCols[i];
      const v = matrix[r][c];

      if (
        v === null ||
        v === undefined ||
        v === "" ||
        v === 0 ||
        String(v).trim() === "0" ||
        String(v).trim() === "/"
      ) {
        matrix[r][c] = "";
        continue;
      }

      if (v instanceof Date) {
        matrix[r][c] = isNaN(v.getTime()) ? "" : v;
        continue;
      }

      const d = parseToDate_(v);
      matrix[r][c] = d || "";
    }
  }

  return cols;
}

function getDateColsFromHeader_(header) {
  const dateTimeCols = [];
  for (let c = 0; c < header.length; c++) {
    const name = String(header[c] || "");
    if (DATETIME_FIELDS.has(name)) dateTimeCols.push(c);
  }
  return { dateTimeCols };
}

function applyDateFormats_(sh, dateTimeCols) {
  const rows = Math.max(0, sh.getLastRow() - 1);
  if (rows <= 0) return;

  for (let i = 0; i < dateTimeCols.length; i++) {
    sh.getRange(2, dateTimeCols[i] + 1, rows, 1).setNumberFormat("dd/MM/yyyy HH:mm:ss");
  }
}

function applyTextFormats_(sh, header) {
  const rows = Math.max(0, sh.getLastRow() - 1);
  if (rows <= 0) return;

  for (let c = 0; c < header.length; c++) {
    if (FORCE_TEXT_FIELDS.has(String(header[c] || ""))) {
      sh.getRange(2, c + 1, rows, 1).setNumberFormat("@");
    }
  }
}

function applyDurationFormat_(sh, header) {
  const col = header.indexOf("duration");
  if (col === -1) return;

  const rows = Math.max(0, sh.getLastRow() - 1);
  if (rows > 0) {
    sh.getRange(2, col + 1, rows, 1).setNumberFormat("0");
  }
}

function applyPercentFormats_(sh, header) {
  const col = header.indexOf("validated_target_qty_ratio");
  if (col === -1) return;

  const rows = Math.max(0, sh.getLastRow() - 1);
  if (rows > 0) {
    sh.getRange(2, col + 1, rows, 1).setNumberFormat("0.00%");
  }
}

function forceTextInMatrix_(header, matrix) {
  const textCols = [];
  for (let c = 0; c < header.length; c++) {
    if (FORCE_TEXT_FIELDS.has(String(header[c] || ""))) textCols.push(c);
  }

  if (!textCols.length) return;

  for (let r = 0; r < matrix.length; r++) {
    for (let i = 0; i < textCols.length; i++) {
      const c = textCols[i];
      const v = matrix[r][c];
      matrix[r][c] = v === null || v === undefined ? "" : String(v);
    }
  }
}

function writeChunked_(sh, startRow, colCount, values, chunkSize) {
  if (!values.length) return;

  let r = 0;
  while (r < values.length) {
    const part = values.slice(r, r + chunkSize);
    sh.getRange(startRow + r, 1, part.length, colCount).setValues(part);
    r += part.length;
  }
}

function appendChunked_(sh, colCount, rows, chunkSize) {
  if (!rows.length) return;

  let idx = 0;
  while (idx < rows.length) {
    const part = rows.slice(idx, idx + chunkSize);
    const startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, part.length, colCount).setValues(part);
    idx += part.length;
  }
}

function applyUpdatesChunked_(sh, colCount, updatesByRow) {
  const rows = Array.from(updatesByRow.keys()).sort((a, b) => a - b);
  if (!rows.length) return;

  let start = rows[0];
  let prev = rows[0];

  const flush = (a, b) => {
    const vals = [];
    for (let rr = a; rr <= b; rr++) {
      vals.push(updatesByRow.get(rr));
    }
    sh.getRange(a, 1, b - a + 1, colCount).setValues(vals);
  };

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r === prev + 1) {
      prev = r;
    } else {
      flush(start, prev);
      start = r;
      prev = r;
    }
  }

  flush(start, prev);
}

function minutesDiff_(a, b) {
  const ta = parseDdMmYyyyHms_(a);
  const tb = parseDdMmYyyyHms_(b);

  if (!ta || !tb) return "";

  const min = Math.round((tb - ta) / 60000);
  return min >= 0 ? min : "";
}

function cleanupConferenceDateArtifacts_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const targetSheets = ["Conferencia", "Conferencia_AT_List", "Order_Refresh", "Devoluções Pendentes"];

  for (let s = 0; s < targetSheets.length; s++) {
    const sh = ss.getSheetByName(targetSheets[s]);
    if (!sh) continue;

    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) continue;

    const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    const dateTimeCols = [];

    for (let c = 0; c < header.length; c++) {
      if (DATETIME_FIELDS.has(header[c])) {
        dateTimeCols.push(c);
      }
    }

    if (!dateTimeCols.length) continue;

    const range = sh.getRange(2, 1, lastRow - 1, lastCol);
    const values = range.getValues();

    for (let r = 0; r < values.length; r++) {
      for (let i = 0; i < dateTimeCols.length; i++) {
        const c = dateTimeCols[i];
        const v = values[r][c];

        if (
          v === null ||
          v === undefined ||
          v === "" ||
          v === 0 ||
          String(v).trim() === "0" ||
          String(v).trim() === "/"
        ) {
          values[r][c] = "";
          continue;
        }

        if (v instanceof Date) {
          const year = v.getFullYear();
          if (isNaN(v.getTime()) || year <= 1900) {
            values[r][c] = "";
          }
          continue;
        }

        const d = parseToDate_(v);
        values[r][c] = d || "";
      }
    }

    range.setValues(values);

    for (let i = 0; i < dateTimeCols.length; i++) {
      sh.getRange(2, dateTimeCols[i] + 1, Math.max(0, sh.getLastRow() - 1), 1)
        .setNumberFormat("dd/MM/yyyy HH:mm:ss");
    }

    applyTextFormats_(sh, header);
    applyPercentFormats_(sh, header);
    applyDurationFormat_(sh, header);
  }
}

function importBatch_(items) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const prepared = items.map(normalizeIncomingPayload_);

  const atPayload = prepared.find(p => p.sheetName === "Conferencia_AT_List");
  const metricsByVT = atPayload
    ? buildConferenciaMetricsFromAT_(atPayload.normalized.objects)
    : new Map();

  const results = [];

  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i];

    if (item.sheetName === "Order_Refresh") {
      const result = replaceOrderRefreshSheet_(
        ss,
        item.header,
        item.normalized.objects,
        item.meta
      );

      results.push({
        ok: true,
        sheetName: item.sheetName,
        ...result
      });

      continue;
    }

    if (item.sheetName === "Devoluções Pendentes") {
      const result = replacePendingReturnsSheet_(
        ss,
        item.header,
        item.normalized.objects,
        item.meta
      );

      results.push({
        ok: true,
        sheetName: item.sheetName,
        ...result
      });

      continue;
    }

    if (item.sheetName === "Conferencia") {
      enrichConferenciaWithATMetrics_(item.header, item.normalized, metricsByVT);
      addDurationToConferencia_(item.header, item.normalized);
    }

    const result = upsertSheetFast_(ss, item.sheetName, item.header, item.normalized.objects);

    results.push({
      ok: true,
      sheetName: item.sheetName,
      ...result
    });
  }

  return results;
}

function normalizeIncomingPayload_(payload) {
  const rawSheetName = String(payload?.sheetName || payload?.importType || "").trim();
  const sheetName = normalizeSheetName_(rawSheetName);

  if (!sheetName) throw new Error("sheetName vazio.");
  if (!ALLOWED_SHEETS.has(rawSheetName) && !ALLOWED_SHEETS.has(sheetName)) {
    throw new Error("Aba não permitida: " + rawSheetName);
  }

  if ((sheetName === "Order_Refresh" || sheetName === "Devoluções Pendentes") && payload && payload.csvText) {
    const parsed = parseCsvText_(payload.csvText);

    return {
      sheetName,
      header: parsed.header,
      normalized: normalizeRows_(parsed.header, parsed.rows),
      meta: buildOrderRefreshMeta_(payload)
    };
  }

  const header = Array.isArray(payload?.header) ? payload.header.map(String) : [];
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];

  if (!header.length) throw new Error("Header vazio em " + sheetName);

  return {
    sheetName,
    header,
    normalized: normalizeRows_(header, rows),
    meta: buildOrderRefreshMeta_(payload)
  };
}

function normalizeSheetName_(name) {
  const s = String(name || "").trim();

  if (s === "OrderRefresh") return "Order_Refresh";
  if (s === "Order Refresh") return "Order_Refresh";
  if (s === "Order_Refresh") return "Order_Refresh";
  if (s === "PendingReturns") return "Devoluções Pendentes";
  if (s === "Devolucoes_Pendentes") return "Devoluções Pendentes";
  if (s === "Devolucoes Pendentes") return "Devoluções Pendentes";
  if (s === "Devoluções Pendentes") return "Devoluções Pendentes";

  return s;
}

function parseCsvText_(csvText) {
  let text = String(csvText || "");
  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!text.trim()) {
    throw new Error("CSV vazio em Order_Refresh.");
  }

  const firstLine = text.split("\n")[0] || "";
  const delimiter = detectCsvDelimiter_(firstLine);
  const matrix = Utilities.parseCsv(text, delimiter)
    .filter(row => row.some(cell => String(cell || "").trim() !== ""));

  if (!matrix.length) {
    throw new Error("CSV sem linhas em Order_Refresh.");
  }

  const header = matrix[0].map((h, i) => {
    const name = String(h || "").replace(/^\uFEFF/, "").trim();
    return name || "col_" + (i + 1);
  });

  const rows = matrix.slice(1).map(row => {
    const out = [];
    for (let i = 0; i < header.length; i++) {
      out.push(row[i] === undefined || row[i] === null ? "" : row[i]);
    }
    return out;
  });

  return { header, rows };
}

function detectCsvDelimiter_(line) {
  const comma = (String(line).match(/,/g) || []).length;
  const semicolon = (String(line).match(/;/g) || []).length;
  const tab = (String(line).match(/\t/g) || []).length;

  if (semicolon > comma && semicolon >= tab) return ";";
  if (tab > comma && tab > semicolon) return "\t";
  return ",";
}

function buildOrderRefreshMeta_(payload) {
  const task = payload && payload.task ? payload.task : {};
  return {
    imported_at: new Date(),
    export_task_id: firstNonEmpty_(task.task_id, payload?.task_id),
    export_file_name: firstNonEmpty_(task.file_name, payload?.file_name),
    download_url: firstNonEmpty_(task.download_url, payload?.download_url)
  };
}

function firstNonEmpty_() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v !== null && v !== undefined && String(v).trim() !== "") {
      return v;
    }
  }
  return "";
}

function replaceOrderRefreshSheet_(ss, incomingHeader, incomingObjects, meta) {
  const sheetName = "Order_Refresh";
  const sh = getOrCreateSheet_(ss, sheetName);

  const header = incomingHeader.slice();
  ensureHeaderFields_(header, ORDER_REFRESH_META_FIELDS);

  const cleaned = cleanOrderRefreshObjects_(header, incomingObjects, meta);
  const data = cleaned.map(o => objectToRowArray_(header, o));

  const cols = coerceDatesInMatrix_(header, data);
  forceTextInMatrix_(header, data);

  sh.clearContents();

  writeChunked_(sh, 1, header.length, [header].concat(data), CONFIG.WRITE_CHUNK);

  applyTextFormats_(sh, header);
  applyDateFormats_(sh, cols.dateTimeCols);

  return {
    mode: "replace_snapshot",
    headerColumns: header.length,
    inserted: data.length,
    updated: 0,
    skipped: incomingObjects.length - data.length,
    removedStaleOrders: true
  };
}

function replacePendingReturnsSheet_(ss, incomingHeader, incomingObjects, meta) {
  const sheetName = "Devoluções Pendentes";
  const sh = getOrCreateSheet_(ss, sheetName);
  const header = incomingHeader.slice();

  ensureHeaderFields_(header, PENDING_RETURNS_META_FIELDS);

  const objects = incomingObjects.map(original => {
    const obj = {};

    for (let i = 0; i < header.length; i++) {
      const key = String(header[i]);
      obj[key] = original && original[key] !== undefined && original[key] !== null
        ? original[key]
        : "";
    }

    obj.imported_at = meta && meta.imported_at ? meta.imported_at : new Date();
    obj.export_task_id = meta && meta.export_task_id ? String(meta.export_task_id) : "";
    obj.export_file_name = meta && meta.export_file_name ? String(meta.export_file_name) : "";
    obj.download_url = meta && meta.download_url ? String(meta.download_url) : "";

    return obj;
  });

  const data = objects.map(obj => objectToRowArray_(header, obj));
  const cols = coerceDatesInMatrix_(header, data);

  forceTextInMatrix_(header, data);
  sh.clearContents();
  writeChunked_(sh, 1, header.length, [header].concat(data), CONFIG.WRITE_CHUNK);
  sh.setFrozenRows(1);
  applyTextFormats_(sh, header);
  applyDateFormats_(sh, cols.dateTimeCols);

  return {
    mode: "replace_snapshot",
    headerColumns: header.length,
    inserted: data.length,
    updated: 0,
    skipped: 0,
    removedStaleOrders: true
  };
}

function cleanOrderRefreshObjects_(header, objects, meta) {
  const recFields = CONFIG.RECENCY_FIELDS.Order_Refresh || [];
  const byOrder = new Map();

  for (let i = 0; i < objects.length; i++) {
    const original = objects[i] || {};
    const orderId = normalizeOrderId_(original["Order ID"]);

    if (!orderId) continue;

    const obj = {};
    for (let h = 0; h < header.length; h++) {
      const key = String(header[h]);
      obj[key] = original[key] === undefined || original[key] === null ? "" : original[key];
    }

    obj["Order ID"] = orderId;

    if (obj["SLS Tracking Number"]) {
      obj["SLS Tracking Number"] = normalizeOrderId_(obj["SLS Tracking Number"]);
    }

    obj.imported_at = meta && meta.imported_at ? meta.imported_at : new Date();
    obj.export_task_id = meta && meta.export_task_id ? String(meta.export_task_id) : "";
    obj.export_file_name = meta && meta.export_file_name ? String(meta.export_file_name) : "";
    obj.download_url = meta && meta.download_url ? String(meta.download_url) : "";

    const recency = pickMaxTimeFromObj_(obj, recFields);
    const current = byOrder.get(orderId);

    if (!current || recency >= current.recency) {
      byOrder.set(orderId, {
        recency,
        obj
      });
    }
  }

  return Array.from(byOrder.values()).map(item => item.obj);
}

function normalizeOrderId_(v) {
  if (v === null || v === undefined) return "";

  let s = String(v)
    .replace(/^\uFEFF/, "")
    .replace(/^'+/, "")
    .trim();

  s = s.replace(/\s+/g, "");

  if (!s) return "";

  return s.toUpperCase();
}

function cleanupOrderRefreshPedidos_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName("Order_Refresh");

  if (!sh) return;

  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();

  if (lastRow < 2 || lastCol < 1) return;

  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const objects = values.map(row => rowArrayToObject_(header, row));

  replaceOrderRefreshSheet_(
    ss,
    header,
    objects,
    {
      imported_at: new Date(),
      export_task_id: "",
      export_file_name: "",
      download_url: ""
    }
  );
}

function enrichConferenciaWithATMetrics_(header, normalized, metricsByVT) {
  ensureHeaderFields_(header, CONFERENCIA_DERIVED_FIELDS);

  for (let i = 0; i < normalized.objects.length; i++) {
    const obj = normalized.objects[i];
    const vt = String(obj.validation_task_id || "").trim();
    const metrics = metricsByVT.get(vt) || emptyConferenciaMetrics_();

    Object.assign(obj, metrics);

    if (normalized.values[i]) {
      const rebuilt = objectToRowArray_(header, obj);
      normalized.values[i].length = 0;
      Array.prototype.push.apply(normalized.values[i], rebuilt);
    }
  }
}

function buildConferenciaMetricsFromAT_(rows) {
  const byVT = new Map();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const vt = String(row.vt_task_id || "").trim();
    if (!vt) continue;

    if (!byVT.has(vt)) {
      byVT.set(vt, emptyConferenciaMetrics_());
    }

    const acc = byVT.get(vt);

    const status = Number(row.validation_status || 0);
    if (status === 1) acc.not_validate_qty += 1;
    else if (status === 2) acc.in_progress_qty += 1;
    else if (status === 4) acc.validated_qty += 1;

    acc.deviated_qty += toNumberSafe_(row.deviated_qty);
    acc.missort_qty += toNumberSafe_(row.missort_qty);
    acc.duplicated_qty += toNumberSafe_(row.duplicate_qty);
    acc.added_qty += toNumberSafe_(row.added_qty);
    acc.missing_qty += toNumberSafe_(row.missing_qty);
    acc.unknown_qty += toNumberSafe_(row.unknown_qty);
    acc.exception_qty += toNumberSafe_(row.exception_qty);

    acc._final_qty_sum += toNumberSafe_(row.final_qty);
  }

  byVT.forEach(acc => {
    acc.ok_qty = Math.max(
      0,
      acc._final_qty_sum
        - acc.missort_qty
        - acc.duplicated_qty
        - acc.added_qty
        - acc.missing_qty
        - acc.unknown_qty
        - acc.exception_qty
    );
    delete acc._final_qty_sum;
  });

  return byVT;
}

function emptyConferenciaMetrics_() {
  return {
    not_validate_qty: 0,
    in_progress_qty: 0,
    validated_qty: 0,
    deviated_qty: 0,
    ok_qty: 0,
    missort_qty: 0,
    duplicated_qty: 0,
    added_qty: 0,
    missing_qty: 0,
    unknown_qty: 0,
    exception_qty: 0,
    _final_qty_sum: 0
  };
}

function ensureHeaderFields_(header, fields) {
  const set = new Set(header.map(String));
  for (let i = 0; i < fields.length; i++) {
    const f = String(fields[i]);
    if (!set.has(f)) {
      set.add(f);
      header.push(f);
    }
  }
}

function toNumberSafe_(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}