const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const dotenv = require('dotenv');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

dotenv.config();

const app = express();
app.use(express.json());

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true // QR em ASCII
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      console.log('⚡ Escaneie este QR Code abaixo:');
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
          'Desculpe, não encontrei informações no regimento. Contate supcti@secti.al.gov.br.';

        await sock.sendMessage(msg.key.remoteJid, { text: resposta });
        console.log('🤖 Resposta enviada:', resposta);
      } catch (err) {
        console.error('❌ Erro ao responder:', err.message);
        await sock.sendMessage(msg.key.remoteJid, {
          text: 'Houve um problema ao processar sua mensagem. Tente mais tarde.'
        });
      }
    }
  });
}

startBot();

app.get('/', (req, res) =>
  res.send('🚀 Chatbot CIPT te atendendo 24/7')
);

app.listen(3000, () => console.log('🌐 Servidor rodando na porta 3000'));
