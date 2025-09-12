// src/db/pg.js
import pg from 'pg';
import { URL as NodeURL } from 'url';

const env = process.env;
const DEBUG = /^(1|true|yes)$/i.test(String(env.DEBUG_DB || ''));

function ts() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
function log(...a)     { console.log(`[db ${ts()}]`, ...a); }
function warn(...a)    { console.warn(`[db ${ts()}]`, ...a); }
function error(...a)   { console.error(`[db ${ts()}]`, ...a); }
function dlog(...a)    { if (DEBUG) console.log(`[db:debug ${ts()}]`, ...a); }
const safe = (u) => String(u).replace(/:[^@/]+@/, '://***:***@');

const RAW_URL = String(env.DATABASE_URL || '').replace(/^['"]|['"]$/g, '');
if (!RAW_URL) error('DATABASE_URL ausente');

let parsed = null;
try {
  parsed = new NodeURL(RAW_URL);
  dlog('DATABASE_URL parsed:', {
    protocol: parsed.protocol,
    host: parsed.hostname,
    port: parsed.port,
    pathname: parsed.pathname,
    search: parsed.search,
  });
} catch (e) {
  warn('Não consegui parsear DATABASE_URL:', e.message);
}

// Limpa sslmode da URL e extrai host/porta só para log
let CLEAN_URL = RAW_URL;
let HOSTNAME = null;
let PORT = null;
try {
  const u = new NodeURL(RAW_URL);
  u.searchParams.delete('sslmode');   // evita conflito com objeto ssl abaixo
  CLEAN_URL = u.toString();
  HOSTNAME = u.hostname;
  PORT = u.port || '5432';
} catch {}

log('DB target -> host:', HOSTNAME, 'port:', PORT, 'path:', parsed?.pathname);

function sslForHost(hostname) {
  // Para Supabase, usar SNI e desabilitar verificação da cadeia (pooler usa cert intermediário/self-signed)
  if (/\.(supabase\.co|supabase\.com)$/i.test(hostname || '')) {
    return {
      rejectUnauthorized: false,
      servername: hostname,
      // evita Node tentar validar CN/SAN e derrubar com SELF_SIGNED_CERT_IN_CHAIN
      checkServerIdentity: () => undefined,
    };
  }

  // Para outros provedores, respeite PGSSLMODE (disable/allow/no-verify/require)
  const mode = String(env.PGSSLMODE || 'require').trim().toLowerCase();
  if (mode === 'disable' || mode === 'allow') return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false, servername: hostname };
  return { rejectUnauthorized: true, servername: hostname };
}

const poolCfg = {
  connectionString: CLEAN_URL,
  ssl: sslForHost(HOSTNAME),
  // NÃO forçar IPv4 aqui (deixe o Node resolver melhor rota)
  max: Number(env.PG_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: Number(env.DB_CONN_TIMEOUT_MS || 2000),
  keepAlive: true,

  // timeouts opcionais do driver (0 = off). Descomente se quiser:
  // statement_timeout: 0,
  // query_timeout: 0,
  // idle_in_transaction_session_timeout: 0,
};

dlog('Pool config resumida:', {
  url: safe(CLEAN_URL),
  ssl: poolCfg.ssl && typeof poolCfg.ssl === 'object'
    ? { rejectUnauthorized: poolCfg.ssl.rejectUnauthorized, servername: poolCfg.ssl.servername }
    : poolCfg.ssl, // false quando ssl desabilitado
  max: poolCfg.max,
  connTimeoutMs: poolCfg.connectionTimeoutMillis,
  idleTimeoutMs: poolCfg.idleTimeoutMillis,
  keepAlive: poolCfg.keepAlive,
});

let pool = null;
let healthTimer = null;

function describeError(e) {
  return {
    message: e?.message,
    code: e?.code,
    errno: e?.errno,
    detail: e?.detail,
    where: e?.where,
    schema: e?.schema,
    table: e?.table,
    column: e?.column,
    dataType: e?.dataType,
    address: e?.address,
    port: e?.port,
    stack: e?.stack,
  };
}

async function connectOnce() {
  const started = Date.now();
  log('Conectando ao Postgres...', safe(CLEAN_URL));
  const p = new pg.Pool(poolCfg);

  // Eventos do pool
  p.on('connect', () => dlog('pool: connect (nova conexão criada)'));
  p.on('acquire', () => dlog('pool: acquire (cliente entregue ao caller)'));
  p.on('remove', () => dlog('pool: remove (cliente removido do pool)'));
  p.on('error', (e) => error('pool: error ->', describeError(e)));

  // Wrap para logar tempo de query
  const _query = p.query.bind(p);
  p.query = async (text, params) => {
    const qid = Math.random().toString(36).slice(2, 8);
    const start = Date.now();
    if (DEBUG) {
      const short = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      dlog(`Q#${qid} ->`, short, params && params.length ? `params=${JSON.stringify(params).slice(0, 500)}` : '');
    }
    try {
      const res = await _query(text, params);
      if (DEBUG) dlog(`Q#${qid} ok (${Date.now() - start}ms) rows=${res?.rowCount}`);
      return res;
    } catch (e) {
      const ms = Date.now() - start;
      error(`Q#${qid} FAIL (${ms}ms):`, describeError(e));
      throw e;
    }
  };

  // Teste de conexão (simples e rápido)
  try {
    const pingStart = Date.now();
    await p.query('SELECT 1');
    log(`Conectado (${Date.now() - started}ms), ping=${Date.now() - pingStart}ms`);
  } catch (e) {
    error('Falhou ping inicial:', describeError(e));
    try { await p.end(); } catch {}
    throw e;
  }

  return p;
}

async function connectWithRetry() {
  const tries = Math.max(1, Number(env.DB_CONNECT_TRIES || 1));
  const backoffMs = Math.max(0, Number(env.DB_RETRY_BASE_MS || 0));
  let lastErr = null;

  for (let i = 1; i <= tries; i++) {
    try {
      return await connectOnce();
    } catch (e) {
      lastErr = e;
      warn(`Tentativa ${i}/${tries} falhou:`, e.code || e.message);
      if (i < tries && backoffMs) {
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr || new Error('Falha ao conectar no Postgres');
}

function startHealth(p) {
  const ms = Number(env.DB_HEALTH_MS || 15000);
  if (!ms) {
    dlog('Health-check desabilitado (DB_HEALTH_MS=0)');
    return;
  }
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    const started = Date.now();
    try {
      await p.query('SELECT 1');
      dlog(`health ok (${Date.now() - started}ms)`);
    } catch (e) {
      error('health FAIL:', describeError(e));
    }
  }, ms);
}

export async function getPool() {
  if (pool) return pool;
  try {
    pool = await connectWithRetry();
    startHealth(pool);
    return pool;
  } catch (e) {
    error('[db] initial check failed:', describeError(e));
    throw e;
  }
}

export async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}

// Log rápido de variáveis relevantes (sanitizado)
dlog('ENV resumo:', {
  PGSSLMODE: env.PGSSLMODE || 'require',
  PG_MAX: env.PG_MAX || 10,
  DB_CONN_TIMEOUT_MS: env.DB_CONN_TIMEOUT_MS || 2000,
  DB_HEALTH_MS: env.DB_HEALTH_MS || 15000,
  DB_CONNECT_TRIES: env.DB_CONNECT_TRIES || 1,
  DB_RETRY_BASE_MS: env.DB_RETRY_BASE_MS || 0,
  DEBUG_DB: DEBUG,
});
