const assert = require('assert');
const path = require('path');
const Module = require('module');

(async () => {
  const sockets = [];
  let activeSockets = 0;
  function createSock() {
    const sock = {
      ws: {
        readyState: 1,
        on(){},
        close(){ sock.closed = true; activeSockets--; }
      },
      handlers: {},
      ev: {
        on(event, handler) {
          sock.handlers[event] = handler;
        },
        removeAllListeners(){ sock.handlers = {}; }
      }
    };
    sockets.push(sock);
    activeSockets++;
    return sock;
  }

  const axiosMock = { interceptors: { request: { use(){} } }, create: () => axiosMock };
  const expressMock = () => ({ post(){}, get(){}, use(){}, listen(){}, routes:{} });
  expressMock.json = () => (req,res,next)=>next();

  global.setTimeout = (fn) => { fn(); return 0; };
  global.setInterval = (fn) => { fn(); return { ref(){}, unref(){} }; };

  const DISCONNECT_REASON = { loggedOut: 401, connectionReplaced: 410 };
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
      DisconnectReason: DISCONNECT_REASON
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

  const fs = require('fs');
  const originalRm = fs.promises.rm;
  const originalMkdir = fs.promises.mkdir;
  const rmCalls = [];
  const mkdirCalls = [];
  fs.promises.rm = async (...args) => { rmCalls.push(args); };
  fs.promises.mkdir = async (...args) => { mkdirCalls.push(args); };

  await bot.startBot();

  sockets[0].handlers['connection.update']({ connection: 'open' });
  assert.strictEqual(bot.getIsConnected(), true, 'bot should connect initially');

  sockets[0].handlers['connection.update']({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 0 } } } });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(sockets.length >= 2, true, 'reconnect should create new socket');
  assert.strictEqual(sockets[0].closed, true, 'old socket should be closed');
  assert.strictEqual(activeSockets, 1, 'only one active socket after reconnect');

  sockets[1].handlers['connection.update']({ connection: 'open' });
  assert.strictEqual(bot.getIsConnected(), true, 'bot should reconnect successfully');

  const socketsBeforeLogout = sockets.length;
  sockets[1].handlers['connection.update']({ connection: 'close', lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON.loggedOut } } } });
  await new Promise(r => setImmediate(r));

  assert.strictEqual(rmCalls.length > 0, true, 'logout should trigger auth reset');
  assert.strictEqual(mkdirCalls.length > 0, true, 'logout should recreate auth folder');
  assert.strictEqual(sockets.length >= socketsBeforeLogout + 1, true, 'logout should trigger new socket creation');

  fs.promises.rm = originalRm;
  fs.promises.mkdir = originalMkdir;

  const latestSocket = sockets[sockets.length - 1];
  latestSocket.handlers['connection.update']({ connection: 'open' });
  assert.strictEqual(bot.getIsConnected(), true, 'bot should reconnect after logout reset');

  const prevSockets = sockets.length;
  latestSocket.handlers['connection.update']({ connection: 'close', lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON.connectionReplaced } } } });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(sockets.length, prevSockets, 'no reconnect should occur after connectionReplaced');

  console.log('Reconnect test passed');
})();
