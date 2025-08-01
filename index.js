// Corrige erro do Baileys no Node 20+
const crypto = require("node:crypto");
global.crypto = crypto;

const express = require("express");
const dotenv = require("dotenv");
const fs = require("fs");
const pdfParse = require("pdf-parse");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const OpenAI = require("openai");
const nodemailer = require("nodemailer");
const fetch = require("node-fetch");

dotenv.config();

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Configuração do e-mail para notificações
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "supcti.secti@gmail.com",
    pass: process.env.GMAIL_APP_PASSWORD, // senha de app
  },
});

let pdfChunks = [];
let embeddingsCache = [];

// Controle de sessões
const usuariosAtivos = {};
const timersEncerramento = {};
const usuariosSemResposta = {};
const TEMPO_INATIVIDADE = 30 * 60 * 1000; // 30 min
const TEMPO_ENCERRAMENTO = 5 * 60 * 1000; // 5 min
const TEMPO_CHECAGEM = 30 * 1000; // checar a cada 30s

// Função para gerar ou carregar embeddings
async function gerarOuCarregarEmbeddings() {
  if (fs.existsSync("./embeddings.json")) {
    console.log("📦 Carregando embeddings do cache...");
    embeddingsCache = JSON.parse(fs.readFileSync("./embeddings.json", "utf8"));
    return;
  }

  console.log("🔄 Gerando embeddings do PDF e fontes externas...");

  const dataBuffer = fs.readFileSync("./regimento.pdf");
  const pdfData = await pdfParse(dataBuffer);
  const fontesExtras = fs.readFileSync("./fontes.txt", "utf8");

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
  });

  const pdfDividido = await splitter.splitText(pdfData.text);
  const fontesDivididas = await splitter.splitText(fontesExtras);

  pdfChunks = [...pdfDividido, ...fontesDivididas];

  for (let chunk of pdfChunks) {
    const embedding = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: chunk,
    });
    embeddingsCache.push({
      trecho: chunk,
      vector: embedding.data[0].embedding,
    });
  }

  fs.writeFileSync("./embeddings.json", JSON.stringify(embeddingsCache, null, 2));
  console.log(`✅ Embeddings gerados (${embeddingsCache.length} trechos)`);
}

// Buscar trechos relevantes
async function buscarTrechosRelevantes(pergunta) {
  const perguntaEmbedding = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: pergunta,
  });
  const perguntaVector = perguntaEmbedding.data[0].embedding;

  const resultados = embeddingsCache.map((e) => {
    const dot = perguntaVector.reduce((acc, val, idx) => acc + val * e.vector[idx], 0);
    const magA = Math.sqrt(perguntaVector.reduce((acc, val) => acc + val * val, 0));
    const magB = Math.sqrt(e.vector.reduce((acc, val) => acc + val * val, 0));
    const score = dot / (magA * magB);
    return { trecho: e.trecho, score };
  });

  resultados.sort((a, b) => b.score - a.score);
  return resultados.slice(0, 3).map((r) => r.trecho).join("\n\n");
}

// Função auxiliar para enviar cartão de contato (vCard)
async function enviarContato(sock, jid, nome, numero) {
  const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${nome}
TEL;type=CELL;type=VOICE;waid=${numero.replace(/\D/g, '')}:${numero}
END:VCARD`;

  await sock.sendMessage(jid, {
    contacts: {
      displayName: nome,
      contacts: [{ vcard }],
    },
  });
  console.log(`📇 Cartão enviado: ${nome} (${numero})`);
}

// Saudações simpáticas
function gerarSaudacao(nome) {
  const opcoes = [
    `Olá, ${nome}! 👋`,
    `Oi, ${nome}! Tudo bem? 🙂`,
    `Seja bem-vindo(a), ${nome}! 🌟`,
    `Oi oi, ${nome}! Como posso te ajudar hoje? 🤗`,
    `Prazer falar com você, ${nome}! 🙌`,
  ];
  return opcoes[Math.floor(Math.random() * opcoes.length)];
}

async function startBot() {
  await gerarOuCarregarEmbeddings();

  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const sock = makeWASocket({ auth: state });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
      console.log("⚡ Escaneie o QR Code para conectar:");
      console.log(`➡️ ${qrLink}`);
    }
    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
    }
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("❌ Conexão caiu. Reiniciando:", shouldReconnect);

      // Notificação por e-mail
      transporter.sendMail({
        from: "supcti.secti@gmail.com",
        to: "supcti.secti@gmail.com",
        subject: "⚠️ Bot CIPT desconectado",
        text: "O bot do CIPT caiu e será reiniciado automaticamente.",
      });

      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.key.fromMe && msg.message?.conversation) {
      const pergunta = msg.message.conversation;
      const nomeContato = msg.pushName || "visitante";
      const jid = msg.key.remoteJid;
      const agora = Date.now();

      console.log("📩 Mensagem recebida:", pergunta, "de", nomeContato);

      try {
        // Se a mensagem falar em auditório → enviar cartão
        if (/audit[oó]rio/i.test(pergunta)) {
          await enviarContato(sock, jid, "Auditório CIPT", "+55 82 8714-5526");
          return;
        }

        // Se falar em recepção ou permissionários → enviar cartão
        if (/recep[cç][aã]o|permission[aá]rio/i.test(pergunta)) {
          await enviarContato(sock, jid, "Recepção CIPT", "+55 82 8833-4368");
          return;
        }

        const trechos = await buscarTrechosRelevantes(pergunta);

        const completion = await client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Você é o assistente virtual do Centro de Inovação do Polo Tecnológico do Jaraguá (CIPT).
Responda APENAS com base nos trechos do regimento e nos documentos oficiais.
Explique de forma formal, clara e simpática, sempre contextualizando o funcionamento do prédio e seus objetivos.

Se não encontrar no regimento ou documentos oficiais, responda:
"Não encontrei informações específicas sobre isso em nosso regimento interno e nem nas bases que eu uso para te responder. Você pode entrar em contato com a gestão do CIPT pelo e-mail supcti@secti.al.gov.br ou na recepção, tenho certeza de que lá você conseguirá tirar todas as suas dúvidas.".

Trechos disponíveis:
${trechos}`,
            },
            { role: "user", content: pergunta },
          ],
          temperature: 0.3,
          max_tokens: 500,
        });

        const resposta = completion.choices[0].message.content.trim();

        // Decide se envia saudação
        let saudacao = "";
        if (!usuariosAtivos[jid] || agora - usuariosAtivos[jid] > TEMPO_INATIVIDADE) {
          saudacao = `${gerarSaudacao(nomeContato)}\nAqui é o assistente virtual do Centro de Inovação do Jaraguá — pode me chamar de *IA do CIPT*.\n\n`;
        }
        usuariosAtivos[jid] = agora;

        const mensagemFinal = `${saudacao}${resposta}`;
        await sock.sendMessage(jid, { text: mensagemFinal });
        console.log("🤖 Resposta enviada:", mensagemFinal);

        usuariosSemResposta[jid] = false;

        // Timer de encerramento
        if (timersEncerramento[jid]) clearTimeout(timersEncerramento[jid]);
        timersEncerramento[jid] = setTimeout(async () => {
          const tempoPassado = Date.now() - usuariosAtivos[jid];
          if (tempoPassado >= TEMPO_ENCERRAMENTO) {
            const mensagemEncerramento =
              "Já que você não interagiu nos últimos minutos, estou encerrando seu atendimento. Se precisar de mais algo, conte comigo! 😉";
            await sock.sendMessage(jid, { text: mensagemEncerramento });
            console.log("⌛ Sessão encerrada automaticamente:", nomeContato);
            delete usuariosAtivos[jid];
            delete timersEncerramento[jid];
          }
        }, TEMPO_ENCERRAMENTO);
      } catch (err) {
        console.error("❌ Erro:", err.response?.data || err.message);
        usuariosSemResposta[msg.key.remoteJid] = true;
      }
    }
  });

  // Checagem periódica de usuários sem resposta
  setInterval(async () => {
    for (let jid in usuariosSemResposta) {
      if (usuariosSemResposta[jid]) {
        await sock.sendMessage(jid, {
          text: "Não consegui processar sua última mensagem. Me manda sua mensagem novamente que vai ser um prazer te ajudar.",
        });
        usuariosSemResposta[jid] = false;
      }
    }
  }, TEMPO_CHECAGEM);
}

startBot();

app.listen(3000, () => {
  console.log("🌐 Servidor rodando na porta 3000");
  setInterval(() => {
    fetch("https://cipt-whatsapp-bot.onrender.com/")
      .then(() => console.log("🔄 Mantendo serviço ativo..."))
      .catch((err) => console.error("⚠️ Erro no keep-alive:", err.message));
  }, 4 * 60 * 1000);
});

app.get("/", (req, res) => {
  res.send("✅ Bot do CIPT está online!");
});