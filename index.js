// =================================================================================================
// CIPT-WHATSAPP-BOT - VERSÃO DE PRODUÇÃO FINAL (COM D.A.R. via WhatsApp)
// =================================================================================================

const crypto = require("node:crypto");
global.crypto = crypto;

const express = require('express');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const OpenAI = require('openai');
const axios = require('axios');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose(); // <- NOVO
const { getCiptPrompt } = require("./ciptPrompt.js");
const { registrarChamado, atualizarStatusChamado, verificarChamadosAbertos } = require("./sheetsChamados");

// ⚙️ Carrega variáveis de ambiente ANTES de ler process.env
dotenv.config();

const ADMIN_API_BASE = process.env.ADMIN_API_BASE || 'https://admin.portalcipt.com.br';
const BOT_SHARED_KEY  = process.env.BOT_SHARED_KEY;
if (!BOT_SHARED_KEY) {
  console.warn('[WARN] BOT_SHARED_KEY não definido no ambiente do bot.');
}

function msisdnFromJid(jid){ return (jid.split('@')[0] || '').replace(/\D/g,''); }
function brMoney(v){ return Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
function brDate(iso){ try{ return new Date(iso).toLocaleDateString('pt-BR'); }catch{ return iso; } }
const apiHeaders = () => ({ 'x-bot-key': BOT_SHARED_KEY, 'Content-Type': 'application/json' });

// Remove informações sensíveis de mensagens de log
const sanitizeSensitive = (str = '') =>
  String(str)
    .replace(/x-bot-key\s*[:=]\s*[^\s]+/gi, 'x-bot-key: [redacted]')
    .replace(/x-bot-key/gi, '[redacted]');

const app = express();
app.use(express.json());
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMAIL_SUPORTE = 'supcti@secti.al.gov.br';
const SITE_OFICIAL = 'secti.al.gov.br';

let embeddingsCache = [];
let sock; 

const authPath = process.env.RENDER_DISK_MOUNT_PATH ? `${process.env.RENDER_DISK_MOUNT_PATH}/auth` : 'auth';
const embeddingsPath = process.env.RENDER_DISK_MOUNT_PATH ? `${process.env.RENDER_DISK_MOUNT_PATH}/embeddings.json` : 'embeddings.json';

// --- DB (read-only) para consultar Permissionários/DARs --------------------
const defaultDbPath = path.join(__dirname, 'sistemacipt.db');
const DB_PATH = process.env.DB_PATH || defaultDbPath;
const REMOTE_DB_URL = process.env.REMOTE_DB_URL;

let db; // poderá ficar indefinido se não houver SQLite local
let dbAll; // funções auxiliares dependem da disponibilidade de um DB
let dbGet;

if (REMOTE_DB_URL) {
  console.log(`🌐 Banco de dados remoto detectado (REMOTE_DB_URL). Pulando verificação de arquivo SQLite.`);
  // Aqui seria configurada a conexão com o banco remoto, se necessário.
  dbAll = async () => [];
  dbGet = async () => null;
} else if (fs.existsSync(DB_PATH)) {
  try {
    fs.accessSync(DB_PATH, fs.constants.R_OK);
  } catch (e) {
    console.error(`❌ Sem permissão de leitura para o banco de dados: ${DB_PATH}`);
    process.exit(1);
  }
  db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
    if (err) console.error('❌ ERRO abrindo SQLite no bot:', err.message);
    else console.log('🗄️  SQLite (read-only) conectado no bot:', DB_PATH);
  });
  dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows)));
  });
  dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (e, row) => (e ? reject(e) : resolve(row)));
  });
} else {
  console.warn(`⚠️ Banco de dados SQLite não encontrado em ${DB_PATH}. Prosseguindo sem acesso ao banco local.`);
  dbAll = async () => [];
  dbGet = async () => null;
}
const onlyDigits = (v='') => String(v).replace(/\D/g,'');
const todayISO = () => new Date().toISOString().slice(0,10);

// Detecta existência de telefone_cobranca para ampliar o match
let TEM_COL_TEL_COBRANCA = false;
async function verificarColunaTelefoneCobranca() {
  try {
    const cols = await dbAll(`PRAGMA table_info(permissionarios)`);
    TEM_COL_TEL_COBRANCA = cols.some(c => (c.name || '').toLowerCase() === 'telefone_cobranca');
    console.log('☎️  Coluna telefone_cobranca existe?', TEM_COL_TEL_COBRANCA);
  } catch (e) {
    TEM_COL_TEL_COBRANCA = false;
    console.warn('PRAGMA table_info falhou:', e.message);
  }
}

async function findPermissionarioByWhatsAppJid(jid){
  const digits = onlyDigits(jid.split('@')[0]); // ex.: 55829...
  const cols = `id, nome_empresa, telefone` + (TEM_COL_TEL_COBRANCA ? `, telefone_cobranca` : ``);

  // Remove caracteres não numéricos em SQL para comparação
  const clean = (field) =>
    `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(${field},''),'.',''),'-',''),' ',''),'(',''),')','')`;

  let sql = `SELECT ${cols} FROM permissionarios WHERE ${clean('telefone')} = ?`;
  const params = [digits];

  if (TEM_COL_TEL_COBRANCA) {
    sql += ` OR ${clean('telefone_cobranca')} = ?`;
    params.push(digits);
  }

  sql += ' LIMIT 1';
  return dbGet(sql, params);
}

// === Chamadas para a API do sistema de pagamentos =========================
async function apiGetDars(msisdn, retry = 0){
  const r = await axios.get(`${ADMIN_API_BASE}/api/bot/dars?msisdn=${msisdn}`, {
    headers: apiHeaders(),
    validateStatus: () => true,
  });
  let data = r.data;
  if (typeof data !== 'object') {
    try { data = JSON.parse(data); } catch { throw new Error(`Resposta inválida da API (${r.status})`); }
  }
  const ok = r.status >= 200 && r.status < 300;
  if (!ok){
    const errMsg = data?.error || `Falha (${r.status})`;
    if (retry === 0 && msisdn.length === 12 && /associado a nenhum/i.test(errMsg)) {
      return apiGetDars(msisdn.slice(0,4) + '9' + msisdn.slice(4), 1);
    }
    throw new Error(errMsg);
  }
  return { data, msisdnCorrigido: msisdn };
}

// ==================== API BOT CLIENT (axios) — NOVO BLOCO ====================
const api = axios.create({ baseURL: ADMIN_API_BASE });
api.interceptors.request.use((config) => {
  config.headers = { ...(config.headers || {}), ...apiHeaders() };
  return config;
});

/**
 * Emite a DAR. Se já emitida (409), consulta a existente.
 * Mantém a mesma assinatura usada no restante do bot.
 *
 * @param {number|string} darId
 * @param {string} msisdn
 * @param {number} retry
 */
async function apiEmitDar(darId, msisdn, retry = 0) {
  function extract(payload = {}) {
    let dar =
      payload?.dar ||
      payload?.data?.dar ||
      payload?.dados?.dar ||
      payload?.data ||
      payload?.dados ||
      payload;

    if (Array.isArray(dar)) dar = dar[0];
    if (dar?.dar) dar = dar.dar;

    let {
      linha_digitavel,
      linhaDigitavel,
      pdf_url,
      pdfUrl,
      competencia,
      vencimento,
      valor,
      mes_referencia,
      mesReferencia,
      ano_referencia,
      anoReferencia,
      data_vencimento,
      dataVencimento,
      valor_total,
      valorTotal,
    } = dar || {};

    linha_digitavel = linha_digitavel || linhaDigitavel;
    pdf_url = pdf_url || pdfUrl;

    if (!competencia && (mes_referencia ?? mesReferencia) != null && (ano_referencia ?? anoReferencia) != null) {
      const mes = mes_referencia ?? mesReferencia;
      const ano = ano_referencia ?? anoReferencia;
      competencia = `${String(mes).padStart(2, '0')}/${ano}`;
    }

    if (!vencimento && (data_vencimento || dataVencimento)) {
      vencimento = data_vencimento || dataVencimento;
    }

    if (valor == null) {
      valor = valor_total ?? valorTotal ?? dar?.total;
    }

    return { linha_digitavel, pdf_url, competencia, vencimento, valor };
  }

  function ensureFields(obj) {
    const { linha_digitavel, competencia, vencimento, valor } = obj || {};
    const missing = [];
    if (!linha_digitavel) missing.push('linha_digitavel');
    if (!competencia) missing.push('competencia');
    if (!vencimento) missing.push('vencimento');
    if (valor == null) missing.push('valor');
    if (missing.length) {
      throw new Error(`Campos ausentes: ${missing.join(', ')}`);
    }
    return { ...obj, msisdnCorrigido: msisdn };
  }

  // 1) tenta POST com msisdn no corpo
  try {
    const res = await api.post(
      `/api/bot/dars/${darId}/emit?msisdn=${msisdn}`,
      { msisdn }
    );
    return ensureFields(extract(res.data));
  } catch (errBody) {
    const status = errBody.response?.status;
    const data = errBody.response?.data;
    const msg = data?.error || errBody.message || 'Falha ao emitir DAR';

    // 409 -> já emitida: consulta usando o próprio darId
    if (status === 409 || /dar j[aá] emitid/i.test(msg)) {
      try {
        const resGet = await api.get(`/api/bot/dars/${darId}`, {
          params: { msisdn },
        });
        try {
          return ensureFields(extract(resGet.data));
        } catch (e) {
          console.error('Consulta GET falhou:', resGet.status, resGet.data);
          if (/Campos ausentes/i.test(e.message)) {
            const missing = e.message
              .split(':')[1]
              ?.split(',')
              .map((s) => s.trim())
              .filter(Boolean) || [];
            throw new Error(`Campos ausentes: ${missing.join(', ')}`);
          }
          const sMsg = sanitizeSensitive(e.message);
          throw new Error(sMsg);
        }
      } catch (consultaErr) {
        const status = consultaErr.response?.status;
        const data = consultaErr.response?.data;
        if (consultaErr.response) {
          console.error('Consulta GET falhou:', status, data);
        } else {
          console.error('Consulta GET falhou:', consultaErr.message);
        }
        const sMsg = sanitizeSensitive(data?.error || consultaErr.message);
        throw new Error(sMsg);
      }
    }

    // Heurística de MSISDN (inserir 9 após DDI+DDD se a API reclamar de associação)
    if (retry === 0 && msisdn?.length === 12 && /associado a nenhum/i.test(msg)) {
      const corrigido = msisdn.slice(0, 4) + '9' + msisdn.slice(4);
      return apiEmitDar(darId, corrigido, 1);
    }

    const sMsg = sanitizeSensitive(msg);
    throw new Error(sMsg);
  }
}
// ==================== FIM DO BLOCO NOVO ====================

function normalizeDar(d = {}){
  const id = d.id ?? d.numero_documento ?? d.numero;
  let mes = d.mes_referencia ?? d.mesReferencia;
  let ano = d.ano_referencia ?? d.anoReferencia;
  if ((mes == null || ano == null) && d.competencia){
    const m = String(d.competencia).match(/(\d{1,2})[\/-](\d{4})/);
    if (m){
      mes ??= m[1];
      ano ??= m[2];
    }
  }
  const data_vencimento = d.data_vencimento || d.dataVencimento || d.vencimento;
  const valor = d.valor ?? d.valor_total ?? d.valorTotal ?? d.total;
  return { ...d, id, mes, ano, data_vencimento, valor };
}
function darResumo(d){
  const nd = normalizeDar(d);
  const comp = nd.mes && nd.ano ? `${String(nd.mes).padStart(2,'0')}/${nd.ano}` : 'N/D';
  const venc = nd.data_vencimento ? brDate(nd.data_vencimento) : 'N/D';
  const valor = nd.valor != null ? brMoney(nd.valor) : 'N/D';
  return `Comp.: ${comp} | Venc.: ${venc} | Valor: ${valor}`;
}
function formatDarLine(d){
  const nd = normalizeDar(d);
  const comp = nd.mes && nd.ano ? `${String(nd.mes).padStart(2,'0')}/${nd.ano}` : 'N/D';
  const venc = nd.data_vencimento ? brDate(nd.data_vencimento) : 'N/D';
  const valor = nd.valor != null ? brMoney(nd.valor) : 'N/D';
  return `• Comp.: ${comp} | Venc.: ${venc} | Valor: ${valor}`;
}
async function montarTextoResposta(msisdn, payload, {
  offsetVig = 0,
  offsetVenc = 0,
  limit = 2,
  greeting = true
} = {}){
  const linhas = [];
  const mapa = {};
  let contador = 1 + offsetVig + offsetVenc;

  if (payload.permissionario){ // payload legado
    const nome = payload.permissionario.nome_empresa;
    if (greeting && offsetVig === 0 && offsetVenc === 0){
      linhas.push(`Olá, *${nome}*! Aqui estão suas DARs:`);
    }
    const vigentesArr = payload.dars.vigentes || (payload.dars.vigente ? [payload.dars.vigente] : []);
    if (vigentesArr.length){
      linhas.push('🔷 *DARs vigentes*');
      let mostradasVig = 0;
      for (const d of vigentesArr.slice(offsetVig, offsetVig + limit)) {
        const nd = normalizeDar(d);
        const txt = await formatDarLine(d);
        linhas.push(txt.replace(/^•/, `${contador})`));
        mapa[contador++] = { id: nd.id, resumo: darResumo(d) };
        mostradasVig++;
      }
      const restVig = vigentesArr.length - (offsetVig + mostradasVig);
      if (restVig > 0){
        linhas.push(`(+${restVig} outras) – responda 'mais' para ver todas`);
      }
      offsetVig += mostradasVig;
    } else if (offsetVig === 0){
      linhas.push('🔷 *DAR vigente*: nenhuma.');
    }

    const vencidasArr = payload.dars.vencidas || [];
    if (vencidasArr.length){
      linhas.push(`\n🔻 *DARs vencidas*`);
      let mostradasVenc = 0;
      for (const d of vencidasArr.slice(offsetVenc, offsetVenc + limit)) {
        const nd = normalizeDar(d);
        const txt = await formatDarLine(d);
        linhas.push(txt.replace(/^•/, `${contador})`));
        mapa[contador++] = { id: nd.id, resumo: darResumo(d) };
        mostradasVenc++;
      }
      const restVenc = vencidasArr.length - (offsetVenc + mostradasVenc);
      if (restVenc > 0){
        linhas.push(`(+${restVenc} outras) – responda 'mais' para ver todas`);
      }
      offsetVenc += mostradasVenc;
    } else if (offsetVenc === 0){
      linhas.push('✅ Sem DARs vencidas.');
    }
    linhas.push("Envie o número correspondente para receber os dados da DAR ou digite 'sair' para encerrar.");
    return { texto: linhas.join('\n'), mapa, mostradas: { vig: offsetVig, venc: offsetVenc } };
  }

  if (Array.isArray(payload.contas) && payload.contas.length){
    linhas.push('Encontrei estes cadastros vinculados ao seu número:');
    for (const conta of payload.contas){
      const cab = conta.tipo === 'CLIENTE_EVENTO'
        ? `🎫 *Cliente de Eventos:* ${conta.nome}`
        : `🏢 *Permissionário:* ${conta.nome}`;
      linhas.push(cab);
      const vigArr = conta.dars.vigentes || (conta.dars.vigente ? [conta.dars.vigente] : []);
      if (vigArr.length){
        linhas.push('  🔷 *DARs vigentes*');
        let mostradasVig = 0;
        for (const d of vigArr.slice(0,2)) {
          const nd = normalizeDar(d);
          const txt = await formatDarLine(d);
          linhas.push(txt.replace(/^•/, `${contador})`));
          mapa[contador++] = { id: nd.id, resumo: darResumo(d) };
          mostradasVig++;
        }
        if (vigArr.length > 2){
          linhas.push(`  (+${vigArr.length-2} outras) – responda 'mais' para ver todas`);
        }

      } else {
        linhas.push('  🔷 *DAR vigente*: nenhuma.');
      }
      const venc = conta.dars.vencidas || [];
      if (venc.length){
        linhas.push(`  🔻 *DARs vencidas* (${venc.length})`);
        for (const d of venc.slice(0,2)) {
          const nd = normalizeDar(d);
          const txt = await formatDarLine(d);

          linhas.push(txt.replace(/^•/, `${contador})`));
          mapa[contador++] = { id: nd.id, resumo: darResumo(d) };
        }
        if (venc.length > 2) linhas.push(`  (+${venc.length-2} outras) – responda 'mais' para ver todas`);
      } else {
        linhas.push('  ✅ Sem DARs vencidas.');
      }
      linhas.push('');
    }
    linhas.push("Envie o número correspondente para receber os dados da DAR ou digite 'sair' para encerrar.");
    return { texto: linhas.join('\n'), mapa };
  }
  return { texto: 'Não localizei DARs para este número.', mapa };
}

// === Funções locais de consulta (mantidas) =================================
async function listarDARsVencidas(permissionarioId){
  const sql = `
    SELECT id, mes_referencia, ano_referencia, valor, data_vencimento, status, linha_digitavel
      FROM dars
     WHERE permissionario_id = ?
       AND status <> 'Pago'
       AND date(data_vencimento) < date(?)
  ORDER BY date(data_vencimento) ASC`;
  return dbAll(sql, [permissionarioId, todayISO()]);
}

async function obterDARVigente(permissionarioId){
  const sql = `
    SELECT id, mes_referencia, ano_referencia, valor, data_vencimento, status, linha_digitavel
      FROM dars
     WHERE permissionario_id = ?
       AND status <> 'Pago'
       AND date(data_vencimento) >= date(?)
  ORDER BY date(data_vencimento) ASC
     LIMIT 1`;
  return dbGet(sql, [permissionarioId, todayISO()]);
}

// --- CONTROLE DE SESSÕES E ESTADO -----------------------------------------
// Estrutura: { [jid]: { lastActive: number, chamadoPendente?: { descricao, categoria } } }
const usuarios = {};
const timersEncerramento = {};
const TEMPO_ENCERRAMENTO = 5 * 60 * 1000;
const historicoUsuarios = {};
const LIMITE_HISTORICO = 8;
const contatosEnviados = {};
const GRUPO_SUPORTE_JID = process.env.GRUPO_SUPORTE_JID;

const routingMap = {
    'Limpeza': [{ nome: 'Laysa', jid: '558287058516@s.whatsapp.net' }],
    'Segurança e Portaria': [{ nome: 'Laysa', jid: '558287058516@s.whatsapp.net' }],
    'Manutenção Civil': [{ nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Energia Elétrica': [{ nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Hidráulica / Vazamentos': [{ nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Outros': [{ nome: 'Laysa', jid: '558287058516@s.whatsapp.net' }, { nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Equipamentos / Móveis': [{ nome: 'Laysa', jid: '558287058516@s.whatsapp.net' }, { nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Internet e Rede': [{ nome: 'Laysa', jid: '558287058516@s.whatsapp.net' }, { nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Elevadores': [{ nome: 'Laysa', jid: '558287058516@s.whatsapp.net' }, { nome: 'Daisy', jid: '558293826962@s.whatsapp.net' }],
    'Administrativo': [{ nome: 'Pedro Ivo', jid: '558299992881@s.whatsapp.net' }],
};

// ✅ LISTA DE JIDs DA EQUIPE DE SUPORTE AUTORIZADA A DAR COMANDOS
const equipeSuporteJids = [
    '558287058516@s.whatsapp.net', // Laysa
    '558293826962@s.whatsapp.net', // Daisy
    '558299992881@s.whatsapp.net', // Pedro Ivo
];

// --- FUNÇÕES AUXILIARES EXISTENTES ----------------------------------------
async function gerarOuCarregarEmbeddings() {
  console.log(`ℹ️ Verificando cache de embeddings em: ${embeddingsPath}`);
  try {
    if (fs.existsSync(embeddingsPath)) {
      embeddingsCache = JSON.parse(fs.readFileSync(embeddingsPath, 'utf8'));
      console.log("📦 Embeddings carregados do cache no disco persistente.");
      return;
    }
    console.log("📄 Lendo documentos para a base de conhecimento...");
    const dataBuffer = fs.readFileSync('./regimento.pdf');
    let pdfData = await pdfParse(dataBuffer);
    let textoNormalizado = pdfData.text.replace(/\n\s*\n/g, '\n').replace(/\s+/g, ' ');
    const fontesExtras = fs.readFileSync('./fontes.txt', 'utf8');
    const fontesNormalizadas = fontesExtras.replace(/\n\s*\n/g, '\n').replace(/\s+/g, ' ');
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1200, chunkOverlap: 200 });
    const pdfDividido = await splitter.splitText(textoNormalizado);
    const fontesDivididas = await splitter.splitText(fontesNormalizadas);
    const pdfChunks = [...pdfDividido, ...fontesDivididas];
    console.log(`📚 Documentos divididos em ${pdfChunks.length} trechos.`);
    console.log("⚙️ Gerando embeddings...");
    for (let chunk of pdfChunks) {
      const embedding = await client.embeddings.create({ model: "text-embedding-3-small", input: chunk });
      embeddingsCache.push({ trecho: chunk, vector: embedding.data[0].embedding });
    }
    fs.writeFileSync(embeddingsPath, JSON.stringify(embeddingsCache, null, 2));
    console.log("✅ Embeddings salvos em cache no disco persistente.");
  } catch (err) {
    console.error("❌ Erro ao carregar/gerar embeddings:", err.message);
  }
}

async function buscarTrechosRelevantes(pergunta) {
  try {
    const perguntaEmbedding = await client.embeddings.create({ model: "text-embedding-3-small", input: pergunta });
    const perguntaVector = perguntaEmbedding.data[0].embedding;
    const resultados = embeddingsCache.map(e => {
      const dot = perguntaVector.reduce((acc, val, idx) => acc + val * e.vector[idx], 0);
      const magA = Math.sqrt(perguntaVector.reduce((acc, val) => acc + val * val, 0));
      const magB = Math.sqrt(e.vector.reduce((acc, val) => acc + val * val, 0));
      const score = dot / (magA * magB);
      return { trecho: e.trecho, score };
    });
    resultados.sort((a, b) => b.score - a.score);
    const resultadosFiltrados = resultados.filter(r => r.score > 0.72);
    const selecionados = (resultadosFiltrados.length > 0 ? resultadosFiltrados : resultados).slice(0, 8).map(r => r.trecho);
    return selecionados.join("\n\n");
  } catch (err) {
    console.error("❌ Erro ao buscar trechos:", err.message);
    return "";
  }
}

async function classificarChamado(pergunta) {
  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "Sua tarefa é analisar a mensagem e responder em JSON: {\"ehChamado\":\"SIM ou NAO\",\"categoria\":\"Categoria Sugerida\"}. Categorias: Limpeza, Segurança e Portaria, Manutenção Civil, Energia Elétrica, Hidráulica / Vazamentos, Outros, Equipamentos / Móveis, Internet e Rede, Elevadores, Administrativo. Se não for chamado, use {\"ehChamado\":\"NAO\",\"categoria\":\"N/A\"}." }, { role: "user", content: pergunta }],
      temperature: 0,
      max_tokens: 50
    });
    return JSON.parse(resp.choices[0].message.content.trim());
  } catch (err) {
    console.error("❌ Erro ao classificar chamado:", err.message);
    return { ehChamado: "NAO", categoria: "N/A" };
  }
}

function ehFollowUp(pergunta) {
  const conectores = ["e ", "mas ", "então", "sobre isso", "e quanto", "e sobre", "ainda", "continuando", "ok", "certo"];
  const curtas = pergunta.split(" ").length <= 5;
  return conectores.some(c => pergunta.startsWith(c)) || curtas;
}

function gerarSaudacao(nome) {
  const opcoes = [`Olá, ${nome}! Sou a IA do CIPT. Em que posso ser útil hoje? 👋`, `Bom dia, ${nome}! Aqui é a assistente virtual do CIPT. Como posso ajudar?`, `Seja bem-vindo(a) ao CIPT, ${nome}. Estou à disposição para esclarecer suas dúvidas. 🙂`];
  return opcoes[Math.floor(Math.random() * opcoes.length)];
}

function gerarSugestoes() {
  const opcoes = ["Como faço para reservar o auditório?", "Quais são as penalidades por descumprimento das regras?", "Posso levar animais para o CIPT?", "Quais são os horários de funcionamento?"];
  const sorteadas = opcoes.sort(() => 0.5 - Math.random()).slice(0, 2);
  return `\n\n*Posso ajudar com algo mais?* Você pode perguntar, por exemplo:\n- _${sorteadas[0]}_\n- _${sorteadas[1]}_`;
}

async function enviarContato(sock, jid, nome, telefone) {
  try {
    await sock.sendMessage(jid, { text: `Certo! Estou enviando o contato de "${nome}" para você.` });
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${nome}\nTEL;type=CELL;type=VOICE;waid=${telefone}:${telefone}\nEND:VCARD`;
    await sock.sendMessage(jid, { contacts: { displayName: nome, contacts: [{ vcard }] } });
  } catch (err) {
    console.error("❌ Erro ao enviar vCard, enviando fallback:", err.message);
    await sock.sendMessage(jid, { text: `Houve um problema ao enviar o cartão de contato. Você pode contatar *${nome}* pelo número: +${telefone}. Para outras informações, escreva para ${EMAIL_SUPORTE} ou visite ${SITE_OFICIAL}.` });
  }
}

function salvarLog(nome, pergunta) {
  const data = new Date().toLocaleString("pt-BR");
  const linha = `[${data}] 👤 ${nome}: 💬 ${pergunta}\n`;
  fs.appendFile("mensagens.log", linha, (err) => {
    if (err) console.error("❌ Erro ao salvar log:", err);
  });
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function enviarRelatorioDePendencias(sockInstancia) {
  if (!sockInstancia || !GRUPO_SUPORTE_JID) {
    console.log("[RELATÓRIO] Bot não conectado ou grupo não definido.");
    return;
  }
  const chamadosAbertos = await verificarChamadosAbertos();
  if (chamadosAbertos.length === 0) {
    const mensagem = "📈 *Relatório de Chamados*\n\nNenhum chamado pendente no momento. Bom trabalho, equipe! ✅";
    await sockInstancia.sendMessage(GRUPO_SUPORTE_JID, { text: mensagem });
    return;
  }
  const contagemPorResponsavel = {};
  for (const chamado of chamadosAbertos) {
    const responsaveis = routingMap[chamado.categoria] || [{ nome: 'Não atribuído' }];
    for (const responsavel of responsaveis) {
      contagemPorResponsavel[responsavel.nome] = (contagemPorResponsavel[responsavel.nome] || 0) + 1;
    }
  }
  let mensagem = `📈 *Relatório de Chamados Pendentes*\n\nOlá, equipe! Temos *${chamadosAbertos.length} chamado(s)* que precisam de atenção:\n`;
  for (const [nome, count] of Object.entries(contagemPorResponsavel)) {
    mensagem += `\n- ${nome}: ${count} chamado(s) pendente(s)`;
  }
  mensagem += "\n\nPor favor, atualizem os status respondendo aos alertas no grupo. Vamos zerar essa fila! 💪";
  await sockInstancia.sendMessage(GRUPO_SUPORTE_JID, { text: mensagem });
}

// --- LÓGICA PRINCIPAL DO BOT ----------------------------------------------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  sock = makeWASocket({ auth: state });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) console.log("‼️ NOVO QR CODE. Gere a imagem em: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr));
    if (connection === 'open') console.log('✅ Conectado ao WhatsApp!');
    if (connection === 'close') {
      const error = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = error !== DisconnectReason.loggedOut;
      console.log(`❌ Conexão caiu (código: ${error}). Reconectando: ${shouldReconnect}`);
      if (error === DisconnectReason.connectionReplaced) console.log("‼️ CONFLITO: Garanta que apenas uma instância do bot esteja rodando!");
      if (shouldReconnect) setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    const nomeContato = msg.pushName || "Usuário";
    const corpoMensagem = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const pergunta = corpoMensagem.trim(); // mantém case quando necessário
    const perguntaNormalizada = corpoMensagem.toLowerCase().trim().replace(/@bot/gi, "");

    if (usuarios[jid]?.darMap && /^sair$/i.test(pergunta)) {
      delete usuarios[jid].darMap;
      delete usuarios[jid].darPayload;
      delete usuarios[jid].darOffsets;
      await sock.sendMessage(jid, { text: 'Fluxo de DAR encerrado. Se precisar de algo mais, é só me chamar! 👋' });
      return;
    }

    // ✅ NOVA LÓGICA: DARs por WhatsApp (antes de qualquer early-return)
    const textoLow = (corpoMensagem || '').toLowerCase();
    if (!(isGroup && !textoLow.includes('@bot'))) {
      const numeroEscolhido = pergunta.match(/\d+/)?.[0];
      if (numeroEscolhido && usuarios[jid]?.darMap) {
        const darEntry = usuarios[jid].darMap[numeroEscolhido];
        if (darEntry?.id) {
          const darId = darEntry.id;
          const msisdnBase = usuarios[jid]?.msisdnCorrigido || msisdnFromJid(jid);
          try {
            const { linha_digitavel, pdf_url, competencia, vencimento, valor, msisdnCorrigido } = await apiEmitDar(darId, msisdnBase);
            usuarios[jid].msisdnCorrigido = msisdnCorrigido;
            if (!pdf_url) console.error(`pdf_url ausente para DAR ${darId}`);
            const resumo = darEntry.resumo || `DAR ${darId}`;
            const mensagem = [
              resumo,
              `Competência: ${competencia}`,
              `Vencimento: ${brDate(vencimento)}`,
              `Valor: ${brMoney(valor)}`,
              `Linha digitável: ${linha_digitavel}`,
              'O PDF pode ser baixado através do Portal do CIPT.'
            ].join('\n');
            await sock.sendMessage(jid, { text: mensagem });
          } catch (e) {
            await sock.sendMessage(jid, { text: `Não foi possível recuperar a DAR selecionada: ${e.message}` });
          }
        } else {
          await sock.sendMessage(jid, { text: 'DAR não disponível' });
        }
        return;
      } else if (/^mais$/i.test(pergunta) && usuarios[jid]?.darPayload) {
        const state = usuarios[jid].darOffsets || { vig: 0, venc: 0 };
        const msisdnBase = usuarios[jid]?.msisdnCorrigido || msisdnFromJid(jid);
        const { texto, mapa, mostradas } = await montarTextoResposta(msisdnBase, usuarios[jid].darPayload, {
          offsetVig: state.vig,
          offsetVenc: state.venc,
          limit: 5,
          greeting: false
        });
        if (mostradas.vig === state.vig && mostradas.venc === state.venc) {
          await sock.sendMessage(jid, { text: 'Não há mais DARs.' });
        } else {
          await sock.sendMessage(jid, { text: texto });
          usuarios[jid].darOffsets = mostradas;
          usuarios[jid].darMap = { ...(usuarios[jid].darMap || {}), ...mapa };
          const totalVig = (usuarios[jid].darPayload.dars.vigentes || (usuarios[jid].darPayload.dars.vigente ? [usuarios[jid].darPayload.dars.vigente] : [])).length;
          const totalVenc = (usuarios[jid].darPayload.dars.vencidas || []).length;
          if (mostradas.vig >= totalVig && mostradas.venc >= totalVenc) {
            delete usuarios[jid].darPayload;
            delete usuarios[jid].darOffsets;
          }
        }


        return;
      }

      const pedeDAR = /\b(dar(?:s)?|boleto|2.?ª? via|segunda via|guia(?: de pagamento)?|pagamento (?:do aluguel|de eventos)|pagamento)\b/i.test(textoLow);
      const pedeVencidas = /vencid|atrasad|pendent/i.test(textoLow);
      const pedeVigente  = /vigent|atual|corrente|m[eê]s/i.test(textoLow);

      if (pedeDAR || pedeVencidas || pedeVigente) {
        await sock.sendMessage(jid, { text: "Certo! Vou consultar suas DARs. Depois, envie o número correspondente para receber os dados ou digite 'sair' para encerrar." });
        const msisdnOrig = msisdnFromJid(jid);
        try {
          const { data: payload, msisdnCorrigido } = await apiGetDars(msisdnOrig);
          const { texto, mapa, mostradas } = await montarTextoResposta(msisdnCorrigido, payload);
          usuarios[jid] = { ...(usuarios[jid] || {}), darMap: mapa, msisdnCorrigido, darPayload: payload, darOffsets: mostradas };
          await sock.sendMessage(jid, { text: texto });
        } catch (e) {
          const msg = sanitizeSensitive(e.message || '');
          console.warn(`[apiGetDars] msisdn=${msisdnOrig} erro=${msg}`);
          if (/associado a nenhum/i.test(msg)) {
            await sock.sendMessage(jid, { text:
              "Não localizei seu cadastro pelo número deste WhatsApp.\n" +
              "Atualize seu telefone no portal do permissionário/cliente."
            });
          } else {
            await sock.sendMessage(jid, { text: `Tive um problema ao consultar suas DARs: ${msg}` });
          }
        }
        return; // não segue para IA neste fluxo
      }
    }

    // ✅ Comando privado de status (CH-12345 - 1)
    if (!isGroup && equipeSuporteJids.includes(jid)) {
      const matchComando = pergunta.match(/^(CH-\d+)\s*-\s*(\d)$/i);
      if (matchComando) {
          const protocolo = matchComando[1].toUpperCase();
          const comando = matchComando[2];
          const responsavel = nomeContato;
          const telefoneResponsavel = jid;
          let novoStatus = "";

          if (comando === "1") novoStatus = "Em Atendimento";
          else if (comando === "2") novoStatus = "Concluído";
          else if (comando === "3") novoStatus = "Rejeitado";

          if (novoStatus) {
              const usuarioJid = await atualizarStatusChamado(protocolo, novoStatus, responsavel, telefoneResponsavel);
              const statusEmoji = {"Em Atendimento": "📌", "Concluído": "✅", "Rejeitado": "❌"}[novoStatus];

              await sock.sendMessage(jid, { text: `${statusEmoji} Status do chamado *${protocolo}* atualizado para *${novoStatus}* com sucesso.` });

              if (GRUPO_SUPORTE_JID) {
                  const logGrupo = `[LOG] O status do chamado *${protocolo}* foi atualizado para *${novoStatus}* por ${responsavel}.`;
                  await sock.sendMessage(GRUPO_SUPORTE_JID, { text: logGrupo });
              }
              if (usuarioJid) {
                  await sock.sendMessage(usuarioJid, { text: `O status do seu chamado de protocolo *${protocolo}* foi atualizado para *${novoStatus}*.` });
              }
              return;
          }
      }
    }
    
    if (isGroup && !corpoMensagem.toLowerCase().includes('@bot')) return;
    if (!perguntaNormalizada) return;
    salvarLog(nomeContato, perguntaNormalizada);

    // 📄 Envio do regimento interno em PDF, se solicitado
    if (perguntaNormalizada.includes('regimento interno') || perguntaNormalizada.includes('regimento')) {
      const linkRegimento = 'https://drive.google.com/uc?export=download&id=109UcJEbPqKng93fKUA0osewehd5ivElH';
      try {
        await sock.sendMessage(jid, {
          document: fs.createReadStream('regimento.pdf'),
          mimetype: 'application/pdf',
          fileName: 'Regimento Interno CIPT.pdf'
        });
      } catch (err) {
        console.error('❌ Erro ao enviar regimento local:', err.message);
        await sock.sendMessage(jid, { text: `Você pode baixar o regimento interno aqui: ${linkRegimento}` });
      }
      return;
    }

    const agora = Date.now();
    usuarios[jid] = { ...(usuarios[jid] || {}), lastActive: agora };
    await sock.sendPresenceUpdate('composing', jid);
    await delay(1500);

    try {
      if (usuarios[jid]?.chamadoPendente) {
        if (perguntaNormalizada === "sim") {
          const protocolo = "CH-" + Date.now().toString().slice(-5);
          const sucesso = await registrarChamado({
            protocolo, nome: nomeContato, telefone: jid.split("@")[0],
            descricao: usuarios[jid].chamadoPendente.descricao,
            categoria: usuarios[jid].chamadoPendente.categoria,
            status: "Aberto", usuarioJid: jid
          });
          
          if (sucesso) {
            await sock.sendMessage(jid, { text: `✅ Chamado registrado com sucesso!\n\n*Protocolo:* ${protocolo}\n*Categoria:* ${usuarios[jid].chamadoPendente.categoria}\n\nA equipe de suporte já foi notificada.` });
            if (GRUPO_SUPORTE_JID) {
              const responsaveis = routingMap[usuarios[jid].chamadoPendente.categoria] || [];
              let nomesResponsaveis = responsaveis.map(r => r.nome).join(' e ');
              const logGrupo = `[LOG] Novo chamado de *${usuarios[jid].chamadoPendente.categoria}* (CH-${protocolo}). Notificação enviada para: ${nomesResponsaveis}.`;
              await sock.sendMessage(GRUPO_SUPORTE_JID, { text: logGrupo });
              if (responsaveis.length > 0) {
                for (const responsavel of responsaveis) {
                  const notificacaoPrivada = `🔔 *Nova atribuição de chamado para você.*\n\n*Protocolo:* ${protocolo}\n*Categoria:* ${usuarios[jid].chamadoPendente.categoria}\n*Descrição:* ${usuarios[jid].chamadoPendente.descricao}\n\nPara atualizar, responda a esta mensagem com o número do chamado + um dos comandos:\n1 - Em Atendimento\n2 - Concluído\n3 - Rejeitado\n\n*Exemplo:*\n${protocolo} - 1`;
                  await sock.sendMessage(responsavel.jid, { text: notificacaoPrivada });
                }
              }
            }
          } else {
            await sock.sendMessage(jid, { text: `😥 Desculpe, não consegui registrar seu chamado na planilha, mas já notifiquei a equipe sobre o problema. Por favor, aguarde.` });
            if (GRUPO_SUPORTE_JID) {
              await sock.sendMessage(GRUPO_SUPORTE_JID, { text: `🚨 *ATENÇÃO, EQUIPE!* Falha ao registrar o chamado de ${nomeContato} na planilha. Verifiquem os logs.` });
            }
          }
          delete usuarios[jid].chamadoPendente;
          return;
        } else if (perguntaNormalizada === "não" || perguntaNormalizada === "nao") {
          await sock.sendMessage(jid, { text: "Ok, o registro do chamado foi cancelado." });
          delete usuarios[jid].chamadoPendente;
          return;
        }
      }

      const darNumero = pergunta.match(/^\d{4,}$/);
      if (darNumero) {
        const darId = darNumero[0];
        const msisdn = msisdnFromJid(jid);
        try {
          const { linha_digitavel, pdf_url, competencia, vencimento, valor, msisdnCorrigido } = await apiEmitDar(darId, msisdn);
          usuarios[jid].msisdnCorrigido = msisdnCorrigido;
          if (!pdf_url) console.error(`pdf_url ausente para DAR ${darId}`);
          const msg = [
            `DAR ${darId}`,
            `Competência: ${competencia}`,
            `Vencimento: ${brDate(vencimento)}`,
            `Valor: ${brMoney(valor)}`,
            `Linha digitável: ${linha_digitavel}`,
            'O PDF pode ser baixado através do Portal do CIPT.'
          ].join('\n');
          await sock.sendMessage(jid, { text: msg });
        } catch (e) {
          await sock.sendMessage(jid, { text: `Não foi possível recuperar a DAR ${darId}: ${e.message}` });
        }
        return;
      }

      const classificacao = await classificarChamado(perguntaNormalizada);
      if (classificacao.ehChamado === "SIM") {
        usuarios[jid] = { ...(usuarios[jid] || {}), chamadoPendente: { descricao: corpoMensagem, categoria: classificacao.categoria } };
        await sock.sendMessage(jid, { text: `Identifiquei que sua mensagem parece ser uma solicitação de suporte. Confirma o registro do chamado abaixo?\n\n*Descrição:* _${corpoMensagem}_\n*Categoria Sugerida:* ${classificacao.categoria}\n\nResponda com *"Sim"* para confirmar ou *"Não"* para cancelar.` });
        return;
      }
      
      const saudacoes = ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite"];
      if (saudacoes.includes(perguntaNormalizada)) {
        await sock.sendMessage(jid, { text: gerarSaudacao(nomeContato) });
        return;
      }
      
      historicoUsuarios[jid] = historicoUsuarios[jid] || [];
      historicoUsuarios[jid].push({ role: "user", content: perguntaNormalizada });
      if (historicoUsuarios[jid].length > LIMITE_HISTORICO) historicoUsuarios[jid].splice(0, historicoUsuarios[jid].length - LIMITE_HISTORICO);

      const trechos = await buscarTrechosRelevantes(perguntaNormalizada);
      const isFollowUp = ehFollowUp(perguntaNormalizada);
      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: getCiptPrompt(nomeContato, EMAIL_SUPORTE, SITE_OFICIAL) },
          ...historicoUsuarios[jid],
          { role: "user", content: `Com base no contexto, responda à minha última pergunta: "${perguntaNormalizada}". Contexto: """${trechos}"""` },
          ...(isFollowUp ? [{ role: "system", content: "Isto é um follow-up. Responda de forma direta e concisa." }] : [])
        ],
        temperature: 0.25,
        max_tokens: 700
      });
      let resposta = completion.choices[0].message.content.trim();
      historicoUsuarios[jid].push({ role: "assistant", content: resposta });

      if (!contatosEnviados[jid]) {
        const decisao = await client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: "A resposta do assistente indica necessidade de contato humano (reservas, problemas administrativos)? Responda só SIM ou NÃO." }, { role: "user", content: `Usuário: ${perguntaNormalizada}\nAssistente: ${resposta}` }], temperature: 0, max_tokens: 5 });
        if (decisao.choices[0].message.content.trim().toUpperCase().includes("SIM")) {
            if (resposta.toLowerCase().includes("auditório")) await enviarContato(sock, jid, "SUPTI - Reservas do Auditório", "558287145526");
            else if (resposta.toLowerCase().includes("sala de reunião")) await enviarContato(sock, jid, "Portaria do Centro de Inovação", "558288334368");
            contatosEnviados[jid] = true;
        }
      }
      
      const despedidas = ["obrigado", "obrigada", "valeu", "tchau", "até mais", "flw"];
      if(!despedidas.includes(perguntaNormalizada)) {
        resposta += gerarSugestoes();
      } else {
         delete usuarios[jid];
         if (timersEncerramento[jid]) clearTimeout(timersEncerramento[jid]);
         delete timersEncerramento[jid];
         delete historicoUsuarios[jid];
         delete contatosEnviados[jid];
      }
      
      await sock.sendMessage(jid, { text: resposta });

      usuarios[jid].lastActive = agora;
      if (timersEncerramento[jid]) clearTimeout(timersEncerramento[jid]);
      timersEncerramento[jid] = setTimeout(async () => {
        if (!usuarios[jid] || Date.now() - usuarios[jid].lastActive >= TEMPO_ENCERRAMENTO) {
          await sock.sendMessage(jid, { text: "Este atendimento foi encerrado por inatividade. Se precisar de algo mais, é só me chamar! 👋" });
          delete usuarios[jid];
          delete timersEncerramento[jid];
          delete historicoUsuarios[jid];
          delete contatosEnviados[jid];
        }
      }, TEMPO_ENCERRAMENTO);

    } catch (err) {
      console.error('❌ Erro no processamento da mensagem:', err.message, err.stack);
      await sock.sendMessage(jid, { text: "Peço desculpas, ocorreu um erro interno. Tente novamente." });
    }
  });

  return sock; // <- garante retorno
}

async function main() {
  await gerarOuCarregarEmbeddings();
  await verificarColunaTelefoneCobranca();
  const wSock = await startBot();

  const SEND_TOKEN = process.env.WHATSAPP_BOT_TOKEN || process.env.BOT_SHARED_KEY;
  app.post('/send', async (req, res) => {
    let { msisdn, text } = req.body || {};
    msisdn = onlyDigits(msisdn);

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const authOk = !!SEND_TOKEN && token === SEND_TOKEN;

    console.log(sanitizeSensitive(`POST /send msisdn=${msisdn || ''} auth=${authOk ? 'ok' : 'falha'}`));

    if (!authOk) {
      console.warn(sanitizeSensitive(`POST /send falha de autenticação msisdn=${msisdn || ''}`));
      return res.status(401).json({ ok: false, erro: 'não autorizado' });
    }

    try {
      if (!msisdn) {
        return res.status(400).json({ ok: false, erro: 'msisdn inválido' });
      }
      if (!msisdn.startsWith('55')) msisdn = '55' + msisdn;
      const jid = msisdn + '@s.whatsapp.net';

      await wSock.sendMessage(jid, { text });
      return res.json({ ok: true });
    } catch (erro) {
      console.error(sanitizeSensitive(`Erro ao enviar mensagem para ${msisdn}: ${erro.message}`));
      return res.status(500).json({ ok: false, erro: erro.message });
    }
  });

  app.get('/', (req, res) => res.send('✅ Bot do CIPT está online!'));
  app.listen(process.env.PORT || 10000, () => {
    console.log(`🌐 Servidor web rodando na porta ${process.env.PORT || 10000}`);
    if(process.env.RENDER_URL) {
      console.log(`🚀 Iniciando ping de keep-alive para ${process.env.RENDER_URL}`);
      setInterval(() => { axios.get(process.env.RENDER_URL).catch(err => console.error("⚠️ Erro no keep-alive:", err.message)); }, 14 * 60 * 1000);
      
      console.log("⏰ Agendador de relatórios de pendências ativado para 11:30 e 16:00.");
      cron.schedule('30 11,16 * * 1-5', () => {
        console.log('[CRON] Executando verificação de chamados pendentes...');
        enviarRelatorioDePendencias(wSock);
      }, {
        scheduled: true,
        timezone: "America/Maceio"
      });
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = { apiEmitDar };

// (sem lógica de desligamento gracioso)
