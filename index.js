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

dotenv.config();

const app = express();
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let pdfChunks = [];
let embeddingsCache = [];

const usuariosAtivos = {};
const timersEncerramento = {};
const semResposta = {};
const TEMPO_INATIVIDADE = 30 * 60 * 1000;
const TEMPO_ENCERRAMENTO = 5 * 60 * 1000;
const TEMPO_VERIFICACAO = 30 * 1000;

// Função para gerar ou carregar embeddings
async function gerarOuCarregarEmbeddings() {
  if (fs.existsSync('./embeddings.json')) {
    console.log('📦 Carregando embeddings do cache...');
    embeddingsCache = JSON.parse(fs.readFileSync('./embeddings.json', 'utf8'));
    return;
  }

  console.log('🔄 Gerando embeddings do PDF e fontes extras...');
  const dataBuffer = fs.readFileSync('./regimento.pdf');
  const pdfData = await pdfParse(dataBuffer);

  const fontesExtras = fs.readFileSync('./fontes.txt', 'utf8');
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 800, chunkOverlap: 100 });
  const pdfDividido = await splitter.splitText(pdfData.text);
  const fontesDivididas = await splitter.splitText(fontesExtras);

  pdfChunks = [...pdfDividido, ...fontesDivididas];

  for (let chunk of pdfChunks) {
    const embedding = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: chunk
    });
    embeddingsCache.push({ trecho: chunk, vector: embedding.data[0].embedding });
  }

  fs.writeFileSync('./embeddings.json', JSON.stringify(embeddingsCache, null, 2));
  console.log(`✅ Embeddings combinados gerados (${embeddingsCache.length} trechos)`);
}

// Função de busca de trechos
async function buscarTrechosRelevantes(pergunta) {
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
  return resultados.slice(0, 4).map(r => r.trecho).join("\n\n");
}

// Saudação simpática
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

async function startBot() {
  await gerarOuCarregarEmbeddings();

  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({ auth: state });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      console.log('⚡ Escaneie o QR Code:');
      console.log(`➡️ https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
    }
    if (connection === 'open') console.log('✅ Conectado ao WhatsApp!');
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ Conexão caiu. Reiniciando:', shouldReconnect);
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.key.fromMe && msg.message?.conversation) {
      const pergunta = msg.message.conversation;
      const nomeContato = msg.pushName || "visitante";
      const jid = msg.key.remoteJid;
      const agora = Date.now();

      console.log('📩 Mensagem recebida:', pergunta, "de", nomeContato);

      try {
        const trechos = await buscarTrechosRelevantes(pergunta);

        let extraInstrucoes = "";
        if (/auditório|auditorio/i.test(pergunta)) {
          extraInstrucoes = "\n\nSe desejar, posso te colocar em contato direto com o responsável pelo auditório.";
        }
        if (/sala|reunião|permissionário|permissionaria/i.test(pergunta)) {
          extraInstrucoes = "\n\nCaso seja necessário, você também pode falar diretamente com a recepção do CIPT para agendar salas de reunião.";
        }

        const completion = await client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Você é o assistente virtual do Centro de Inovação do Polo Tecnológico do Jaraguá (CIPT).
Responda de forma formal, simpática e explicativa.
Use sempre o tempo presente. Explique as normas e, quando adequado, complemente com o contexto, missão e benefícios do CIPT para Alagoas.

Se a resposta não estiver nos documentos, diga:
"Não encontrei informações específicas sobre isso em nosso regimento interno ou nas bases de informações que eu utilizo. Você pode entrar em contato pelo e-mail supcti@secti.al.gov.br ou presencialmente na recepção do CIPT, lá a nossa equipe, certamente, irá conduzir o seu atendimento da melhor forma possível."

Trechos disponíveis:
${trechos}

Instruções extras:
${extraInstrucoes}`
            },
            { role: "user", content: pergunta }
          ],
          temperature: 0.4,
          max_tokens: 600
        });

        const resposta = completion.choices[0].message.content.trim();

        let saudacao = "";
        if (!usuariosAtivos[jid] || (agora - usuariosAtivos[jid]) > TEMPO_INATIVIDADE) {
          saudacao = `${gerarSaudacao(nomeContato)}\nAqui é o assistente virtual do Centro de Inovação do Jaraguá — pode me chamar de *IA do CIPT*.\n\n`;
        }
        usuariosAtivos[jid] = agora;
        semResposta[jid] = false;

        const mensagemFinal = `${saudacao}${resposta}`;
        await sock.sendMessage(jid, { text: mensagemFinal });

        // Se for auditório, mandar contato
        if (/auditório|auditorio/i.test(pergunta)) {
          await sock.sendMessage(jid, {
            contacts: {
              displayName: "Reservas do Auditório",
              contacts: [
                {
                  name: { formattedName: "Reservas Auditório CIPT" },
                  phones: [{ phone: "+558287145526", type: "Celular" }]
                }
              ]
            }
          });
        }

        // Se for salas/permissionários/térreo
        if (/sala|reunião|permissionário|permissionaria/i.test(pergunta)) {
          await sock.sendMessage(jid, {
            contacts: {
              displayName: "Recepção CIPT",
              contacts: [
                {
                  name: { formattedName: "Recepção CIPT" },
                  phones: [{ phone: "+558288334368", type: "Celular" }]
                }
              ]
            }
          });
        }

        console.log('🤖 Resposta enviada:', mensagemFinal);

        if (timersEncerramento[jid]) clearTimeout(timersEncerramento[jid]);
        timersEncerramento[jid] = setTimeout(async () => {
          const tempoPassado = Date.now() - usuariosAtivos[jid];
          if (tempoPassado >= TEMPO_ENCERRAMENTO) {
            const mensagemEncerramento = `Já que você não interagiu nos últimos minutos, estou encerrando seu atendimento. Se precisar de mais algo, conte comigo! 😉`;
            await sock.sendMessage(jid, { text: mensagemEncerramento });
            delete usuariosAtivos[jid];
            delete timersEncerramento[jid];
            delete semResposta[jid];
          }
        }, TEMPO_ENCERRAMENTO);

      } catch (err) {
        console.error('❌ Erro na API OpenAI:', err.response?.data || err.message);
        semResposta[msg.key.remoteJid] = true;
        await sock.sendMessage(msg.key.remoteJid, {
          text: 'Houve um problema ao processar sua mensagem. Tente mais tarde.'
        });
      }
    }
  });

  // Verificação periódica de usuários sem resposta
  setInterval(async () => {
    for (const jid in semResposta) {
      if (semResposta[jid]) {
        await sock.sendMessage(jid, {
          text: "Percebi que sua mensagem não teve retorno. Caso ainda precise de ajuda, pode me perguntar novamente que será um prazer te responder."
        });
        semResposta[jid] = false;
      }
    }
  }, TEMPO_VERIFICACAO);
}

startBot();

app.listen(3000, () => {
  console.log('🌐 Servidor rodando na porta 3000');
  setInterval(() => {
    fetch("https://cipt-whatsapp-bot.onrender.com/")
      .then(() => console.log("🔄 Mantendo serviço ativo..."))
      .catch(err => console.error("⚠️ Erro no keep-alive:", err.message));
  }, 4 * 60 * 1000);
});

app.get('/', (req, res) => res.send('✅ Bot do CIPT está online!'));
