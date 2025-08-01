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
const fetch = require("node-fetch");
const nodemailer = require("nodemailer");

dotenv.config();

const app = express();
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let artigosCache = [];
let embeddingsCache = [];

// Controle de sessões
const usuariosAtivos = {};
const usuariosSemResposta = {};
const timersEncerramento = {};
const TEMPO_INATIVIDADE = 30 * 60 * 1000;
const TEMPO_ENCERRAMENTO = 5 * 60 * 1000;
const TEMPO_CHECAGEM = 30 * 1000;

// Função para ler regimento e fontes em artigos
async function carregarArtigos() {
  try {
    if (fs.existsSync("./artigos.json")) {
      artigosCache = JSON.parse(fs.readFileSync("./artigos.json", "utf8"));
      console.log("📚 Artigos carregados do cache.");
      return;
    }

    console.log("📄 Processando regimento e fontes em artigos...");
    const dataBuffer = fs.readFileSync("./regimento.pdf");
    const pdfData = await pdfParse(dataBuffer);
    const fontesExtras = fs.readFileSync("./fontes.txt", "utf8");

    // Separação por "Art." ou "Capítulo"
    const regex = /(Art\. ?\d+|CAPÍTULO [IVXLC]+)/gi;
    const blocos = pdfData.text.split(regex).filter((b) => b.trim().length > 0);

    artigosCache = blocos.map((bloco, idx) => ({
      id: idx,
      titulo: `Trecho ${idx + 1}`,
      conteudo: bloco.trim(),
    }));

    // Adiciona fontes extras como último artigo
    artigosCache.push({ id: "fontes", titulo: "Fontes adicionais", conteudo: fontesExtras });

    fs.writeFileSync("./artigos.json", JSON.stringify(artigosCache, null, 2));
    console.log("✅ Artigos salvos em cache.");
  } catch (err) {
    console.error("❌ Erro ao carregar artigos:", err.message);
  }
}

// Função para gerar ou carregar embeddings
async function gerarOuCarregarEmbeddings() {
  try {
    if (fs.existsSync("./embeddings.json")) {
      embeddingsCache = JSON.parse(fs.readFileSync("./embeddings.json", "utf8"));
      console.log("📦 Embeddings carregados do cache.");
      return;
    }

    console.log("⚙️ Gerando embeddings...");
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 500, chunkOverlap: 50 });
    const textos = artigosCache.map((a) => a.conteudo);
    const pdfDividido = await splitter.splitDocuments(textos);

    for (let chunk of pdfDividido) {
      const embedding = await client.embeddings.create({
        model: "text-embedding-3-small",
        input: chunk.pageContent || chunk,
      });
      embeddingsCache.push({
        trecho: chunk.pageContent || chunk,
        vector: embedding.data[0].embedding,
      });
    }

    fs.writeFileSync("./embeddings.json", JSON.stringify(embeddingsCache, null, 2));
    console.log("✅ Embeddings salvos em cache.");
  } catch (err) {
    console.error("❌ Erro ao gerar embeddings:", err.message);
  }
}

// Busca híbrida: primeiro artigos, depois embeddings
async function buscarInformacoes(pergunta) {
  // Busca em artigos por palavras-chave
  const relevantes = artigosCache.filter((a) =>
    pergunta.toLowerCase().split(" ").some((palavra) => a.conteudo.toLowerCase().includes(palavra))
  );

  if (relevantes.length > 0) {
    return relevantes.slice(0, 2).map((r) => r.conteudo).join("\n\n");
  }

  // Se nada achar, busca em embeddings
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

// Enviar vCard com fallback
async function enviarContato(sock, jid, nome, telefone) {
  try {
    const sentMsg = await sock.sendMessage(jid, {
      contacts: {
        displayName: nome,
        contacts: [
          {
            displayName: nome,
            vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${nome}\nTEL;type=CELL;type=VOICE;waid=${telefone}:${telefone}\nEND:VCARD`,
          },
        ],
      },
    });

    setTimeout(async () => {
      const msgStatus = sentMsg.status;
      if (msgStatus !== 2) {
        console.log(`⚠️ vCard não entregue, enviando fallback em texto para ${jid}`);
        await sock.sendMessage(jid, { text: `📞 Contato de ${nome}: +${telefone}` });
      }
    }, 3000);
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
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
    });
    await transporter.sendMail({
      from: `"Bot CIPT" <${process.env.GMAIL_USER}>`,
      to: "supcti.secti@gmail.com",
      subject: assunto,
      text: mensagem,
    });
  } catch (error) {
    console.error("Erro ao enviar email:", error.message);
  }
}

async function startBot() {
  await carregarArtigos();
  await gerarOuCarregarEmbeddings();

  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const sock = makeWASocket({ auth: state });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      console.log(`📲 Escaneie o QR: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
    }
    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 409;
      console.log("❌ Conexão caiu. Reiniciando:", shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.key.fromMe && msg.message?.conversation) {
      const pergunta = msg.message.conversation.toLowerCase();
      const nomeContato = msg.pushName || "visitante";
      const jid = msg.key.remoteJid;
      const agora = Date.now();

      try {
        const contexto = await buscarInformacoes(pergunta);

        const completion = await client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Você é o assistente virtual do CIPT. Responda formal e simpático usando apenas Regimento Interno (em PDF) e fontes oficiais (fontes.txt).
Se não encontrar, diga:
"Não encontrei informações específicas sobre isso em nosso regimento interno e nem nas bases que eu uso para te responder. Você pode entrar em contato com a gestão do CIPT pelo e-mail supcti@secti.al.gov.br ou na recepção."`,
            },
            { role: "user", content: `${pergunta}\n\nContexto relevante:\n${contexto}` },
          ],
          temperature: 0.3,
          max_tokens: 600,
        });

        const resposta = completion.choices[0].message.content.trim();
        let saudacao = "";
        if (!usuariosAtivos[jid] || agora - usuariosAtivos[jid] > TEMPO_INATIVIDADE) {
          saudacao = `${gerarSaudacao(nomeContato)}\nAqui é o assistente virtual do Centro de Inovação do Jaraguá — pode me chamar de *IA do CIPT*.\n\n`;
        }

        usuariosAtivos[jid] = agora;
        usuariosSemResposta[jid] = false;

        await sock.sendMessage(jid, { text: `${saudacao}${resposta}` });

        if (pergunta.includes("auditório")) {
          await enviarContato(sock, jid, "Reservas Auditório CIPT", "558287145526");
        }
        if (pergunta.includes("sala de reunião")) {
          await enviarContato(sock, jid, "Recepção CIPT", "558288334368");
        }

        if (timersEncerramento[jid]) clearTimeout(timersEncerramento[jid]);
        timersEncerramento[jid] = setTimeout(async () => {
          const tempoPassado = Date.now() - usuariosAtivos[jid];
          if (tempoPassado >= TEMPO_ENCERRAMENTO) {
            await sock.sendMessage(jid, {
              text: "Já que você não interagiu nos últimos minutos, estou encerrando seu atendimento. Se precisar de algo, conte comigo! 😉",
            });
            delete usuariosAtivos[jid];
            delete timersEncerramento[jid];
          }
        }, TEMPO_ENCERRAMENTO);
      } catch (err) {
        console.error("❌ Erro no processamento:", err.message);
        usuariosSemResposta[jid] = true;
      }
    }
  });

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