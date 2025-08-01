const { google } = require("googleapis");

async function teste() {
  try {
    const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

    // Decodifica as credenciais em Base64
    const credentials = JSON.parse(
      Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, "base64").toString("utf8")
    );

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: SCOPES,
    });

    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
    const spreadsheetId = process.env.SHEET_ID;

    console.log("📌 SHEET_ID carregado:", spreadsheetId);

    const dataHora = new Date().toLocaleString("pt-BR");
    const valores = [
      ["TESTE-001", dataHora, "Bot CIPT", "000000000", "Teste com chave Base64", "Infraestrutura", "Aberto", ""]
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