const { google } = require("googleapis");

async function teste() {
  try {
    const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: SCOPES,
    });

    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
    const spreadsheetId = process.env.SHEET_ID;

    const dataHora = new Date().toLocaleString("pt-BR");
    const valores = [
      ["TESTE-001", dataHora, "Bot CIPT", "000000000", "Teste de integração", "Infraestrutura", "Aberto", ""]
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "A:H",
      valueInputOption: "RAW",
      requestBody: { values: valores },
    });

    console.log("✅ Linha de teste adicionada na planilha!");
  } catch (err) {
    console.error("❌ Erro ao escrever na planilha:", err.message);
  }
}

teste();