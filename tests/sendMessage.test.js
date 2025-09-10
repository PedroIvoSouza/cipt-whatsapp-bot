const assert = require('assert');
const path = require('path');
const Module = require('module');

async function loadSendMessage() {
  const calls = [];
  const sockMock = {
    calls,
    ev: { on(){} },
    sendMessage: async (...args) => {
      calls.push(args);
    }
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

  // Success case
  sockMock.calls.length = 0;
  res = await invoke({ authorization: 'Bearer secret' }, { msisdn: '5511999999999', text: 'Ola' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(sockMock.calls[0], ['5511999999999@s.whatsapp.net', { text: 'Ola' }]);
  assert.deepStrictEqual(res.jsonBody, { ok: true });

  // Error case
  sockMock.sendMessage = async () => { throw new Error('falhou'); };
  res = await invoke({ authorization: 'Bearer secret' }, { msisdn: '5511999999999', text: 'Opa' });
  assert.strictEqual(res.statusCode, 500);
  assert.ok(/falhou/i.test(res.jsonBody.erro || ''), 'error message propagated');

  console.log('All sendMessage tests passed');
})();
