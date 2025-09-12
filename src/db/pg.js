// src/db/pg.js
import pg from 'pg';
import { URL as NodeURL } from 'url';

const env = process.env;
const DEBUG = /^(1|true|yes)$/i.test(String(env.DEBUG_DB || ''));

function ts() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
function log(...a)   { console.log(`[db ${ts()}]`, ...a); }
function warn(...a)  { console.warn(`[db ${ts()}]`, ...a); }
function error(...a) { console.error(`[db ${ts()}]`, ...a); }
function dlog(...a)  { if (DEBUG) console.log(`[db:debug ${ts()}]`, ...a); }
const safe = (u) => String(u || '').replace(/:[^@/]+@/, '://***:***@');

/** Constrói uma URL a partir de PG* se não houver DATABASE_URL */
function buildUrlFromPgVars() {
  const host = env.PGHOST;
  const port = env.PGPORT || '5432';
  const user = env.PGUSER || 'postgres';
  const pass = env.PGPASSWORD || '';
  const db   = env.PGDATABASE || 'postgres';
  if (!host) return '';
  const passEnc = encodeURIComponent(pass);
  // força sslmode=require; o objeto ssl controla verificação
  return `postgres://` +
         `${encodeURIComponent(user)}:${passEnc}` +
         `@${host}:${port}/${encodeURIComponent(db)}?sslmode=require`;
}

/** Normaliza esquemas e limpa query params conflitantes */
function normalizePgUrl(rawInput) {
  let raw = String(rawInput || '').replace(/^['"]|['"]$/g, '').trim();

  // remove esquemas duplicados e unifica para postgres://
  raw = raw.replace(/^postgresql:\/\/postgres:\/\//i, 'postgres://');
  raw = raw.replace(/^postgres:\/\/postgres:\/\//i,    'postgres://');
  raw = raw.replace(/^postgresql:\/\//i,               'postgres://');

  // tenta parsear e remover sslmode da query (vamos usar objeto ssl)
  try {
    const u = new NodeURL(raw);
    u.searchParams.delete('sslmode');
    return {
      cleanUrl: u.toString(),
      host: u.hostname || null,
      port: u.port || '5432',
      pathname: u.pathname || null,
    };
  } catch (e) {
    warn('Não consegui parsear DATABASE_URL:', e.message);
    return { cleanUrl: raw, host: null, port: null, pathname: null };
  }
}

/** SSL adequado ao host */
function sslForHost(hostname) {
  // Supabase: SNI + sem validar cadeia (pooler usa intermediário)
  if (/\.(supabase\.co|supabase\.com)$/i.test(hostname || '')) {
    return {
      rejectUnauthorized: false,
      servername: hostname,
      checkServerIdentity: () => undefined,
    };
  }

  // Outros provedores: honrar PGSSLMODE se desejado
  const mode = String(env.PGSSLMODE || 'require').trim().toLowerCase();
  if (mode === 'disable' || mode === 'allow') return false; // sem TLS
  if (mode === 'no-verify') return { rejectUnauthorized: false, servername: hostname };
  return { rejectUnauthorized: true, servername: hostname }; // require
}

/** ---- Resolução de URL de conexão ---- */
const RAW_URL_INPUT =
  (env.DATABASE_URL && String(env.DATABASE_URL)) ||
  (env.POSTGRES_URL && String(env.POSTGRES_URL)) ||
  (env.POSTGRES_PRISMA_URL && String(env.POSTGRES_PRISMA_URL)) ||
  (env.POSTGRES_URL_NON_POOLING && String(env.POSTGRES_URL_NON_POOLING)) ||
  buildUrlFromPgVars();

if (!RAW_URL_INPUT) error('DATABASE_URL ausente (ou PG* não definidos)');

const { cleanUrl: CLEAN_URL, host: HOSTNAME, port: PORT, pathname } = normalizePgUrl(RAW_URL_INPUT);

log('DB target -> host:', HOSTNAME, 'port:', PORT, 'path:', pathname);

/** Aviso útil: serverless + Supabase devem usar POOLER 6543 */
if (process.env.VERCEL && /\.supabase\.co$/i.test(HOSTNAME || '') && PORT === '5432') {
  warn('Você está usando host direto 5432 no Vercel. Prefira o POOLER 6543 (aws-1-sa-east-1.pooler.supabase.com).');
}

const poolCfg = {
  connectionString: CLEAN_URL,
  ssl: sslForHost(HOSTNAME),
  max: Number(env.PG_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: Number(env.DB_CONN_TIMEOUT_MS || 2000),
  keepAlive: true,
  // statement_timeout: 0,
  // query_timeout: 0,
  // idle_in_transaction_session_timeout: 0,
};

dlog('Pool config resumida:', {
  url: safe(CLEAN_URL),
  ssl: poolCfg.ssl && typeof poolCfg.ssl === 'object'
    ? { rejectUnauthorized: poolCfg.ssl.rejectUnauthorized, servername: poolCfg.ssl.servername }
    : poolCfg.ssl,
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
  // log sem credenciais
  try {
    const u = new NodeURL(CLEAN_URL);
    log('Conectando ao Postgres ->', `${u.hostname}:${u.port || ''}${u.pathname}`);
  } catch {
    log('Conectando ao Postgres ->', safe(CLEAN_URL));
  }

  const p = new pg.Pool(poolCfg);

  // Eventos do pool
  p.on('connect', () => dlog('pool: connect (nova conexão criada)'));
  p.on('acquire', () => dlog('pool: acquire (cliente entregue ao caller)'));
  p.on('remove', () => dlog('pool: remove (cliente removido do pool)'));
  p.on('error', (e) => error('pool: error ->', describeError(e)));

  // Wrap de query com medição/trace simples
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

  // Ping inicial
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
