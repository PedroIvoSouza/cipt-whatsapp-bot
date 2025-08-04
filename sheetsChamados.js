// sheetsChamados.js (Versão Final com Telefone do Responsável)
const { google } = require("googleapis");
const dotenv = require('dotenv');
dotenv.config();

const SHEET_NAME = "Página1";

function getAuth() { /* ...código sem alterações... */ }

async function registrarChamado(dados) {
  try {
    const auth = getAuth();
    const client = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: client });
    const spreadsheetId = process.env.SHEET_ID;
    
    await googleSheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_NAME}!A:I`,
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[
          dados.protocolo,
          dados.nome,
          dados.telefone,
          dados.descricao,
          dados.categoria,
          dados.status,
          "", // Status (será preenchido na atualização)
          "", // Responsável (será preenchido na atualização)
          ""  // Telefone do Responsável (será preenchido na atualização)
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
        const response = await googleSheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_NAME}!A:I` });
        const rows = response.data.values;
        let rowIndex = -1;
        let usuarioJid = null;

        if (rows) {
          // Busca o JID do usuário na coluna I, que agora é a 9ª coluna (índice 8)
          // (Considerando que o JID do usuário original foi salvo na coluna I no momento do registro)
          // Para um novo design, o JID do usuário deveria estar na coluna J
          // Vamos assumir que não precisamos mais notificar o usuário original por agora.
          rowIndex = rows.findIndex(row => row[0] === protocolo);
        }

        if (rowIndex === -1) return null;

        // ✅ NOVA LÓGICA: Atualiza Status (G), Responsável (H) e Telefone (I)
        await googleSheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          resource: {
            valueInputOption: "USER_ENTERED",
            data: [
              {
                range: `${SHEET_NAME}!G${rowIndex + 1}`, // Coluna G: Status
                values: [[novoStatus]]
              },
              {
                range: `${SHEET_NAME}!H${rowIndex + 1}`, // Coluna H: Responsável
                values: [[responsavel]]
              },
              {
                range: `${SHEET_NAME}!I${rowIndex + 1}`, // Coluna I: Telefone do Responsável
                values: [[telefoneResponsavel.split('@')[0]]] // Salva só o número
              }
            ]
          }
        });
        
        console.log(`✅ Status, Responsável e Telefone do chamado ${protocolo} atualizados.`);
        
        // Retorna o JID do usuário que abriu o chamado para notificação (se ele estiver na planilha)
        if(rows[rowIndex] && rows[rowIndex][8]) {
            usuarioJid = rows[rowIndex][8];
        }
        return usuarioJid;

      } catch (error) {
        console.error("❌ Erro ao atualizar status na planilha:", error.message);
        return null;
      }
}

async function verificarChamadosAbertos() { /* ...código sem alterações... */ }

module.exports = {
  registrarChamado,
  atualizarStatusChamado,
  verificarChamadosAbertos,
};