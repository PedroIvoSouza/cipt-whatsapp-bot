const express = require('express');
const axios = require('axios');
const wppconnect = require('@wppconnect-team/wppconnect');

const app = express();
app.use(express.json());

let clientInstance;

wppconnect.create()
  .then((client) => {
    clientInstance = client;

    // Recebe mensagens do WhatsApp
    client.onMessage(async (message) => {
      if (message.isGroupMsg === false) {
        try {
          // Enviar para o Botpress
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

          // Enviar resposta para o WhatsApp
          const resposta = bpRes.data.payload.text;
          client.sendText(message.from, resposta);
        } catch (err) {
          console.error('Erro ao responder:', err.message);
        }
      }
    });
  })
  .catch((error) => console.log('Erro ao iniciar cliente:', error));

app.listen(3000, () => console.log('Servidor rodando na porta 3000'));
