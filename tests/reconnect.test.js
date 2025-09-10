const assert = require('assert');
const path = require('path');
const Module = require('module');

(async () => {
  const sockets = [];
  function createSock() {
    const sock = {
      ws: { readyState: 1, on(){} },
      handlers: {},
      ev: {
        on(event, handler) {
          sock.handlers[event] = handler;
        }
      }
    };
    sockets.push(sock);
    return sock;
  }

  const axiosMock = { interceptors: { request: { use(){} } }, create: () => axiosMock };
  const expressMock = () => ({ post(){}, get(){}, use(){}, listen(){}, routes:{} });
  expressMock.json = () => (req,res,next)=>next();

  global.setTimeout = (fn) => { fn(); return 0; };
  global.setInterval = (fn) => { fn(); return { ref(){}, unref(){} }; };

  const indexPath = path.resolve(__dirname, '..', 'index.js');
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (moduleName) {
    if (moduleName === 'axios') return axiosMock;
    if (moduleName === 'express') return expressMock;
    if (moduleName === 'dotenv') return { config(){} };
    if (moduleName === 'pdf-parse') return async () => ({ text: '' });
    if (moduleName === 'langchain/text_splitter') return { RecursiveCharacterTextSplitter: class { async splitText() { return ['']; } } };
    if (moduleName === '@whiskeysockets/baileys') return {
      makeWASocket: createSock,
      useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
      DisconnectReason: {}
    };
    if (moduleName === 'openai') return class { constructor(){ this.embeddings = { create: async () => ({ data: [{ embedding: [0] }] }) }; } };
    if (moduleName === 'node-cron') return { schedule(){} };
    if (moduleName === 'sqlite3') return { verbose: () => ({ Database: function(){} }) };
    if (moduleName === './ciptPrompt.js') return { getCiptPrompt: async () => '' };
    if (moduleName === './sheetsChamados') return {
      registrarChamado: async () => {},
      atualizarStatusChamado: async () => {},
      verificarChamadosAbertos: async () => []
    };
    return originalRequire.apply(this, arguments);
  };

  process.env.WHATSAPP_BOT_TOKEN = 'secret';

  delete require.cache[indexPath];
  const bot = require(indexPath);
  Module.prototype.require = originalRequire;
  await bot.startBot();

  sockets[0].handlers['connection.update']({ connection: 'open' });
  assert.strictEqual(bot.getIsConnected(), true, 'bot should connect initially');

  sockets[0].handlers['connection.update']({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 0 } } } });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(sockets.length >= 2, true, 'reconnect should create new socket');

  sockets[1].handlers['connection.update']({ connection: 'open' });
  assert.strictEqual(bot.getIsConnected(), true, 'bot should reconnect successfully');

  console.log('Reconnect test passed');
})();
