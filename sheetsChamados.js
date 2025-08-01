const { google } = require("googleapis");

async function getSheetsClient() {
  const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
  const credentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, "base64").toString("utf8")
  );
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

async function registrarChamado({ protocolo, nome, telefone, descricao, categoria, status }) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SHEET_ID;
  const dataHora = new Date().toLocaleString("pt-BR");
  const valores = [[protocolo, dataHora, nome, telefone, descricao, categoria, status, ""]];
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "A:H",
    valueInputOption: "RAW",
    requestBody: { values: valores },
  });
}

async function atualizarStatusChamado(protocolo, novoStatus) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SHEET_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "A:H"
  });

  const linhas = res.data.values;
  const idx = linhas.findIndex(l => l[0] === protocolo);

  if (idx !== -1) {
    linhas[idx][6] = novoStatus;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `A${idx + 1}:H${idx + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [linhas[idx]] }
    });
  }
}

module.exports = { registrarChamado, atualizarStatusChamado };