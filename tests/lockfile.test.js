const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const LOCK_PATH = path.resolve(__dirname, '..', 'cipt-bot.lock');

function loadIndex() {
  const indexPath = path.resolve(__dirname, '..', 'index.js');
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (moduleName) {
    if (moduleName === 'axios') return { interceptors: { request: { use(){} } }, create(){ return this; } };
    if (moduleName === 'express') {
      const fn = () => ({ get(){}, listen(){}, use(){} });
      fn.json = () => (req, res, next) => next();
      return fn;
    }
    if (moduleName === 'dotenv') return { config(){} };
    if (moduleName === 'pdf-parse') return async () => {};
    if (moduleName === 'langchain/text_splitter') return { RecursiveCharacterTextSplitter: class {} };
    if (moduleName === '@whiskeysockets/baileys') return {
      makeWASocket: () => ({}),
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
  delete require.cache[indexPath];
  try {
    require(indexPath);
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[indexPath];
  }
}

(async () => {
  if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);

  loadIndex();
  assert(fs.existsSync(LOCK_PATH), 'lockfile should exist after first load');
  const cleanup = process.listeners('exit').find(fn => fn.toString().includes('LOCK_FILE'));

  let exitCode;
  let logged = '';
  const origExit = process.exit;
  const origErr = console.error;
  process.exit = code => { exitCode = code; throw new Error('exit'); };
  console.error = msg => { logged += String(msg); };

  assert.throws(() => loadIndex(), /exit/);

  console.error = origErr;
  process.exit = origExit;

  assert.strictEqual(exitCode, 1);
  assert(logged.includes('cipt-bot.lock'));

  cleanup();
  process.removeListener('exit', cleanup);
  assert(!fs.existsSync(LOCK_PATH), 'lockfile should be removed on cleanup');
})();

