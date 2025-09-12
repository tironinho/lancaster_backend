// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
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

function sslFor(url) {
  const mode = String(env.PGSSLMODE || 'require').trim().toLowerCase();
  let servername = null;
  try { servername = new NodeURL(url).hostname; } catch {}
  // Supabase: manter SNI e evitar chain error
  if (/\.(supabase\.co|supabase\.com)$/i.test(servername || '')) {
    const cfg = { rejectUnauthorized: mode !== 'no-verify', servername };
    // Para ver detalhes do handshake (apenas log; não bloqueia)
    cfg.checkServerIdentity = (host, cert) => {
      dlog('TLS checkServerIdentity host=', host, 'subject=', cert?.subject, 'issuer=', cert?.issuer);
      return undefined; // não rejeita
    };
    return cfg;
  }
  if (mode === 'disable' || mode === 'allow') return false;
  return { rejectUnauthorized: mode !== 'no-verify', servername };
}

// DNS lookup only-IPv4 + logs
const lookup = (hostname, _opts, cb) => {
  const started = Date.now();
  dlog('DNS lookup (IPv4) start:', hostname);
  dns.lookup(hostname, { family: 4, hints: dns.ADDRCONFIG }, (err, addr, fam) => {
    const ms = Date.now() - started;
    if (err) {
      warn('DNS lookup error:', hostname, err.code || err.message, `(${ms}ms)`);
      return cb(err);
    }
    dlog('DNS lookup ok:', hostname, '->', addr, 'fam=', fam, `(${ms}ms)`);
    cb(null, addr, fam);
  });
};

const poolCfg = {
  connectionString: RAW_URL,                 // NÃO muda host/porta
  ssl: sslFor(RAW_URL),
  lookup,                                    // força IPv4
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
  url: safe(RAW_URL),
  ssl: poolCfg.ssl && { rejectUnauthorized: poolCfg.ssl.rejectUnauthorized, servername: poolCfg.ssl.servername },
  max: poolCfg.max,
  connTimeoutMs: poolCfg.connectionTimeoutMillis,
  idleTimeoutMs: poolCfg.idleTimeoutMillis,
  keepAlive: poolCfg.keepAlive,
});

let pool = null;
let healthTimer = null;

function describeError(e) {
  const out = {
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
  return out;
}

async function connectOnce() {
  const started = Date.now();
  log('Conectando ao Postgres...', safe(RAW_URL));
  const p = new pg.Pool(poolCfg);

  // Eventos do pool
  p.on('connect', (client) => dlog('pool: connect (nova conexão criada)'));
  p.on('acquire', () => dlog('pool: acquire (cliente entregue ao caller)'));
  p.on('remove', () => dlog('pool: remove (cliente removido do pool)'));
  p.on('error', (e) => error('pool: error ->', describeError(e)));

  // Instrumenta queries para medir tempo
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

  // Teste de conexão
  try {
    const pingStart = Date.now();
    const r = await p.query('SELECT version(), current_database(), inet_server_addr()::text as addr, inet_server_port() as port');
    const ms = Date.now() - pingStart;
    const row = r?.rows?.[0] || {};
    log(`Conectado (${Date.now() - started}ms) db=${row.current_database} server=${row.addr}:${row.port}`);
    dlog('server version:', row.version);
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
