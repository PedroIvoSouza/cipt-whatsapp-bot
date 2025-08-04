// sheetsChamados.js (Versão Final Simplificada)
const { google } = require("googleapis");
const dotenv = require('dotenv');
dotenv.config();

// Função de autenticação que depende exclusivamente da variável de ambiente
function getAuth() {
  const scopes = "https://www.googleapis.com/auth/spreadsheets";

  if (!process.env.GOOGLE_CREDENTIALS_JSON) {
    console.error("ERRO CRÍTICO: A variável de ambiente GOOGLE_CREDENTIALS_JSON não está definida!");
    throw new Error("Credenciais do Google não encontradas no ambiente.");
  }

  const credentialsJson = Buffer.from(process.env.GOOGLE_CREDENTIALS_JSON, 'base64').toString('utf8');
  const credentials = JSON.parse(credentialsJson);
  return new google.auth.GoogleAuth({ credentials, scopes });
}

async function registrarChamado(dados) {
  try {
    const auth = getAuth();
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
        const auth = getAuth();
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
        const auth = getAuth();
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