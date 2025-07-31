const express = require('express');
const axios = require('axios');
const wppconnect = require('@wppconnect-team/wppconnect');

const app = express();
app.use(express.json());

let clientInstance;

wppconnect.create({
  session: 'cipt-session',
  headless: true,
  useChrome: false,
  browserArgs: ['--no-sandbox', '--disable-setuid-sandbox'],
  puppeteerOptions: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
  tokenStore: 'file', // Salva tokens em arquivos
})
  .then((client) => {
    clientInstance = client;
    console.log('✅ WPPConnect conectado (modo headless)');

    client.onMessage(async (message) => {
      if (!message.isGroupMsg) {
        try {
          console.log('📩 Mensagem recebida:', message.body);

          // Envia a mensagem para o Botpress
          const bpRes = await axios.post(
            'https://api.botpress.cloud/v1/messages',
            {
              conversationId: message.from,
              payload: { type: 'text', text: message.body }
            },
            {
              headers: {
                'Authorization': `Bearer ${process.env.BOTPRESS_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );

          // Extrai a resposta do Botpress
          const resposta =
            bpRes.data?.payload?.text ||
            'Desculpe, não encontrei informações no regimento. Entre em contato pelo e-mail cipt@secti.al.gov.br ou pelo telefone (82) 3333-4444.';

          console.log('🤖 Resposta do Botpress:', resposta);

          // Envia resposta ao usuário no WhatsApp
          await client.sendText(message.from, resposta);
        } catch (err) {
          console.error('❌ Erro ao responder:', err.message);
          await clientInstance.sendText(message.from,
            'Houve um problema para processar sua mensagem. Tente novamente mais tarde.');
        }
      }
    });
  })
  .catch((error) => console.error('❌ Erro ao iniciar cliente:', error));

app.get('/', (req, res) =>
  res.send('🚀 Chatbot CIPT rodando no Render (WPPConnect headless)')
);

app.listen(3000, () => console.log('🌐 Servidor rodando na porta 3000'));
