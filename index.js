// Corrige erro do Baileys no Node 20+
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
const nodemailer = require("nodemailer");
const { ciptPrompt } = require("./ciptPrompt.js");
const { registrarChamado, atualizarStatusChamado } = require("./sheetsChamados");

dotenv.config();

const app = express();
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let pdfChunks = [];
let embeddingsCache = [];

// Controle de sessões
const usuariosAtivos = {};
const usuariosSemResposta = {};
const timersEncerramento = {};
const TEMPO_INATIVIDADE = 30 * 60 * 1000;
const TEMPO_ENCERRAMENTO = 5 * 60 * 1000;
const TEMPO_CHECAGEM = 30 * 1000;
const historicoUsuarios = {};
const LIMITE_HISTORICO = 6;
const contatosEnviados = {};
const GRUPO_SUPORTE_JID = process.env.GRUPO_SUPORTE_JID;

// Função para gerar ou carregar embeddings
async function gerarOuCarregarEmbeddings() {
  try {
    if (fs.existsSync('./embeddings.json')) {
      embeddingsCache = JSON.parse(fs.readFileSync('./embeddings.json', 'utf8'));
      console.log("📦 Embeddings carregados do cache.");
      return;
    }

    console.log("📄 Lendo regimento e fontes extras...");
    const dataBuffer = fs.readFileSync('./regimento.pdf');
    let pdfData = await pdfParse(dataBuffer);

    let textoNormalizado = pdfData.text.replace(/\n\s*\n/g, '\n').replace(/\s+/g, ' ');
    const fontesExtras = fs.readFileSync('./fontes.txt', 'utf8');
    const fontesNormalizadas = fontesExtras.replace(/\n\s*\n/g, '\n').replace(/\s+/g, ' ');

    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1200, chunkOverlap: 200 });

    const pdfDividido = await splitter.splitText(textoNormalizado);
    const fontesDivididas = await splitter.splitText(fontesNormalizadas);
    pdfChunks = [...pdfDividido, ...fontesDivididas];

    console.log(`📚 Regimento dividido em ${pdfDividido.length} trechos.`);
    console.log(`📚 Fontes extras divididas em ${fontesDivididas.length} trechos.`);
    console.log(`📄 Total carregado: ${pdfChunks.length} trechos.`);

    console.log("⚙️ Gerando embeddings...");
    for (let chunk of pdfChunks) {
      const embedding = await client.embeddings.create({
        model: "text-embedding-3-small",
        input: chunk
      });
      embeddingsCache.push({ trecho: chunk, vector: embedding.data[0].embedding });
    }

    fs.writeFileSync('./embeddings.json', JSON.stringify(embeddingsCache, null, 2));
    console.log("✅ Embeddings salvos em cache.");
  } catch (err) {
    console.error("❌ Erro ao carregar embeddings:", err.message);
  }
}

// Buscar trechos relevantes
async function buscarTrechosRelevantes(pergunta) {
  try {
    const perguntaEmbedding = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: pergunta
    });

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
    const selecionados = (resultadosFiltrados.length > 0 ? resultadosFiltrados : resultados)
      .slice(0, 8).map(r => r.trecho);

    console.log(`🔎 Resgatados ${selecionados.length} trechos relevantes.`);
    return selecionados.join("\n\n");

  } catch (err) {
    console.error("❌ Erro ao buscar trechos relevantes:", err.message);
    return "";
  }
}

// Classifica se a mensagem é chamado e sugere categoria
async function classificarChamado(pergunta) {
  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `Você é um classificador de chamados para um condomínio/empresa. 
          Sua tarefa é responder em JSON no formato: {"ehChamado":"SIM ou NAO","categoria":"Categoria"}.
          Categorias disponíveis: 
          - Internet e Rede
          - Energia Elétrica
          - Limpeza
          - Manutenção Civil
          - Segurança e Portaria
          - Elevadores
          - Hidráulica / Vazamentos
          - Equipamentos / Móveis
          - Administrativo / Outros
          
          Caso não seja chamado, responda {"ehChamado":"NAO","categoria":"N/A"}.
          Seja objetivo e não adicione nada além do JSON.`
        },
        { role: "user", content: pergunta }
      ],
      temperature: 0,
      max_tokens: 50
    });

    const conteudo = resp.choices[0].message.content.trim();
    try {
      return JSON.parse(conteudo);
    } catch (e) {
      console.error("⚠️ Erro ao interpretar JSON:", conteudo);
      return { ehChamado: "NAO", categoria: "N/A" };
    }
  } catch (err) {
    console.error("❌ Erro ao classificar chamado:", err.message);
    return { ehChamado: "NAO", categoria: "N/A" };
  }
}

// Detecta follow-up
function ehFollowUp(pergunta) {
  const conectores = [
    "e ", "mas ", "então", "sobre isso", "e quanto", "e sobre", "ainda", "continuando", "ok", "certo"
  ];
  const curtas = pergunta.split(" ").length <= 5;
  return conectores.some(c => pergunta.startsWith(c)) || curtas;
}

// Saudações
function gerarSaudacao(nome) {
  const opcoes = [
    `Olá, ${nome}! 👋`,
    `Oi, ${nome}! Tudo bem? 🙂`,
    `Seja bem-vindo(a), ${nome}! 🌟`,
    `Oi oi, ${nome}! Como posso te ajudar hoje? 🤗`,
    `Prazer falar com você, ${nome}! 🙌`
  ];
  return opcoes[Math.floor(Math.random() * opcoes.length)];
}

// Sugestões dinâmicas
function gerarSugestoes() {
  const opcoes = [
    "Como faço para reservar o auditório?",
    "Quais são as penalidades por descumprimento das regras?",
    "Posso levar animais para o CIPT?",
    "Quais são os horários de funcionamento?",
    "Como funciona o estacionamento do CIPT?",
    "Como faço meu cadastro para ter acesso ao espaço?",
    "Qual é a diferença entre o auditório e as salas de reunião?",
    "Quem pode usar os laboratórios do CIPT?",
    "Quais são os documentos necessários para reservar um espaço?",
    "Como funciona o restaurante-escola?",
  ];
  const sorteadas = opcoes.sort(() => 0.5 - Math.random()).slice(0, 3);
  return `
ℹ️ Você também pode me perguntar, por exemplo:
- ${sorteadas[0]}
- ${sorteadas[1]}
- ${sorteadas[2]}
`;
}

// Enviar vCard
async function enviarContato(sock, jid, nome, telefone) {
  try {
    const sentMsg = await sock.sendMessage(jid, {
      contacts: {
        displayName: nome,
        contacts: [{
          displayName: nome,
          vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${nome}\nTEL;type=CELL;type=VOICE;waid=${telefone}:${telefone}\nEND:VCARD`
        }]
      }
    });

    setTimeout(async () => {
      if (!sentMsg.key?.id) {
        console.log(`⚠️ vCard não entregue, enviando fallback para ${jid}`);
        await sock.sendMessage(jid, { text: `📞 Contato de ${nome}: +${telefone}` });
      }
    }, 4000);

  } catch (err) {
    console.error("Erro ao enviar vCard:", err.message);
    await sock.sendMessage(jid, { text: `📞 Contato de ${nome}: +${telefone}` });
  }
}

// Função para enviar email
async function enviarEmail(assunto, mensagem) {
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
    });
    await transporter.sendMail({
      from: `"Bot CIPT" <${process.env.GMAIL_USER}>`,
      to: "supcti.secti@gmail.com",
      subject: assunto,
      text: mensagem
    });
  } catch (error) {
    console.error("Erro ao enviar email:", error.message);
  }
}

// Salvar logs
function salvarLog(nome, pergunta) {
  const data = new Date().toLocaleString("pt-BR");
  const linha = `[${data}] 👤 ${nome}: 💬 ${pergunta}\n`;
  fs.appendFile("mensagens.log", linha, (err) => {
    if (err) {
      console.error("❌ Erro ao salvar log:", err);
    }
  });
}

// Inicialização do bot
async function startBot() {
  await gerarOuCarregarEmbeddings();

  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({ auth: state });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      console.log(`📲 Escaneie o QR: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
    }
    if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp!');
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 409;
      console.log('❌ Conexão caiu. Reiniciando:', shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (msg.key.fromMe) return;

    const jid = msg.key.remoteJid;

    // Grupo
    if (jid.endsWith("@g.us")) {
      const textoGrupo =
        msg.message?.extendedTextMessage?.text?.toLowerCase() ||
        msg.message?.conversation?.toLowerCase() ||
        "";
      if (!textoGrupo.includes("@bot")) return;
    }

    if (msg.message?.conversation) {
      const pergunta = msg.message.conversation.toLowerCase().trim();
      const isFollowUp = ehFollowUp(pergunta);
      const nomeContato = msg.pushName || "visitante";
      const agora = Date.now();

      // Chamados (com classificação inteligente)
      const classificacao = await classificarChamado(pergunta);

      if (classificacao.ehChamado === "SIM") {
        const confirmacao = `👀 Percebi que você quer registrar um chamado. Confirma?\n\n📌 Descrição: "${pergunta}"\n📂 Categoria: ${classificacao.categoria}\n\nResponda com "Sim" para confirmar ou "Não" para cancelar.`;

        usuariosAtivos[jid] = { 
          ...usuariosAtivos[jid], 
          chamadoPendente: { descricao: pergunta, categoria: classificacao.categoria } 
        };

        await sock.sendMessage(jid, { text: confirmacao });
        return;
      }

      historicoUsuarios[jid] = historicoUsuarios[jid] || [];
      historicoUsuarios[jid].push({ role: "user", content: pergunta });
      if (historicoUsuarios[jid].length > LIMITE_HISTORICO) {
        historicoUsuarios[jid] = historicoUsuarios[jid].slice(-LIMITE_HISTORICO);
      }

      salvarLog(nomeContato, pergunta);

      // Tratamento de mensagens de botões e confirmação de chamado
      if (usuariosAtivos[jid]?.chamadoPendente) {
        if (pergunta === "sim") {
          const chamado = usuariosAtivos[jid].chamadoPendente;
          const protocolo = "CH-" + Date.now().toString().slice(-5);

          const classificacao = await classificarChamado(chamado.descricao);
          chamado.categoria = classificacao?.categoria || "Outros";

          await registrarChamado({
            protocolo,
            nome: nomeContato,
            telefone: jid.split("@")[0],
            descricao: chamado.descricao,
            categoria: chamado.categoria,
            status: "Aberto",
            usuarioJid: jid
          });

          await sock.sendMessage(jid, {
            text: `✅ Chamado registrado com sucesso!\n📌 Protocolo: ${protocolo}\n📂 Categoria: ${chamado.categoria}\n\nA equipe já foi notificada.`
          });

          if (GRUPO_SUPORTE_JID) {
            await sock.sendMessage(GRUPO_SUPORTE_JID, {
              text: `🚨 Novo chamado aberto!\n📌 Protocolo: ${protocolo}\n👤 Usuário: ${nomeContato}\n📂 Categoria: ${chamado.categoria}\n📝 Descrição: ${chamado.descricao}`,
              templateButtons: [
                { index: 1, quickReplyButton: { displayText: "Chamado em Atendimento", id: `atendimento_${protocolo}` } },
                { index: 2, quickReplyButton: { displayText: "Chamado Concluído", id: `concluido_${protocolo}` } },
                { index: 3, quickReplyButton: { displayText: "Chamado Rejeitado", id: `rejeitado_${protocolo}` } },
              ]
            });
          }

          delete usuariosAtivos[jid].chamadoPendente;
          return;
        }

        if (pergunta === "não") {
          await sock.sendMessage(jid, { text: "❌ Chamado cancelado." });
          delete usuariosAtivos[jid].chamadoPendente;
          return;
        }
      }

      // Captura clique nos botões do grupo
      if (msg.message?.templateButtonReplyMessage) {
        const buttonId = msg.message.templateButtonReplyMessage.selectedId;
        const jid = msg.key.remoteJid;

        if (buttonId.startsWith("atendimento_")) {
          const protocolo = buttonId.replace("atendimento_", "");
          const responsavel = msg.pushName || "Equipe Suporte";
          const usuarioJid = await atualizarStatusChamado(protocolo, "Em Atendimento", responsavel);

          await sock.sendMessage(jid, { text: `📌 Chamado ${protocolo} atualizado para *Em Atendimento* por ${responsavel}.` });

          if (usuarioJid) {
            await sock.sendMessage(usuarioJid, { text: `📌 Seu chamado ${protocolo} agora está *Em Atendimento* por ${responsavel}.` });
          }
        }

        if (buttonId.startsWith("concluido_")) {
          const protocolo = buttonId.replace("concluido_", "");
          const usuarioJid = await atualizarStatusChamado(protocolo, "Concluído");
          await sock.sendMessage(jid, { text: `✅ Chamado ${protocolo} atualizado para *Concluído*.` });

          if (usuarioJid) {
            await sock.sendMessage(usuarioJid, { text: `✅ Seu chamado ${protocolo} foi *Concluído*. Obrigado pelo contato!` });
          }
        }

        if (buttonId.startsWith("rejeitado_")) {
          const protocolo = buttonId.replace("rejeitado_", "");
          const usuarioJid = await atualizarStatusChamado(protocolo, "Rejeitado");
          await sock.sendMessage(jid, { text: `❌ Chamado ${protocolo} atualizado para *Rejeitado*.` });

          if (usuarioJid) {
            await sock.sendMessage(usuarioJid, { text: `❌ Seu chamado ${protocolo} foi *Rejeitado*. Caso necessário, entre em contato novamente.` });
          }
        }
      }

      // O bloco 'try...catch' agora engloba a lógica principal do bot
      try {
        const saudacoes = ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite", "e aí"];
        const agradecimentos = ["obrigado", "obrigada", "valeu", "thanks", "agradecido"];
        const despedidas = ["tchau", "até mais", "flw", "falou", "até logo", "até breve"];

        if (saudacoes.includes(pergunta)) {
          const saudacao = `${gerarSaudacao(nomeContato)}\nSou a *IA do CIPT*! Posso te ajudar com dúvidas sobre acesso, reservas de espaços, regras de convivência e tudo mais do nosso regimento interno. Quer saber por onde começar?`;
          await sock.sendMessage(jid, { text: saudacao });
          return;
        }

        if (agradecimentos.includes(pergunta) || despedidas.includes(pergunta)) {
          await sock.sendMessage(jid, {
            text: `De nada, ${nomeContato}! Foi um prazer ajudar 🤗\nSe precisar novamente, é só me chamar. Até logo!`
          });
          delete usuariosAtivos[jid];
          if (timersEncerramento[jid]) clearTimeout(timersEncerramento[jid]);
          delete timersEncerramento[jid];
          return;
        }

        const trechos = await buscarTrechosRelevantes(pergunta);
        let resposta;

        if (!trechos || trechos.trim().length < 30) {
          resposta = "Olha, não encontrei essa informação no regimento interno e nem nas bases que eu uso para te responder. Mas você pode falar direto com a administração pelo e-mail supcti@secti.al.gov.br ou passando na recepção do CIPT, que eles resolvem rapidinho.";
        } else {
          const completion = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: `${ciptPrompt}\n⚠️ Importante: use apenas trechos coerentes e não misture regras diferentes.` },
              ...historicoUsuarios[jid],
              { role: "assistant", content: `Base de consulta:\n${trechos}` },
              ...(isFollowUp ? [{ role: "system", content: "⚡ A mensagem é uma continuação. Responda levando em conta o histórico acima, sem repetir informações já dadas." }] : [])
            ],
            temperature: 0.2,
            max_tokens: 700
          });
          resposta = completion.choices[0].message.content.trim();
          historicoUsuarios[jid].push({ role: "assistant", content: resposta });
        }

        let saudacaoExtra = "";
        if (!usuariosAtivos[jid] || (agora - usuariosAtivos[jid]) > TEMPO_INATIVIDADE) {
          saudacaoExtra = `${gerarSaudacao(nomeContato)}\nAqui é o assistente virtual do Centro de Inovação do Jaraguá — pode me chamar de *IA do CIPT*.\n\n`;
        }

        usuariosAtivos[jid] = agora;
        usuariosSemResposta[jid] = false;

        if (!contatosEnviados[jid]) {
          const decisao = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "Você é um classificador. Responda apenas com SIM ou NÃO. Avalie se a resposta do assistente indica necessidade de enviar um contato humano (ex: reservas, problemas administrativos, dúvidas que não podem ser resolvidas pelo regimento)." },
              { role: "user", content: `Mensagem do usuário: ${pergunta}\nResposta do assistente: ${resposta}` }
            ],
            temperature: 0,
            max_tokens: 5
          });

          const precisaContato = decisao.choices[0].message.content.trim().toUpperCase().includes("SIM");

          if (precisaContato) {
            if (resposta.toLowerCase().includes("auditório")) {
              await enviarContato(sock, jid, "Reservas Auditório CIPT", "558287145526");
            } else if (resposta.toLowerCase().includes("sala de reunião")) {
              await enviarContato(sock, jid, "Recepção CIPT", "558288334368");
            }
            contatosEnviados[jid] = true;
          }
        }

        const sugestoes = gerarSugestoes();
        const mensagemFinal = `${saudacaoExtra}${resposta}\n\n${sugestoes}`;
        await sock.sendMessage(jid, { text: mensagemFinal });

        if (timersEncerramento[jid]) clearTimeout(timersEncerramento[jid]);
        timersEncerramento[jid] = setTimeout(async () => {
          const tempoPassado = Date.now() - usuariosAtivos[jid];
          if (tempoPassado >= TEMPO_ENCERRAMENTO) {
            await sock.sendMessage(jid, { text: "Encerrando seu atendimento por inatividade. Se precisar novamente, é só chamar! 😉" });
            delete usuariosAtivos[jid];
            delete timersEncerramento[jid];
            delete historicoUsuarios[jid];
            delete contatosEnviados[jid];
          }
        }, TEMPO_ENCERRAMENTO);

      } catch (err) {
        console.error('❌ Erro no processamento:', err.message);
        usuariosSemResposta[jid] = true;
      }
    }
  });

  setInterval(async () => {
    for (let jid in usuariosSemResposta) {
      if (usuariosSemResposta[jid]) {
        await sock.sendMessage(jid, {
          text: "Não consegui processar sua última mensagem. Pode me mandar de novo?"
        });
        usuariosSemResposta[jid] = false;
      }
    }
  }, TEMPO_CHECAGEM);
}

startBot();

const { exec } = require("child_process");
exec("node testeSheets.js", (error, stdout, stderr) => {
  if (error) {
    console.error(`❌ Erro no teste Google Sheets: ${error.message}`);
    return;
  }
  if (stderr) {
    console.error(`⚠️ Aviso no teste Google Sheets: ${stderr}`);
    return;
  }
  console.log(`✅ Resultado do teste Google Sheets:\n${stdout}`);
});

app.listen(3000, () => {
  console.log('🌐 Servidor rodando na porta 3000');
  setInterval(() => {
    fetch("https://cipt-whatsapp-bot.onrender.com/")
      .then(() => console.log("🔄 Mantendo serviço ativo..."))
      .catch(err => console.error("⚠️ Erro no keep-alive:", err.message));
  }, 4 * 60 * 1000);
});

app.get('/', (req, res) => {
  res.send('✅ Bot do CIPT está online!');
});