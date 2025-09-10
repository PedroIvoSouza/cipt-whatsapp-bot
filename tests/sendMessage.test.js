const assert = require('assert');
const path = require('path');
const Module = require('module');

async function loadSendMessage() {
  const calls = [];
  const sockMock = {
    calls,
    ws: { readyState: 1, on(){} },
    user: {},
    ev: { on(event, handler){ if(event === 'connection.update') sockMock._connectionHandler = handler; } },
    sendMessage: async (...args) => {
      calls.push(args);
      return { key: { id: 'mock-id' } };
    },
    onWhatsApp: async () => [{ exists: true, jid: '5511999999999@s.whatsapp.net' }],
    presenceSubscribe: async () => {},
    sendPresenceUpdate: async () => {}
  };

  const axiosMock = {
    interceptors: { request: { use(){} } },
    create: () => axiosMock
  };

  const expressMock = () => {
    const routes = {};
    const app = {
      routes,
      post: (p, h) => { routes[p] = h; },
      get() {},
      use() {},
      listen() {}
    };
    expressMock.routes = routes;
    return app;
  };
  expressMock.json = () => (req, res, next) => next();

  const indexPath = path.resolve(__dirname, '..', 'index.js');
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (moduleName) {
    if (moduleName === 'axios') return axiosMock;
    if (moduleName === 'express') return expressMock;
    if (moduleName === 'dotenv') return { config(){} };
    if (moduleName === 'pdf-parse') return async () => ({ text: '' });
    if (moduleName === 'langchain/text_splitter') return { RecursiveCharacterTextSplitter: class { async splitText() { return ['']; } } };
    if (moduleName === '@whiskeysockets/baileys') return {
      makeWASocket: () => sockMock,
      useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
      DisconnectReason: {}
    };
    if (moduleName === 'openai') return class {
      constructor() { this.embeddings = { create: async () => ({ data: [{ embedding: [0] }] }) }; }
    };
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

  global.setTimeout = (fn) => { fn(); return 0; };
  global.setInterval = (fn) => { fn(); return { ref(){}, unref(){} }; };
  delete require.cache[indexPath];
  Module._load(indexPath, null, true);
  Module.prototype.require = originalRequire;
  delete require.cache[indexPath];
  await new Promise(res => setImmediate(res));

  const routes = expressMock.routes;
  const handler = routes['/send-message'] || routes['/sendMessage'] || routes['/send'];
  return { handler, sockMock };
}

(async () => {
  const { handler, sockMock } = await loadSendMessage();
  assert(handler, 'sendMessage endpoint not registered');

  const invoke = async (headers = {}, body = {}) => {
    let statusCode = 200;
    let jsonBody;
    const res = {
      status(code) { statusCode = code; return this; },
      json(obj) { jsonBody = obj; }
    };
    await handler({ headers, body }, res);
    return { statusCode, jsonBody };
  };

  // Auth required
  let res = await invoke({}, { msisdn: '123', text: 'oi' });
  assert.strictEqual(res.statusCode, 401, 'requires auth header');

  // Simulate connection opened
  sockMock._connectionHandler && sockMock._connectionHandler({ connection: 'open' });

  // Número não encontrado no WhatsApp
  sockMock.onWhatsApp = async () => [];
  res = await invoke({ authorization: 'Bearer secret' }, { msisdn: '5511999999999', text: 'Oi' });
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(res.jsonBody, { ok: false, erro: 'whatsapp não encontrado' });

  // Success case
  sockMock.onWhatsApp = async () => [{ exists: true, jid: '5511999999999@s.whatsapp.net' }];
  sockMock.calls.length = 0;
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  res = await invoke({ authorization: 'Bearer secret' }, { msisdn: '5511999999999', text: 'Ola' });
  await new Promise(r => setImmediate(r));
  console.log = originalLog;
  assert.strictEqual(res.statusCode, 202);
  assert.deepStrictEqual(sockMock.calls[0], ['5511999999999@s.whatsapp.net', { text: 'Ola' }]);
  assert.deepStrictEqual(res.jsonBody, { ok: true, queued: true, to: '5511999999999@s.whatsapp.net' });
  assert(logs.some(l => l.includes('id=mock-id')), 'should log message id');

  // Erro ao enviar em background não altera resposta
  sockMock.sendMessage = async () => { throw new Error('falhou'); };
  res = await invoke({ authorization: 'Bearer secret' }, { msisdn: '5511999999999', text: 'Opa' });
  assert.strictEqual(res.statusCode, 202);
  assert.deepStrictEqual(res.jsonBody, { ok: true, queued: true, to: '5511999999999@s.whatsapp.net' });

  console.log('All sendMessage tests passed');
})();
