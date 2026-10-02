const SHEET_NAME = 'base';
const ITEM_AUTO = 'o nome do item é preenchido automaticamente...';
const STATUS_AUTO = 'o status é preenchido automaticamente...';
const STATUS_REFRESH = ['Ticket Submitted', 'Tratativa pendente'];
const COL_SPX = 1;
const COL_ITEM = 9;
const COL_STATUS = 10;

function doGet(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    const result = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const spx = row[COL_SPX - 1];
      const item = row[COL_ITEM - 1];
      const status = row[COL_STATUS - 1];

      if (
        String(item).trim() === ITEM_AUTO ||
        String(status).trim() === STATUS_AUTO ||
        STATUS_REFRESH.includes(String(status).trim())
      ) {
        result.push({
          spx_tn: spx,
          item: item,
          status: status,
          row: i + 1
        });
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, total: result.length, data: result }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const spx = String(body.spx_tn || '').trim();
    const item = body.item;
    const status = body.status;

    if (!spx) throw new Error('spx_tn é obrigatório');

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][COL_SPX - 1]).trim() === spx) {
        if (item !== undefined && item !== null && String(item).trim() !== '') {
          sheet.getRange(i + 1, COL_ITEM).setValue(item);
        }
        if (status !== undefined && status !== null && String(status).trim() !== '') {
          sheet.getRange(i + 1, COL_STATUS).setValue(status);
        }
        return ContentService
          .createTextOutput(JSON.stringify({ success: true, message: 'Atualizado com sucesso', row: i + 1 }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    throw new Error('SPX TN não encontrado');
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
