// Corrige erro do Baileys no Render
global.crypto = require("crypto");

const express = require('express');
const qrcode = require('qrcode-terminal');
const dotenv = require('dotenv');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const OpenAI = require('openai');

dotenv.config();

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

let pdfChunks = [];
let embeddingsCache = [];

// Controle de sessões
const usuariosAtivos = {};
const timersEncerramento = {};
const TEMPO_INATIVIDADE = 30 * 60 * 1000; // 30 minutos para boas-vindas
const TEMPO_ENCERRAMENTO = 5 * 60 * 1000; // 5 minutos para encerrar sessão

// Função para gerar ou carregar embeddings do PDF
async function gerarOuCarregarEmbeddings() {
  if (fs.existsSync('./embeddings.json')) {
    console.log('📦 Carregando embeddings do cache...');
    embeddingsCache = JSON.parse(fs.readFileSync('./embeddings.json', 'utf8'));
    return;
  }

  console.log('🔄 Gerando embeddings do PDF...');
  const dataBuffer = fs.readFileSync('./regimento.pdf');
  const pdfData = await pdfParse(dataBuffer);

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50
  });
  pdfChunks = await splitter.splitText(pdfData.text);

  for (let chunk of pdfChunks) {
    const embedding = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: chunk
    });
    embeddingsCache.push({
      trecho: chunk,
      vector: embedding.data[0].embedding
    });
  }

  fs.writeFileSync('./embeddings.json', JSON.stringify(embeddingsCache, null, 2));
  console.log(`✅ Embeddings gerados e salvos (${embeddingsCache.length} trechos)`);
}

// Função para buscar trechos relevantes
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
  return resultados.slice(0, 3).map(r => r.trecho).join("\n\n");
}

// Saudações simpáticas
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
      console.log('⚡ Escaneie este QR Code abaixo para conectar o WhatsApp:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp!');
    }
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

        const completion = await client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Você é o assistente virtual do Centro de Inovação do Polo Tecnológico do Jaraguá (CIPT).
Responda APENAS com base nos trechos abaixo do Regimento Interno.
Use SEMPRE o tempo verbal PRESENTE.
Seja simpático e acolhedor. 
Se não houver resposta clara, diga:
"Desculpe, não encontrei informações no regimento. Contate cipt@secti.al.gov.br ou (82) 3333-4444."

Trechos:
${trechos}`
            },
            { role: "user", content: pergunta }
          ],
          temperature: 0.2,
          max_tokens: 400
        });

        const resposta = completion.choices[0].message.content.trim();

        // Decide se envia saudação
        let saudacao = "";
        if (!usuariosAtivos[jid] || (agora - usuariosAtivos[jid]) > TEMPO_INATIVIDADE) {
          saudacao = `${gerarSaudacao(nomeContato)}\nAqui é o assistente virtual do Centro de Inovação do Jaraguá — pode me chamar de *IA do CIPT*.\n\n`;
        }
        usuariosAtivos[jid] = agora;

        const mensagemFinal = `${saudacao}${resposta}`;

        await sock.sendMessage(jid, { text: mensagemFinal });
        console.log('🤖 Resposta enviada:', mensagemFinal);

        // Timer de encerramento
        if (timersEncerramento[jid]) clearTimeout(timersEncerramento[jid]);
        timersEncerramento[jid] = setTimeout(async () => {
          const tempoPassado = Date.now() - usuariosAtivos[jid];
          if (tempoPassado >= TEMPO_ENCERRAMENTO) {
            const mensagemEncerramento = `Já que você não interagiu nos últimos minutos, estou encerrando seu atendimento. Se precisar de mais algo, conte comigo! 😉`;
            await sock.sendMessage(jid, { text: mensagemEncerramento });
            console.log('⌛ Sessão encerrada automaticamente para:', nomeContato);
            delete usuariosAtivos[jid];
            delete timersEncerramento[jid];
          }
        }, TEMPO_ENCERRAMENTO);

      } catch (err) {
        console.error('❌ Erro na API OpenAI:', err.response?.data || err.message);
        await sock.sendMessage(msg.key.remoteJid, {
          text: 'Houve um problema ao processar sua mensagem. Tente mais tarde.'
        });
      }
    }
  });
}

startBot();
app.listen(3000, () => console.log('🌐 Servidor rodando na porta 3000'));