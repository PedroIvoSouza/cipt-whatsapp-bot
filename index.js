const express = require('express');
const axios = require('axios');
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('⚡ Escaneie este QR Code:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.key.fromMe && msg.message?.conversation) {
      const text = msg.message.conversation;
      console.log('📩 Mensagem recebida:', text);

      try {
        const bpRes = await axios.post(
          'https://api.botpress.cloud/v1/messages',
          {
            conversationId: msg.key.remoteJid,
            payload: { type: 'text', text }
          },
          {
            headers: {
              'Authorization': `Bearer ${process.env.BOTPRESS_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const resposta =
          bpRes.data?.payload?.text ||
          'Desculpe, não encontrei informações no regimento. Contate cipt@secti.al.gov.br ou (82) 3333-4444.';

        await sock.sendMessage(msg.key.remoteJid, { text: resposta });
        console.log('🤖 Resposta enviada:', resposta);
      } catch (err) {
        console.error('❌ Erro ao responder:', err.message);
        await sock.sendMessage(msg.key.remoteJid, {
          text: 'Houve um problema ao processar sua mensagem. Tente novamente mais tarde.'
        });
      }
    }
  });
}

startBot();

app.get('/', (req, res) =>
  res.send('🚀 Chatbot CIPT rodando com Baileys (sem Puppeteer)')
);

app.listen(3000, () => console.log('🌐 Servidor rodando na porta 3000'));
