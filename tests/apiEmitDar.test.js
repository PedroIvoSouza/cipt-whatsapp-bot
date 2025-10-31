const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');

function loadApiEmitDar(responses) {
  const calls = [];
  let i = 0;
  const nextResp = () => Array.isArray(responses)
    ? responses[Math.min(i++, responses.length - 1)]
    : responses;
    const lockPath = path.resolve(__dirname, '..', 'cipt-bot.lock');
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);

    const axiosMock = {
    get: async (url, config = {}) => {
      calls.push({ method: 'get', url, config });
      const resp = nextResp();
      const status = resp.status ?? (resp.ok === false ? 400 : 200);
      const data = resp.body ?? resp;
      if (status >= 200 && status < 300) return { status, data };
      const err = new Error(`Request failed with status code ${status}`);
      err.response = { status, data };
      throw err;
    },
    post: async (url, data = null, config = {}) => {
      calls.push({ method: 'post', url, data, config });
      const resp = nextResp();
      const status = resp.status ?? (resp.ok === false ? 400 : 200);
      const respData = resp.body ?? resp;
      if (status >= 200 && status < 300) return { status, data: respData };
      const err = new Error(`Request failed with status code ${status}`);
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
      DisconnectReason: {},
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] })
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
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
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
  assert.strictEqual(apiEmitDar.axiosCalls[1].url, '/api/bot/dars/4');
  assert.deepStrictEqual(
    apiEmitDar.axiosCalls[1].config,
    { params: { msisdn: '5511999999999' } }
  );

  apiEmitDar = loadApiEmitDar([
    { ok: false, body: { error: 'DAR já emitida' } },
    { ok: true, body: {} }
  ]);
  await assert.rejects(
    () => apiEmitDar('5', '5511999999999'),
    /Campos ausentes: linha_digitavel, competencia, vencimento, valor/
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

  // Erro 400 ao consultar DAR já emitida com numero_documento inválido
  apiEmitDar = loadApiEmitDar([
    { ok: false, body: { error: 'DAR já emitida' } },
    { status: 400, body: { error: 'numero_documento inválido' } }
  ]);
  await assert.rejects(
    () => apiEmitDar('8', '5511999999999'),
    /numero_documento inválido/
  );
  assert.strictEqual(apiEmitDar.axiosCalls.length, 2);
  assert.strictEqual(apiEmitDar.axiosCalls[1].url, '/api/bot/dars/8');
  assert.deepStrictEqual(
    apiEmitDar.axiosCalls[1].config,
    { params: { msisdn: '5511999999999' } }
  );

  // Erro 404 ao consultar DAR já emitida - mensagem propagada
  apiEmitDar = loadApiEmitDar([
    { ok: false, body: { error: 'DAR já emitida' } },
    { status: 404, body: { error: 'DAR não encontrada' } }
  ]);
  await assert.rejects(
    () => apiEmitDar('9', '5511999999999'),
    /DAR não encontrada/
  );
  assert.strictEqual(apiEmitDar.axiosCalls.length, 2);
  assert.strictEqual(apiEmitDar.axiosCalls[1].url, '/api/bot/dars/9');
  assert.deepStrictEqual(
    apiEmitDar.axiosCalls[1].config,
    { params: { msisdn: '5511999999999' } }
  );

  console.log('All apiEmitDar tests passed');
  })();

