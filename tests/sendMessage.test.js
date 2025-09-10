const assert = require('assert');
const path = require('path');
const Module = require('module');

function loadSendMessage() {
  const calls = [];
  const sockMock = {
    calls,
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
    return app;
  };
  expressMock.json = () => (req, res, next) => next();
  expressMock.routes = {};

  const indexPath = path.resolve(__dirname, '..', 'index.js');
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (moduleName) {
    if (moduleName === 'axios') return axiosMock;
    if (moduleName === 'express') return expressMock;
    if (moduleName === 'dotenv') return { config(){} };
    if (moduleName === 'pdf-parse') return async () => {};
    if (moduleName === 'langchain/text_splitter') return { RecursiveCharacterTextSplitter: class {} };
    if (moduleName === '@whiskeysockets/baileys') return {
      makeWASocket: () => sockMock,
      useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
      DisconnectReason: {}
    };
    if (moduleName === 'openai') return class {};
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

  process.env.BOT_SHARED_KEY = 'secret';

  delete require.cache[indexPath];
  require(indexPath);
  Module.prototype.require = originalRequire;
  delete require.cache[indexPath];

  const routes = expressMock.routes;
  const handler = routes['/send-message'] || routes['/sendMessage'] || routes['/send'];
  return { handler, sockMock };
}

(async () => {
  const { handler, sockMock } = loadSendMessage();
  assert(handler, 'sendMessage endpoint not registered');

  const invoke = async (headers = {}, body = {}) => {
    let statusCode;
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
  res = await invoke({ 'x-bot-key': 'secret' }, { msisdn: '5511999999999', text: 'Ola' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(sockMock.calls[0], ['5511999999999@s.whatsapp.net', { text: 'Ola' }]);
  assert.deepStrictEqual(res.jsonBody, { ok: true });

  // Error case
  sockMock.sendMessage = async () => { throw new Error('falhou'); };
  res = await invoke({ 'x-bot-key': 'secret' }, { msisdn: '5511999999999', text: 'Opa' });
  assert.strictEqual(res.statusCode, 500);
  assert.ok(/falhou/i.test(res.jsonBody.error || ''), 'error message propagated');

  console.log('All sendMessage tests passed');
})();
