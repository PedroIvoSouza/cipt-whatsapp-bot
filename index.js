const express = require('express');
const axios = require('axios');
const venom = require('venom-bot');

const app = express();
app.use(express.json());

let clientInstance;

venom.create({
  session: 'cipt-session',
  multidevice: true, // compatível com versões mais novas do WhatsApp
})
.then((client) => {
  clientInstance = client;
  console.log('✅ Venom conectado ao WhatsApp');

  client.onMessage(async (message) => {
    if (!message.isGroupMsg) {
      try {
        console.log('📩 Mensagem recebida:', message.body);

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

        const resposta =
          bpRes.data?.payload?.text ||
          'Desculpe, não encontrei informações no regimento. Contate cipt@secti.al.gov.br ou (82) 3333-4444.';

        console.log('🤖 Resposta do Botpress:', resposta);
        await client.sendText(message.from, resposta);
      } catch (err) {
        console.error('❌ Erro ao responder:', err.message);
        await client.sendText(message.from,
          'Houve um problema ao processar sua mensagem. Tente mais tarde.');
      }
    }
  });
})
.catch((error) => console.error('❌ Erro ao iniciar cliente:', error));

app.get('/', (req, res) =>
  res.send('🚀 Chatbot CIPT rodando com Venom-Bot')
);

app.listen(3000, () => console.log('🌐 Servidor rodando na porta 3000'));
