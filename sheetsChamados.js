// sheetsChamados.js
const { google } = require("googleapis");

async function getSheetsClient() {
  const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
  const credentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, "base64").toString("utf8")
  );
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

async function registrarChamado({ protocolo, nome, telefone, descricao, categoria, status, usuarioJid }) {
  // 🚫 Bloqueia registros de teste
  if (protocolo.startsWith("TESTE-") || nome === "Bot CIPT") {
    console.log(`⚠️ Chamado de teste detectado (${protocolo}) — não será registrado.`);
    return;
  }

  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SHEET_ID;
  const dataHora = new Date().toLocaleString("pt-BR");

  const valores = [[protocolo, dataHora, nome, telefone, descricao, categoria, status, "", usuarioJid]];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "A:I",
    valueInputOption: "RAW",
    requestBody: { values: valores },
  });
}


async function atualizarStatusChamado(protocolo, novoStatus, responsavel) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SHEET_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "A:I"
  });

  const linhas = res.data.values;
  const idx = linhas.findIndex(l => l[0] === protocolo);

  if (idx !== -1) {
    linhas[idx][6] = novoStatus;      // Status
    linhas[idx][7] = responsavel || ""; // Responsável

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `A${idx + 1}:I${idx + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [linhas[idx]] }
    });

    return linhas[idx][8]; // retorna usuarioJid
  }

  return null;
}


module.exports = { registrarChamado, atualizarStatusChamado };