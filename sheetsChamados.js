// sheetsChamados.js

const { google } = require("googleapis");
const dotenv = require('dotenv');
dotenv.config();

// (As funções registrarChamado e atualizarStatusChamado continuam aqui, exatamente como antes)
async function registrarChamado(dados) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: "credentials.json",
      scopes: "https://www.googleapis.com/auth/spreadsheets",
    });
    const client = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: client });
    const spreadsheetId = process.env.SHEET_ID;
    await googleSheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Chamados!A:G",
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[ dados.protocolo, dados.nome, dados.telefone, dados.descricao, dados.categoria, dados.status, dados.usuarioJid ]],
      },
    });
  } catch (error) {
    console.error("❌ Erro ao registrar chamado na planilha:", error);
  }
}

async function atualizarStatusChamado(protocolo, novoStatus, responsavel) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: "credentials.json",
      scopes: "https://www.googleapis.com/auth/spreadsheets",
    });
    const client = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: client });
    const spreadsheetId = process.env.SHEET_ID;
    const response = await googleSheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Chamados!A:G",
    });
    const rows = response.data.values;
    let rowIndex = -1;
    let usuarioJid = null;
    if (rows) {
      rowIndex = rows.findIndex(row => row[0] === protocolo);
      if (rowIndex !== -1) {
        usuarioJid = rows[rowIndex][6];
      }
    }
    if (rowIndex === -1) return null;
    await googleSheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Chamados!F${rowIndex + 1}`,
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[novoStatus]],
      },
    });
    return usuarioJid;
  } catch (error) {
    console.error("❌ Erro ao atualizar status na planilha:", error);
    return null;
  }
}


// ✅ NOVA FUNÇÃO para verificar chamados abertos
async function verificarChamadosAbertos() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: "credentials.json",
      scopes: "https://www.googleapis.com/auth/spreadsheets",
    });
    const client = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: client });
    const spreadsheetId = process.env.SHEET_ID;

    const response = await googleSheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Chamados!A:F",
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) {
      return [];
    }

    const header = rows[0];
    const statusIndex = header.indexOf("Status");
    const categoriaIndex = header.indexOf("Categoria");

    if (statusIndex === -1 || categoriaIndex === -1) {
        console.error("Cabeçalhos 'Status' ou 'Categoria' não encontrados na planilha.");
        return [];
    }

    const chamadosAbertos = rows.slice(1).filter(row => {
      const status = row[statusIndex];
      return status && status.toLowerCase() !== 'concluído' && status.toLowerCase() !== 'rejeitado';
    }).map(row => ({
        categoria: row[categoriaIndex]
    }));

    return chamadosAbertos;
  } catch (error) {
    console.error("❌ Erro ao verificar chamados abertos:", error);
    return [];
  }
}

module.exports = {
  registrarChamado,
  atualizarStatusChamado,
  verificarChamadosAbertos, // <-- Exporta a nova função
};