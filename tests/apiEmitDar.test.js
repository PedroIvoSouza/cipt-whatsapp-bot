const assert = require('assert');
const path = require('path');
const Module = require('module');

function loadApiEmitDar(responses) {
  const calls = [];
  let i = 0;
  const nextResp = () => Array.isArray(responses)
    ? responses[Math.min(i++, responses.length - 1)]
    : responses;
  const axiosMock = {
    get: async (url, config = {}) => {
      calls.push({ method: 'get', url, config });
      const resp = nextResp();
      const status = resp.status ?? (resp.ok === false ? 400 : 200);
      const data = resp.body ?? resp;
      if (status >= 200 && status < 300) return { status, data };
      const err = new Error(data?.error || 'Erro');
      err.response = { status, data };
      throw err;
    },
    post: async (url, data = null, config = {}) => {
      calls.push({ method: 'post', url, data, config });
      const resp = nextResp();
      const status = resp.status ?? (resp.ok === false ? 400 : 200);
      const respData = resp.body ?? resp;
      if (status >= 200 && status < 300) return { status, data: respData };
      const err = new Error(respData?.error || 'Erro');
      err.response = { status, data: respData };
      throw err;
    },
    interceptors: { request: { use(){} } },
    create: () => axiosMock
  };
  const indexPath = path.resolve(__dirname, '..', 'index.js');
  const originalRequire = Module.prototype.require;

  Module.prototype.require = function (moduleName) {
    if (moduleName === 'axios') return axiosMock;
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
  apiEmitDar.axiosCalls = calls;
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

  apiEmitDar = loadApiEmitDar({
    dar: {
      linha_digitavel: '789',
      pdf_url: 'http://camel',
      mesReferencia: 8,
      anoReferencia: 2024,
      dataVencimento: '2024-08-15',
      valorTotal: 100
    }
  });
  res = await apiEmitDar('3', '5511999999999');
  assert.deepStrictEqual(res, {
    linha_digitavel: '789',
    pdf_url: 'http://camel',
    competencia: '08/2024',
    vencimento: '2024-08-15',
    valor: 100,
    msisdnCorrigido: '5511999999999'
  });

  apiEmitDar = loadApiEmitDar([
    { ok: false, body: { error: 'DAR já emitida' } },
    { ok: true, body: { dar: {
      linha_digitavel: '999',
      pdf_url: 'http://ja',
      mes_referencia: 9,
      ano_referencia: 2024,
      data_vencimento: '2024-09-10',
      valor_total: 125
    } } }
  ]);
  res = await apiEmitDar('4', '5511999999999');
  assert.deepStrictEqual(res, {
    linha_digitavel: '999',
    pdf_url: 'http://ja',
    competencia: '09/2024',
    vencimento: '2024-09-10',
    valor: 125,
    msisdnCorrigido: '5511999999999'
  });
  assert.strictEqual(apiEmitDar.axiosCalls.length, 2);

  apiEmitDar = loadApiEmitDar([
    { ok: false, body: { error: 'DAR já emitida' } },
    { ok: true, body: {} }
  ]);
  await assert.rejects(
    () => apiEmitDar('5', '5511999999999'),
    /sem dados retornados/
  );

  apiEmitDar = loadApiEmitDar({
    dar: [{
      linha_digitavel: '1010',
      pdf_url: 'http://arr',
      mes_referencia: 10,
      ano_referencia: 2024,
      data_vencimento: '2024-10-10',
      valor_total: 200
    }]
  });
  res = await apiEmitDar('6', '5511999999999');
  assert.deepStrictEqual(res, {
    linha_digitavel: '1010',
    pdf_url: 'http://arr',
    competencia: '10/2024',
    vencimento: '2024-10-10',
    valor: 200,
    msisdnCorrigido: '5511999999999'
  });

  // Sucesso com resposta em formato alternativo (dados.dar + linhaDigitavel)
  apiEmitDar = loadApiEmitDar({
    dados: { dar: {
      linhaDigitavel: '1111',
      pdfUrl: 'http://altform',
      mesReferencia: 12,
      anoReferencia: 2024,
      dataVencimento: '2024-12-20',
      valorTotal: 400
    } }
  });
  res = await apiEmitDar('7', '5511999999999');
  assert.deepStrictEqual(res, {
    linha_digitavel: '1111',
    pdf_url: 'http://altform',
    competencia: '12/2024',
    vencimento: '2024-12-20',
    valor: 400,
    msisdnCorrigido: '5511999999999'
  });

  // Fallback GET primeiro com msisdn e depois sem msisdn
  apiEmitDar = loadApiEmitDar([
    { ok: false, body: { error: 'DAR já emitida' } },
    { ok: false, body: { error: 'msisdn inválido' } },
    { ok: true, body: { dados: { dar: {
      linhaDigitavel: '1212',
      pdfUrl: 'http://semmsisdn',
      mesReferencia: 11,
      anoReferencia: 2024,
      dataVencimento: '2024-11-11',
      valorTotal: 300
    } } } }
  ]);
  res = await apiEmitDar('8', '5511999999999');
  assert.deepStrictEqual(res, {
    linha_digitavel: '1212',
    pdf_url: 'http://semmsisdn',
    competencia: '11/2024',
    vencimento: '2024-11-11',
    valor: 300,
    msisdnCorrigido: '5511999999999'
  });
  assert.strictEqual(apiEmitDar.axiosCalls.length, 3);
  assert(apiEmitDar.axiosCalls[0].url.includes('?msisdn=5511999999999'));
  assert(apiEmitDar.axiosCalls[1].url.includes('?msisdn=5511999999999'));
  assert(!apiEmitDar.axiosCalls[2].url.includes('msisdn'));

  console.log('All apiEmitDar tests passed');
})();

