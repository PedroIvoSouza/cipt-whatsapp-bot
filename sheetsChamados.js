// sheetsChamados.js (Versão Definitiva e Corrigida)
const { google } = require("googleapis");
const dotenv = require('dotenv');
dotenv.config();

const SHEET_NAME = "Página1";

function getAuth() { 
  const scopes = "https://www.googleapis.com/auth/spreadsheets";

  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    // Ambiente de produção (Render) - lê da variável de ambiente
    const credentialsJson = Buffer.from(process.env.GOOGLE_CREDENTIALS_JSON, 'base64').toString('utf8');
    const credentials = JSON.parse(credentialsJson);
    // Usamos GoogleAuth em ambos os casos para garantir consistência
    return new google.auth.GoogleAuth({ credentials, scopes });
  } else {
    // Mantém a lógica local para testes, se você tiver o arquivo localmente
    console.log("Aviso: Usando 'credentials.json' local. Garanta que a variável de ambiente está configurada na produção.");
    return new google.auth.GoogleAuth({
      keyFile: "credentials.json",
      scopes: scopes,
    });
  }
}

async function registrarChamado(dados) {
  try {
    const auth = getAuth();
    const client = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: client });
    const spreadsheetId = process.env.SHEET_ID;
    
    await googleSheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_NAME}!A:J`,
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[
          dados.protocolo,
          new Date().toLocaleString("pt-BR"), // B: Data/Hora
          dados.nome,
          dados.telefone,
          dados.descricao,
          dados.categoria,
          dados.status,
          "", // H: Responsável (vazio)
          "", // I: Telefone do Responsável (vazio)
          dados.usuarioJid // J: JID do usuário (técnico)
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

async function atualizarStatusChamado(protocolo, novoStatus, responsavel, telefoneResponsavel) {
    try {
        const auth = getAuth();
        const client = await auth.getClient();
        const googleSheets = google.sheets({ version: "v4", auth: client });
        const spreadsheetId = process.env.SHEET_ID;
        const response = await googleSheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_NAME}!A:J` });
        const rows = response.data.values;
        let rowIndex = -1;
        let usuarioJid = null;

        if (rows) {
          rowIndex = rows.findIndex(row => row[0] === protocolo);
          if (rowIndex !== -1) {
            usuarioJid = rows[rowIndex][9]; // Pega o JID do usuário da coluna J
          }
        }

        if (rowIndex === -1) return null;

        await googleSheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          resource: {
            valueInputOption: "USER_ENTERED",
            data: [
              { range: `${SHEET_NAME}!G${rowIndex + 1}`, values: [[novoStatus]] },
              { range: `${SHEET_NAME}!H${rowIndex + 1}`, values: [[responsavel]] },
              { range: `${SHEET_NAME}!I${rowIndex + 1}`, values: [[telefoneResponsavel.split('@')[0]]] }
            ]
          }
        });
        
        console.log(`✅ Status e Responsável do chamado ${protocolo} atualizados.`);
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
        const response = await googleSheets.spreadsheets.values.get({ spreadsheetId, range: "Página1!A:G" });
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