const assert = require('assert');
const path = require('path');
const Module = require('module');

function loadApiEmitDar(response) {
  const fetchMock = async () => ({ ok: true, json: async () => response });
  const indexPath = path.resolve(__dirname, '..', 'index.js');
  const originalRequire = Module.prototype.require;

  Module.prototype.require = function (moduleName) {
    if (moduleName === 'node-fetch') return fetchMock;
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
  const { apiEmitDar } = require(indexPath);
  Module.prototype.require = originalRequire;
  delete require.cache[indexPath];
  return apiEmitDar;
}

(async () => {
  let apiEmitDar = loadApiEmitDar({
    dar: {
      linha_digitavel: '123',
      pdf_url: 'http://exemplo',
      competencia: '07/2024',
      vencimento: '2024-07-10',
      valor: 50
    }
  });
  let res = await apiEmitDar('1', '5511999999999');
  assert.deepStrictEqual(res, {
    linha_digitavel: '123',
    pdf_url: 'http://exemplo',
    competencia: '07/2024',
    vencimento: '2024-07-10',
    valor: 50,
    msisdnCorrigido: '5511999999999'
  });

  apiEmitDar = loadApiEmitDar({
    dar: {
      linha_digitavel: '456',
      pdf_url: 'http://alt',
      mes_referencia: 7,
      ano_referencia: 2024,
      data_vencimento: '2024-07-10',
      valor_total: 75
    }
  });
  res = await apiEmitDar('2', '5511999999999');
  assert.deepStrictEqual(res, {
    linha_digitavel: '456',
    pdf_url: 'http://alt',
    competencia: '07/2024',
    vencimento: '2024-07-10',
    valor: 75,
    msisdnCorrigido: '5511999999999'
  });

  console.log('All apiEmitDar tests passed');
})();

