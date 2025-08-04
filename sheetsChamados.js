// sheetsChamados.js
const { google } = require("googleapis");
const dotenv = require('dotenv');
dotenv.config();

// ✅ FUNÇÃO ATUALIZADA PARA LER AS CREDENCIAIS CORRETAMENTE
function getAuthClient() {
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
        // Ambiente de produção (Render) - lê da variável de ambiente
        const credentialsBase64 = process.env.GOOGLE_CREDENTIALS_JSON;
        // Decodifica o conteúdo de Base64 para o formato JSON original
        const credentialsJson = Buffer.from(credentialsBase64, 'base64').toString('utf8');
        const credentials = JSON.parse(credentialsJson);
        return google.auth.fromJSON(credentials);
    } else {
        // Ambiente local - lê do arquivo
        return new google.auth.GoogleAuth({
            keyFile: "credentials.json",
            scopes: "https://www.googleapis.com/auth/spreadsheets",
        });
    }
}

async function registrarChamado(dados) {
  try {
    const auth = getAuthClient(); // Usa a nova função
    const client = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: client });
    const spreadsheetId = process.env.SHEET_ID;
    await googleSheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Chamados!A:G",
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[
          dados.protocolo, dados.nome, dados.telefone, dados.descricao,
          dados.categoria, dados.status, dados.usuarioJid
        ]],
      },
    });
    console.log(`✅ Chamado ${dados.protocolo} registrado na planilha.`);
    return true;
  } catch (error) {
    console.error("❌ Erro ao registrar chamado na planilha:", error.message);
    return false;
  }
}

async function atualizarStatusChamado(protocolo, novoStatus, responsavel) {
    try {
        const auth = getAuthClient(); // Usa a nova função
        const client = await auth.getClient();
        const googleSheets = google.sheets({ version: "v4", auth: client });
        const spreadsheetId = process.env.SHEET_ID;
        const response = await googleSheets.spreadsheets.values.get({ spreadsheetId, range: "Chamados!A:G" });
        const rows = response.data.values;
        let rowIndex = -1;
        let usuarioJid = null;
        if (rows) {
          rowIndex = rows.findIndex(row => row[0] === protocolo);
          if (rowIndex !== -1) usuarioJid = rows[rowIndex][6];
        }
        if (rowIndex === -1) return null;
        await googleSheets.spreadsheets.values.update({
          spreadsheetId,
          range: `Chamados!F${rowIndex + 1}`,
          valueInputOption: "USER_ENTERED",
          resource: { values: [[novoStatus]] },
        });
        return usuarioJid;
      } catch (error) {
        console.error("❌ Erro ao atualizar status na planilha:", error.message);
        return null;
      }
}

async function verificarChamadosAbertos() {
    try {
        const auth = getAuthClient(); // Usa a nova função
        const client = await auth.getClient();
        const googleSheets = google.sheets({ version: "v4", auth: client });
        const spreadsheetId = process.env.SHEET_ID;
        const response = await googleSheets.spreadsheets.values.get({ spreadsheetId, range: "Chamados!A:F" });
        const rows = response.data.values;
        if (!rows || rows.length < 2) return [];
        const header = rows[0];
        const statusIndex = header.indexOf("Status");
        const categoriaIndex = header.indexOf("Categoria");
        if (statusIndex === -1 || categoriaIndex === -1) return [];
        const chamadosAbertos = rows.slice(1).filter(row => {
          const status = row[statusIndex];
          return status && status.toLowerCase() !== 'concluído' && status.toLowerCase() !== 'rejeitado';
        }).map(row => ({ categoria: row[categoriaIndex] }));
        return chamadosAbertos;
      } catch (error) {
        console.error("❌ Erro ao verificar chamados abertos:", error.message);
        return [];
      }
}

module.exports = {
  registrarChamado,
  atualizarStatusChamado,
  verificarChamadosAbertos,
};