// =================================================================================================
// CIPT-WHATSAPP-BOT - VERSÃO DE PRODUÇÃO FINAL (COMPLETA E VERIFICADA)
// Contém todas as funcionalidades, incluindo roteamento, relatórios e timers.
// =================================================================================================

const crypto = require("node:crypto");
global.crypto = crypto;

const express = require('express');
const dotenv = require('dotenv');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const cron = require('node-cron');
const { getCiptPrompt } = require("./ciptPrompt.js");
const { registrarChamado, atualizarStatusChamado, verificarChamadosAbertos } = require("./sheetsChamados");

dotenv.config();
const app = express();
app.use(express.json());
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMAIL_SUPORTE = 'supcti@secti.al.gov.br';
const SITE_OFICIAL = 'secti.al.gov.br';

let embeddingsCache = [];
let sock; 

const authPath = process.env.RENDER_DISK_MOUNT_PATH ? `${process.env.RENDER_DISK_MOUNT_PATH}/auth` : 'auth';
const embeddingsPath = process.env.RENDER_DISK_MOUNT_PATH ? `${process.env.RENDER_DISK_MOUNT_PATH}/embeddings.json` : 'embeddings.json';

// --- CONTROLE DE SESSÕES E ESTADO ---
const usuariosAtivos = {};
const timersEncerramento = {};
const TEMPO_ENCERRAMENTO = 5 * 60 * 1000;
const historicoUsuarios = {};
const LIMITE_HISTORICO = 8;
const contatosEnviados = {};
const GRUPO_SUPORTE_JID = process.env.GRUPO_SUPORTE_JID;

const routingMap = {
    'Limpeza': [{ nome: 'Laysa', jid: '558287058516@s.whatsapp.net' }],
    'Segurança e Portaria': [{ nome: 'Laysa', jid: '558287058516@s.whatsapp.net' }],
    'Manutenção Civil': [{ nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Energia Elétrica': [{ nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Hidráulica / Vazamentos': [{ nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Outros': [{ nome: 'Laysa', jid: '558287058516@s.whatsapp.net' }, { nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Equipamentos / Móveis': [{ nome: 'Laysa', jid: '558287058516@s.whatsapp.net' }, { nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Internet e Rede': [{ nome: 'Laysa', jid: '558287058516@s.whatsapp.net' }, { nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Elevadores': [{ nome: 'Laysa', jid: '558287058516@s.whatsapp.net' }, { nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Administrativo': [{ nome: 'Pedro Ivo', jid: '558299992881@s.whatsapp.net' }],
};

// ✅ LISTA DE JIDs DA EQUIPE DE SUPORTE AUTORIZADA A DAR COMANDOS
const equipeSuporteJids = [
    '558287058516@s.whatsapp.net', // Laysa
    '558293826962@s.whatsapp.net', // Daisy
    '558299992881@s.whatsapp.net', // Pedro Ivo
];

// --- FUNÇÕES AUXILIARES ---

async function gerarOuCarregarEmbeddings() {
  console.log(`ℹ️ Verificando cache de embeddings em: ${embeddingsPath}`);
  try {
    if (fs.existsSync(embeddingsPath)) {
      embeddingsCache = JSON.parse(fs.readFileSync(embeddingsPath, 'utf8'));
      console.log("📦 Embeddings carregados do cache no disco persistente.");
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
    console.log("⚙️ Gerando embeddings...");
    for (let chunk of pdfChunks) {
      const embedding = await client.embeddings.create({ model: "text-embedding-3-small", input: chunk });
      embeddingsCache.push({ trecho: chunk, vector: embedding.data[0].embedding });
    }
    fs.writeFileSync(embeddingsPath, JSON.stringify(embeddingsCache, null, 2));
    console.log("✅ Embeddings salvos em cache no disco persistente.");
  } catch (err) {
    console.error("❌ Erro ao carregar/gerar embeddings:", err.message);
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
      messages: [{ role: "system", content: "Sua tarefa é analisar a mensagem e responder em JSON: {\"ehChamado\":\"SIM ou NAO\",\"categoria\":\"Categoria Sugerida\"}. Categorias: Limpeza, Segurança e Portaria, Manutenção Civil, Energia Elétrica, Hidráulica / Vazamentos, Outros, Equipamentos / Móveis, Internet e Rede, Elevadores, Administrativo. Se não for chamado, use {\"ehChamado\":\"NAO\",\"categoria\":\"N/A\"}." }, { role: "user", content: pergunta }],
      temperature: 0,
      max_tokens: 50
    });
    return JSON.parse(resp.choices[0].message.content.trim());
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
  const opcoes = ["Como faço para reservar o auditório?", "Quais são as penalidades por descumprimento das regras?", "Posso levar animais para o CIPT?", "Quais são os horários de funcionamento?"];
  const sorteadas = opcoes.sort(() => 0.5 - Math.random()).slice(0, 2);
  return `\n\n*Posso ajudar com algo mais?* Você pode perguntar, por exemplo:\n- _${sorteadas[0]}_\n- _${sorteadas[1]}_`;
}

async function enviarContato(sock, jid, nome, telefone) {
  try {
    await sock.sendMessage(jid, { text: `Certo! Estou enviando o contato de "${nome}" para você.` });
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${nome}\nTEL;type=CELL;type=VOICE;waid=${telefone}:${telefone}\nEND:VCARD`;
    await sock.sendMessage(jid, { contacts: { displayName: nome, contacts: [{ vcard }] } });
  } catch (err) {
    console.error("❌ Erro ao enviar vCard, enviando fallback:", err.message);
    await sock.sendMessage(jid, { text: `Houve um problema ao enviar o cartão de contato. Você pode contatar *${nome}* pelo número: +${telefone}. Para outras informações, escreva para ${EMAIL_SUPORTE} ou visite ${SITE_OFICIAL}.` });
  }
}

function salvarLog(nome, pergunta) {
  const data = new Date().toLocaleString("pt-BR");
  const linha = `[${data}] 👤 ${nome}: 💬 ${pergunta}\n`;
  fs.appendFile("mensagens.log", linha, (err) => {
    if (err) console.error("❌ Erro ao salvar log:", err);
  });
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function enviarRelatorioDePendencias(sock) {
  if (!sock || !GRUPO_SUPORTE_JID) {
    console.log("[RELATÓRIO] Bot não conectado ou grupo não definido.");
    return;
  }
  const chamadosAbertos = await verificarChamadosAbertos();
  if (chamadosAbertos.length === 0) {
    const mensagem = "📈 *Relatório de Chamados*\n\nNenhum chamado pendente no momento. Bom trabalho, equipe! ✅";
    await sock.sendMessage(GRUPO_SUPORTE_JID, { text: mensagem });
    return;
  }
  const contagemPorResponsavel = {};
  for (const chamado of chamadosAbertos) {
    const responsaveis = routingMap[chamado.categoria] || [{ nome: 'Não atribuído' }];
    for (const responsavel of responsaveis) {
      contagemPorResponsavel[responsavel.nome] = (contagemPorResponsavel[responsavel.nome] || 0) + 1;
    }
  }
  let mensagem = `📈 *Relatório de Chamados Pendentes*\n\nOlá, equipe! Temos *${chamadosAbertos.length} chamado(s)* que precisam de atenção:\n`;
  for (const [nome, count] of Object.entries(contagemPorResponsavel)) {
    mensagem += `\n- ${nome}: ${count} chamado(s) pendente(s)`;
  }
  mensagem += "\n\nPor favor, atualizem os status respondendo aos alertas no grupo. Vamos zerar essa fila! 💪";
  await sock.sendMessage(GRUPO_SUPORTE_JID, { text: mensagem });
}

// --- LÓGICA PRINCIPAL DO BOT ---
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  sock = makeWASocket({ auth: state });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
     if (qr) console.log("‼️ NOVO QR CODE. Gere a imagem em: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr));
    if (connection === 'open') console.log('✅ Conectado ao WhatsApp!');
    if (connection === 'close') {
      const error = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = error !== DisconnectReason.loggedOut;
      console.log(`❌ Conexão caiu (código: ${error}). Reconectando: ${shouldReconnect}`);
      if (error === DisconnectReason.connectionReplaced) console.log("‼️ CONFLITO: Garanta que apenas uma instância do bot esteja rodando!");
      if (shouldReconnect) setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    const nomeContato = msg.pushName || "Usuário";
    const corpoMensagem = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const pergunta = corpoMensagem.trim(); // Mantém o case para o protocolo

    // ✅ NOVA LÓGICA DE COMANDO PRIVADO (Formato: CH-12345 - 1)
    if (!isGroup && equipeSuporteJids.includes(jid)) {
        const matchComando = pergunta.match(/^(CH-\d+)\s*-\s*(\d)$/i);
        if (matchComando) {
            const protocolo = matchComando[1].toUpperCase();
            const comando = matchComando[2];
            const responsavel = nomeContato;
            const telefoneResponsavel = jid;
            let novoStatus = "";

            if (comando === "1") novoStatus = "Em Atendimento";
            else if (comando === "2") novoStatus = "Concluído";
            else if (comando === "3") novoStatus = "Rejeitado";

            if (novoStatus) {
                const usuarioJid = await atualizarStatusChamado(protocolo, novoStatus, responsavel, telefoneResponsavel);
                const statusEmoji = {"Em Atendimento": "📌", "Concluído": "✅", "Rejeitado": "❌"}[novoStatus];

                await sock.sendMessage(jid, { text: `${statusEmoji} Status do chamado *${protocolo}* atualizado para *${novoStatus}* com sucesso.` });

                if (GRUPO_SUPORTE_JID) {
                    const logGrupo = `[LOG] O status do chamado *${protocolo}* foi atualizado para *${novoStatus}* por ${responsavel}.`;
                    await sock.sendMessage(GRUPO_SUPORTE_JID, { text: logGrupo });
                }
                if (usuarioJid) {
                    await sock.sendMessage(usuarioJid, { text: `O status do seu chamado de protocolo *${protocolo}* foi atualizado para *${novoStatus}*.` });
                }
                return;
            }
        }
    }
    
    const perguntaNormalizada = corpoMensagem.toLowerCase().trim().replace(/@bot/gi, "");
    if (isGroup && !corpoMensagem.toLowerCase().includes('@bot')) return;
    if (!perguntaNormalizada) return;

    salvarLog(nomeContato, perguntaNormalizada);
    const agora = Date.now();
    await sock.sendPresenceUpdate('composing', jid);
    await delay(1500);

    try {
      if (usuariosAtivos[jid]?.chamadoPendente) {
        if (perguntaNormalizada === "sim") {
          // ... (lógica de registro de chamado)
          const protocolo = "CH-" + Date.now().toString().slice(-5);
          const sucesso = await registrarChamado({
            protocolo, nome: nomeContato, telefone: jid.split("@")[0],
            descricao: usuariosAtivos[jid].chamadoPendente.descricao, 
            categoria: usuariosAtivos[jid].chamadoPendente.categoria,
            status: "Aberto", usuarioJid: jid
          });
          
          if (sucesso) {
            await sock.sendMessage(jid, { text: `✅ Chamado registrado com sucesso!\n\n*Protocolo:* ${protocolo}\n*Categoria:* ${usuariosAtivos[jid].chamadoPendente.categoria}\n\nA equipe de suporte já foi notificada.` });
            if (GRUPO_SUPORTE_JID) {
              const responsaveis = routingMap[usuariosAtivos[jid].chamadoPendente.categoria] || [];
              let nomesResponsaveis = responsaveis.map(r => r.nome).join(' e ');
              const logGrupo = `[LOG] Novo chamado de *${usuariosAtivos[jid].chamadoPendente.categoria}* (CH-${protocolo}). Notificação enviada para: ${nomesResponsaveis}.`;
              await sock.sendMessage(GRUPO_SUPORTE_JID, { text: logGrupo });
              if (responsaveis.length > 0) {
                for (const responsavel of responsaveis) {
                  // ✅ NOVA MENSAGEM DE NOTIFICAÇÃO
                  const notificacaoPrivada = `🔔 *Nova atribuição de chamado para você.*\n\n*Protocolo:* ${protocolo}\n*Categoria:* ${usuariosAtivos[jid].chamadoPendente.categoria}\n*Descrição:* ${usuariosAtivos[jid].chamadoPendente.descricao}\n\nPara atualizar, responda a esta mensagem com o número do chamado + um dos comandos:\n1 - Em Atendimento\n2 - Concluído\n3 - Rejeitado\n\n*Exemplo:*\n${protocolo} - 1`;
                  await sock.sendMessage(responsavel.jid, { text: notificacaoPrivada });
                }
              }
            }
          } else {
            await sock.sendMessage(jid, { text: `😥 Desculpe, não consegui registrar seu chamado na planilha, mas já notifiquei a equipe sobre o problema. Por favor, aguarde.` });
            if (GRUPO_SUPORTE_JID) {
              await sock.sendMessage(GRUPO_SUPORTE_JID, { text: `🚨 *ATENÇÃO, EQUIPE!* Falha ao registrar o chamado de ${nomeContato} na planilha. Verifiquem os logs. Descrição: "${chamadoPendente.descricao}"` });
            }
          }
          delete usuariosAtivos[jid].chamadoPendente;
          return;
        } else if (perguntaNormalizada === "não" || perguntaNormalizada === "nao") {
          await sock.sendMessage(jid, { text: "Ok, o registro do chamado foi cancelado." });
          delete usuariosAtivos[jid].chamadoPendente;
          return;
        }
      }

      const classificacao = await classificarChamado(perguntaNormalizada);
      if (classificacao.ehChamado === "SIM") {
        usuariosAtivos[jid] = { ...usuariosAtivos[jid], chamadoPendente: { descricao: corpoMensagem, categoria: classificacao.categoria } };
        await sock.sendMessage(jid, { text: `Identifiquei que sua mensagem parece ser uma solicitação de suporte. Confirma o registro do chamado abaixo?\n\n*Descrição:* _${corpoMensagem}_\n*Categoria Sugerida:* ${classificacao.categoria}\n\nResponda com *"Sim"* para confirmar ou *"Não"* para cancelar.` });
        return;
      }
      
      const saudacoes = ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite"];
      if (saudacoes.includes(perguntaNormalizada)) {
        await sock.sendMessage(jid, { text: gerarSaudacao(nomeContato) });
        return;
      }
      
      historicoUsuarios[jid] = historicoUsuarios[jid] || [];
      historicoUsuarios[jid].push({ role: "user", content: perguntaNormalizada });
      if (historicoUsuarios[jid].length > LIMITE_HISTORICO) historicoUsuarios[jid].splice(0, historicoUsuarios[jid].length - LIMITE_HISTORICO);

      const trechos = await buscarTrechosRelevantes(perguntaNormalizada);
      const isFollowUp = ehFollowUp(perguntaNormalizada);
      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: getCiptPrompt(nomeContato, EMAIL_SUPORTE, SITE_OFICIAL) },
          ...historicoUsuarios[jid],
          { role: "user", content: `Com base no contexto, responda à minha última pergunta: "${perguntaNormalizada}". Contexto: """${trechos}"""` },
          ...(isFollowUp ? [{ role: "system", content: "Isto é um follow-up. Responda de forma direta e concisa." }] : [])
        ],
        temperature: 0.25,
        max_tokens: 700
      });
      let resposta = completion.choices[0].message.content.trim();
      historicoUsuarios[jid].push({ role: "assistant", content: resposta });

      if (!contatosEnviados[jid]) {
        const decisao = await client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: "A resposta do assistente indica necessidade de contato humano (reservas, problemas administrativos)? Responda só SIM ou NÃO." }, { role: "user", content: `Usuário: ${perguntaNormalizada}\nAssistente: ${resposta}` }], temperature: 0, max_tokens: 5 });
        if (decisao.choices[0].message.content.trim().toUpperCase().includes("SIM")) {
            if (resposta.toLowerCase().includes("auditório")) await enviarContato(sock, jid, "SUPTI - Reservas do Auditório", "558287145526");
            else if (resposta.toLowerCase().includes("sala de reunião")) await enviarContato(sock, jid, "Portaria do Centro de Inovação", "558288334368");
            contatosEnviados[jid] = true;
        }
      }
      
      const despedidas = ["obrigado", "obrigada", "valeu", "tchau", "até mais", "flw"];
      if(!despedidas.includes(perguntaNormalizada)) {
        resposta += gerarSugestoes();
      } else {
         delete usuariosAtivos[jid];
         if (timersEncerramento[jid]) clearTimeout(timersEncerramento[jid]);
         delete timersEncerramento[jid];
         delete historicoUsuarios[jid];
         delete contatosEnviados[jid];
      }
      
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
      await sock.sendMessage(jid, { text: "Peço desculpas, ocorreu um erro interno. Tente novamente." });
    }
  });
}

async function main() {
  await gerarOuCarregarEmbeddings();
  const sock = await startBot();
  
  app.get('/', (req, res) => res.send('✅ Bot do CIPT está online!'));
  app.listen(process.env.PORT || 3000, () => {
    console.log(`🌐 Servidor web rodando na porta ${process.env.PORT || 3000}`);
    if(process.env.RENDER_URL) {
      console.log(`🚀 Iniciando ping de keep-alive para ${process.env.RENDER_URL}`);
      setInterval(() => { fetch(process.env.RENDER_URL).catch(err => console.error("⚠️ Erro no keep-alive:", err.message)); }, 14 * 60 * 1000);
      
      console.log("⏰ Agendador de relatórios de pendências ativado para 11:30 e 16:00.");
      cron.schedule('30 11,16 * * 1-5', () => {
        console.log('[CRON] Executando verificação de chamados pendentes...');
        enviarRelatorioDePendencias(sock);
      }, {
        scheduled: true,
        timezone: "America/Maceio"
      });
    }
  });
}

main();

// LÓGICA DE DESLIGAMENTO GRACIOSO REMOVIDA