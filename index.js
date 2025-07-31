const express = require('express');
const axios = require('axios');
const wppconnect = require('@wppconnect-team/wppconnect');

const app = express();
app.use(express.json());

let clientInstance;

// Inicializa o cliente do WPPConnect
wppconnect.create({
  session: 'cipt-session', // nome da sessão
  puppeteerOptions: { args: ['--no-sandbox'] } // importante para Render
})
  .then((client) => {
    clientInstance = client;

    console.log("✅ WPPConnect conectado e rodando...");

    // Escuta mensagens recebidas
    client.onMessage(async (message) => {
      if (!message.isGroupMsg) {
        try {
          console.log("📩 Mensagem recebida:", message.body);

          // Enviar mensagem para o Botpress
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

          // Extrai resposta do Botpress
          const resposta = bpRes.data.payload?.text || "Desculpe, não consegui entender sua solicitação.";
          console.log("🤖 Resposta do Botpress:", resposta);

          // Envia de volta no WhatsApp
          await client.sendText(message.from, resposta);

        } catch (err) {
          console.error('❌ Erro ao responder:', err.message);
          await clientInstance.sendText(message.from, "Ocorreu um erro ao processar sua mensagem. Tente novamente mais tarde.");
        }
      }
    });
  })
  .catch((error) => console.error('❌ Erro ao iniciar cliente:', error));

app.get('/', (req, res) => res.send('Servidor do Bot CIPT está rodando 🚀'));
app.listen(3000, () => console.log('🌐 Servidor rodando na porta 3000'));
