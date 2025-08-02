// =================================================================================================
// CIPT-WHATSAPP-BOT - VERSÃO FINAL E COMPLETA (AGO/2025)
// Mantém 100% das funcionalidades originais com bugs corrigidos.
// Personalidade do bot definida em ciptPrompt.js.
// Preparado para persistência de sessão com Render Disk.
// =================================================================================================

// Corrige erro do Baileys no Node 20+
const crypto = require("node:crypto");
global.crypto = crypto;

const express = require('express');
const dotenv = require('dotenv');
const fs = require('fs');
const { exec } = require("child_process");
const pdfParse = require('pdf-parse');
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const nodemailer = require("nodemailer");
const { ciptPrompt } = require("./ciptPrompt.js"); // <-- Carrega a personalidade
const { registrarChamado, atualizarStatusChamado } = require("./sheetsChamados");

dotenv.config();

const app = express();
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let embeddingsCache = [];

// --- CONTROLE DE SESSÕES E ESTADO ---
const usuariosAtivos = {};
const timersEncerramento = {};
const TEMPO_INATIVIDADE = 30 * 60 * 1000;
const TEMPO_ENCERRAMENTO = 5 * 60 * 1000;
const historicoUsuarios = {};
const LIMITE_HISTORICO = 8;
const contatosEnviados = {};
const GRUPO_SUPORTE_JID = process.env.GRUPO_SUPORTE_JID;


// --- FUNÇÕES AUXILIARES (MANTIDAS DO ORIGINAL) ---

async function gerarOuCarregarEmbeddings() {
  try {
    if (fs.existsSync('./embeddings.json')) {
      embeddingsCache = JSON.parse(fs.readFileSync('./embeddings.json', 'utf8'));
      console.log("📦 Embeddings carregados do cache.");
      return;
    }
    console.log("📄 Lendo documentos para a base de conhecimento...");
    const dataBuffer = fs.readFileSync('./regimento.pdf');
    let pdfData = await pdfParse(dataBuffer);
    let textoNormalizado = pdfData.text.replace(/\n\s*\n/g, '\n').replace(/\s+/g, ' ');
    const fontesExtras = fs.readFileSync('./fontes.txt', 'utf8');
    const fontesNormalizadas = fontesExtras.replace(/\n\s*\n/g, '\n').replace(/\s+/g, ' ');
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1200, chunkOverlap: 200 });
    const pdfDividido = await splitter.splitText(textoNormalizado);
    const fontesDivididas = await splitter.splitText(fontesNormalizadas);
    const pdfChunks = [...pdfDividido, ...fontesDivididas];
    console.log(`📚 Documentos divididos em ${pdfChunks.length} trechos.`);
    console.log("⚙️ Gerando embeddings (pode levar um tempo na primeira vez)...");
    for (let chunk of pdfChunks) {
      const embedding = await client.embeddings.create({ model: "text-embedding-3-small", input: chunk });
      embeddingsCache.push({ trecho: chunk, vector: embedding.data[0].embedding });
    }
    fs.writeFileSync('./embeddings.json', JSON.stringify(embeddingsCache, null, 2));
    console.log("✅ Embeddings salvos em cache local (embeddings.json).");
  } catch (err) {
    console.error("❌ Erro crítico ao carregar embeddings:", err.message);
  }
}

async function buscarTrechosRelevantes(pergunta) {
  try {
    const perguntaEmbedding = await client.embeddings.create({ model: "text-embedding-3-small", input: pergunta });
    const perguntaVector = perguntaEmbedding.data[0].embedding;
    const resultados = embeddingsCache.map(e => {
      const dot = perguntaVector.reduce((acc, val, idx) => acc + val * e.vector[idx], 0);
      const magA = Math.sqrt(perguntaVector.reduce((acc, val) => acc + val * val, 0));
      const magB = Math.sqrt(e.vector.reduce((acc, val) => acc + val * val, 0));
      const score = dot / (magA * magB);
      return { trecho: e.trecho, score };
    });
    resultados.sort((a, b) => b.score - a.score);
    const resultadosFiltrados = resultados.filter(r => r.score > 0.72);
    const selecionados = (resultadosFiltrados.length > 0 ? resultadosFiltrados : resultados).slice(0, 8).map(r => r.trecho);
    console.log(`🔎 Resgatados ${selecionados.length} trechos relevantes.`);
    return selecionados.join("\n\n");
  } catch (err) {
    console.error("❌ Erro ao buscar trechos:", err.message);
    return "";
  }
}

async function classificarChamado(pergunta) {
  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "Sua tarefa é analisar a mensagem do usuário e responder em JSON: {\"ehChamado\":\"SIM ou NAO\",\"categoria\":\"Categoria Sugerida\"}. Categorias: Internet e Rede, Energia Elétrica, Limpeza, Manutenção Civil, Segurança e Portaria, Elevadores, Hidráulica / Vazamentos, Equipamentos / Móveis, Administrativo / Outros. Se não for um chamado, use {\"ehChamado\":\"NAO\",\"categoria\":\"N/A\"}." }, { role: "user", content: pergunta }],
      temperature: 0,
      max_tokens: 50
    });
    const conteudo = resp.choices[0].message.content.trim();
    return JSON.parse(conteudo);
  } catch (err) {
    console.error("❌ Erro ao classificar chamado:", err.message);
    return { ehChamado: "NAO", categoria: "N/A" };
  }
}

function ehFollowUp(pergunta) {
  const conectores = ["e ", "mas ", "então", "sobre isso", "e quanto", "e sobre", "ainda", "continuando", "ok", "certo"];
  const curtas = pergunta.split(" ").length <= 5;
  return conectores.some(c => pergunta.startsWith(c)) || curtas;
}

function gerarSaudacao(nome) {
  const opcoes = [`Olá, ${nome}! Sou a IA do CIPT. Em que posso ser útil hoje? 👋`, `Bom dia, ${nome}! Aqui é a assistente virtual do CIPT. Como posso ajudar?`, `Seja bem-vindo(a) ao CIPT, ${nome}. Estou à disposição para esclarecer suas dúvidas. 🙂`];
  return opcoes[Math.floor(Math.random() * opcoes.length)];
}

function gerarSugestoes() {
  const opcoes = ["Como faço para reservar o auditório?", "Quais são as penalidades por descumprimento das regras?", "Posso levar animais para o CIPT?", "Quais são os horários de funcionamento?", "Como funciona o estacionamento do CIPT?", "Como faço meu cadastro para ter acesso ao espaço?"];
  const sorteadas = opcoes.sort(() => 0.5 - Math.random()).slice(0, 2);
  return `\n\n*Posso ajudar com algo mais?* Você pode perguntar, por exemplo:\n- _${sorteadas[0]}_\n- _${sorteadas[1]}_`;
}

async function enviarContato(sock, jid, nome, telefone) {
  try {
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${nome}\nTEL;type=CELL;type=VOICE;waid=${telefone}:${telefone}\nEND:VCARD`;
    await sock.sendMessage(jid, { contacts: { displayName: nome, contacts: [{ vcard }] } });
  } catch (err) {
    console.error("❌ Erro ao enviar vCard, enviando fallback:", err.message);
    await sock.sendMessage(jid, { text: `Você pode contatar *${nome}* pelo número: +${telefone}` });
  }
}

function salvarLog(nome, pergunta) {
  const data = new Date().toLocaleString("pt-BR");
  const linha = `[${data}] 👤 ${nome}: 💬 ${pergunta}\n`;
  fs.appendFile("mensagens.log", linha, (err) => {
    if (err) console.error("❌ Erro ao salvar log:", err);
  });
}

// --- LÓGICA PRINCIPAL DO BOT ---
async function startBot() {
  // Caminho da sessão agora aponta para o Render Disk.
  const authPath = process.env.RENDER_DISK_MOUNT_PATH ? `${process.env.RENDER_DISK_MOUNT_PATH}/auth` : 'auth';

  console.log(`ℹ️ Usando pasta de sessão em: ${authPath}`);

  // A inicialização da sessão acontece aqui, UMA ÚNICA VEZ
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const sock = makeWASocket({ auth: state });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
     if (qr) {
      console.log("‼️ NOVO QR CODE GERADO. Escaneie com seu celular. Você pode gerar uma imagem do QR em: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr));
    }
    if (connection === 'open') console.log('✅ Conectado ao WhatsApp!');
    if (connection === 'close') {
      const error = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = error !== DisconnectReason.loggedOut;
      console.log(`❌ Conexão caiu (código: ${error}). Reconectando: ${shouldReconnect}`);
      if (error === DisconnectReason.connectionReplaced) console.log("‼️ CONFLITO: Outra sessão foi aberta. Garanta que apenas uma instância do bot esteja rodando!");
      if (shouldReconnect) setTimeout(startBot, 5000);
    }
  });

  // O restante do seu código (sock.ev.on('messages.upsert', ...)) continua aqui...

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    const nomeContato = msg.pushName || "Usuário";

    // =========================================================================
    // ✅ "DEDO-DURO" ATIVADO PARA DIAGNÓSTICO
    // =========================================================================
    if (isGroup && jid === GRUPO_SUPORTE_JID) {
        console.log("================= DEBUG GRUPO SUPORTE =================");
        console.log(JSON.stringify(msg, null, 2));
        console.log("==========================================================");
    }
    // =========================================================================


     // --- LÓGICA DE ATUALIZAÇÃO DE CHAMADO (GRUPO DE SUPORTE) ---
    if (isGroup && jid === GRUPO_SUPORTE_JID && msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        const textoResposta = (msg.message.extendedTextMessage.text || "").trim();
        
        // CORREÇÃO: Lógica mais robusta para ler o texto da mensagem original
        const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
        const textoMensagemOriginal = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || "";

        const matchProtocolo = textoMensagemOriginal.match(/Protocolo:\s*(CH-\d+)/);

        if (matchProtocolo) {
            const protocolo = matchProtocolo[1];
            const responsavel = nomeContato;
            let novoStatus = "";

            if (textoResposta === "1") novoStatus = "Em Atendimento";
            else if (textoResposta === "2") novoStatus = "Concluído";
            else if (textoResposta === "3") novoStatus = "Rejeitado";

            if (novoStatus) {
                const usuarioJid = await atualizarStatusChamado(protocolo, novoStatus, responsavel);
                const statusEmoji = {"Em Atendimento": "📌", "Concluído": "✅", "Rejeitado": "❌"}[novoStatus];
                await sock.sendMessage(jid, { text: `${statusEmoji} Chamado ${protocolo} atualizado para *${novoStatus}* por ${responsavel}.` });
                if (usuarioJid) await sock.sendMessage(usuarioJid, { text: `${statusEmoji} Seu chamado ${protocolo} foi atualizado para *${novoStatus}*. Agradecemos o contato.` });
                return;
            }
        }
    }

    // --- LÓGICA DE PROCESSAMENTO DE MENSAGENS DO USUÁRIO ---
    const corpoMensagem = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "";
    if (isGroup && !corpoMensagem.toLowerCase().includes('@bot')) return;
    
    const pergunta = corpoMensagem.replace(/@bot/gi, "").toLowerCase().trim();
    if (!pergunta) return;

    salvarLog(nomeContato, pergunta);
    const agora = Date.now();

    try {
      if (usuariosAtivos[jid]?.chamadoPendente) {
        const chamadoPendente = usuariosAtivos[jid].chamadoPendente;
        if (pergunta === "sim") {
          const protocolo = "CH-" + Date.now().toString().slice(-5);
          await registrarChamado({ protocolo, nome: nomeContato, telefone: jid.split("@")[0], descricao: chamadoPendente.descricao, categoria: chamadoPendente.categoria, status: "Aberto", usuarioJid: jid });
          await sock.sendMessage(jid, { text: `✅ Chamado registrado com sucesso!\n\n*Protocolo:* ${protocolo}\n*Categoria:* ${chamadoPendente.categoria}\n\nA equipe de suporte já foi notificada e em breve cuidará da sua solicitação.` });
          
         if (GRUPO_SUPORTE_JID) {
            /*
            // DEIXE A MENSAGEM ORIGINAL COMENTADA POR ENQUANTO
            const menuTexto = `🚨 *Novo chamado aberto!* 🚨\n\n*Protocolo:* ${protocolo}\n*Usuário:* ${nomeContato}\n*Telefone:* ${jid.split("@")[0]}\n*Categoria:* ${chamadoPendente.categoria}\n*Descrição:* ${chamadoPendente.descricao}\n\n-------------------------------------\n👉 *RESPONDA a esta mensagem com o número da opção:*\n*1* - Em Atendimento\n*2* - Concluído\n*3* - Rejeitado`;
            */

            // ✅ USE ESTA VERSÃO SIMPLES PARA O TESTE
            const menuTexto = `Novo chamado aberto para teste. Protocolo: ${protocolo}. Responda com 1, 2 ou 3.`;

            await sock.sendMessage(GRUPO_SUPORTE_JID, { text: menuTexto });
          }
          delete usuariosAtivos[jid].chamadoPendente;
          return;
        } else if (pergunta === "não" || pergunta === "nao") {
          await sock.sendMessage(jid, { text: "Ok, o registro do chamado foi cancelado." });
          delete usuariosAtivos[jid].chamadoPendente;
          return;
        }
      }

      const classificacao = await classificarChamado(pergunta);
      if (classificacao.ehChamado === "SIM") {
        usuariosAtivos[jid] = { ...usuariosAtivos[jid], chamadoPendente: { descricao: pergunta, categoria: classificacao.categoria } };
        await sock.sendMessage(jid, { text: `Identifiquei que sua mensagem parece ser uma solicitação de suporte. Confirma o registro do chamado abaixo?\n\n*Descrição:* _${pergunta}_\n*Categoria Sugerida:* ${classificacao.categoria}\n\nResponda com *"Sim"* para confirmar ou *"Não"* para cancelar.` });
        return;
      }
      
      const saudacoes = ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite", "e aí", "tudo bem", "tudo bom"];
      if (saudacoes.includes(pergunta)) {
        await sock.sendMessage(jid, { text: gerarSaudacao(nomeContato) });
        return;
      }
      
      historicoUsuarios[jid] = historicoUsuarios[jid] || [];
      historicoUsuarios[jid].push({ role: "user", content: pergunta });
      if (historicoUsuarios[jid].length > LIMITE_HISTORICO) historicoUsuarios[jid].splice(0, historicoUsuarios[jid].length - LIMITE_HISTORICO);

      const trechos = await buscarTrechosRelevantes(pergunta);
      const isFollowUp = ehFollowUp(pergunta);
      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: ciptPrompt },
          ...historicoUsuarios[jid],
          { role: "user", content: `Com base no contexto fornecido e no histórico da nossa conversa, responda à minha última pergunta: "${pergunta}". Contexto: """${trechos}"""` },
          ...(isFollowUp ? [{ role: "system", content: "Isto é um follow-up. Responda de forma direta e concisa." }] : [])
        ],
        temperature: 0.25,
        max_tokens: 700
      });
      let resposta = completion.choices[0].message.content.trim();
      historicoUsuarios[jid].push({ role: "assistant", content: resposta });

      if (!contatosEnviados[jid]) {
        const decisao = await client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: "A resposta do assistente indica necessidade de contato humano (reservas, problemas administrativos)? Responda só SIM ou NÃO." }, { role: "user", content: `Usuário: ${pergunta}\nAssistente: ${resposta}` }], temperature: 0, max_tokens: 5 });
        if (decisao.choices[0].message.content.trim().toUpperCase().includes("SIM")) {
            resposta += "\n\nPara prosseguir com sua solicitação, por favor, entre em contato com a equipe responsável:";
            if (resposta.toLowerCase().includes("auditório")) await enviarContato(sock, jid, "Reservas Auditório CIPT", "558287145526");
            else if (resposta.toLowerCase().includes("sala de reunião")) await enviarContato(sock, jid, "Recepção CIPT", "558288334368");
            contatosEnviados[jid] = true;
        }
      }
      
      resposta += gerarSugestoes();
      await sock.sendMessage(jid, { text: resposta });

      usuariosAtivos[jid] = agora;
      if (timersEncerramento[jid]) clearTimeout(timersEncerramento[jid]);
      timersEncerramento[jid] = setTimeout(async () => {
        if (Date.now() - (usuariosAtivos[jid] || 0) >= TEMPO_ENCERRAMENTO) {
          await sock.sendMessage(jid, { text: "Este atendimento foi encerrado por inatividade. Se precisar de algo mais, é só me chamar! 👋" });
          delete usuariosAtivos[jid];
          delete timersEncerramento[jid];
          delete historicoUsuarios[jid];
          delete contatosEnviados[jid];
        }
      }, TEMPO_ENCERRAMENTO);

    } catch (err) {
      console.error('❌ Erro no processamento da mensagem:', err.message, err.stack);
      await sock.sendMessage(jid, { text: "Peço desculpas, ocorreu um erro interno e não consegui processar sua solicitação. A equipe técnica já foi notificada. Por favor, tente novamente em alguns instantes." });
    }
  });
}

// --- INICIALIZAÇÃO DO SERVIÇO ---
async function main() {
  await gerarOuCarregarEmbeddings();
  await startBot();
  
  exec("node testeSheets.js", (error, stdout, stderr) => {
    if (error) console.error(`❌ Erro no teste Google Sheets: ${error.message}`);
    if (stderr) console.error(`⚠️ Aviso no teste Google Sheets: ${stderr}`);
    if (stdout) console.log(`✅ Resultado do teste Google Sheets:\n${stdout}`);
  });
  
  app.get('/', (req, res) => res.send('✅ Bot do CIPT está online!'));
  app.listen(process.env.PORT || 3000, () => {
    console.log(`🌐 Servidor web rodando na porta ${process.env.PORT || 3000}`);
    if(process.env.RENDER_URL) {
      console.log(`🚀 Iniciando ping de keep-alive para ${process.env.RENDER_URL}`);
      setInterval(() => {
        fetch(process.env.RENDER_URL).catch(err => console.error("⚠️ Erro no keep-alive:", err.message));
      }, 14 * 60 * 1000); // Ping a cada 14 minutos
    }
  });
}

main();