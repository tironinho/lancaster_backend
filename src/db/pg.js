// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL as NodeURL } from 'url';

const env = process.env;

// helpers
const clean = (s) =>
  s && typeof s === 'string' ? s.trim().replace(/^['"]+|['"]+$/g, '') : s;

// URLs: pooler + direct (ordem configurável)
const poolerURL = [
  clean(env.DATABASE_URL_POOLING),
  clean(env.POSTGRES_PRISMA_URL),
  clean(env.POSTGRES_URL), // alguns projetos usam isso p/ pooler
].find(Boolean) || '';

const altPooler = clean(env.DATABASE_URL_POOLING_ALT || '');

const directURL = [
  clean(env.DATABASE_URL),
  clean(env.POSTGRES_URL_NON_POOLING),
].find(Boolean) || '';

function normalize(url) {
  if (!url) return null;
  try {
    const u = new NodeURL(url);
    // NÃO force porta do pooler; use a que vier do dashboard (5432 session, 6543 transaction)
    // Se for supabase .co sem porta (caso raro), assume 5432
    if (/\.supabase\.co$/i.test(u.hostname) && !u.port) u.port = '5432';
    if (!/[?&]sslmode=/.test(u.search)) {
      u.search += (u.search ? '&' : '?') + 'sslmode=require';
    }
    return u.toString();
  } catch {
    return url;
  }
}

// ordem: pooler → (direct como fallback)
const preferDirect = env.DB_PREFER_DIRECT === '1' || env.DB_DISABLE_POOLER === '1';
const onlyDirect   = env.DB_ONLY_DIRECT === '1';

const ordered = onlyDirect
  ? [directURL]
  : (preferDirect ? [directURL, poolerURL, altPooler] : [poolerURL, altPooler, directURL]);

const urlsRaw = ordered.map(normalize).filter(Boolean);

// remove duplicadas preservando ordem
const seen = new Set();
const urls = urlsRaw.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));

if (!urls.length) console.error('[pg] nenhuma DATABASE_URL definida nas ENVs');

// SSL + SNI
function sslFor(url, sniHost) {
  try {
    const u = new NodeURL(url);
    if (/\.(supabase\.co|supabase\.com)$/i.test(u.hostname)) {
      return { rejectUnauthorized: false, servername: sniHost || u.hostname };
    }
  } catch {}
  const mode = String(env.PGSSLMODE || 'require').trim().toLowerCase();
  if (mode === 'disable' || mode === 'allow') return false;
  return { rejectUnauthorized: mode !== 'no-verify', servername: sniHost };
}

// força IPv4 em qualquer resolução interna
const CONN_TIMEOUT_MS = Number(env.DB_CONN_TIMEOUT_MS || 2000);
function cfg(url, sni) {
  return {
    connectionString: url,
    ssl: sslFor(url, sni),
    lookup: (hostname, _opts, cb) =>
      dns.lookup(hostname, { family: 4, hints: dns.ADDRCONFIG }, cb),
    max: Number(env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: CONN_TIMEOUT_MS,
    keepAlive: true,
  };
}

let pool;
let reconnectTimer = null;

function safe(url) {
  return String(url).replace(/:[^@]+@/, '://***:***@');
}

const TRANSIENT_CODES = new Set([
  '57P01','57P02','57P03','08006',
  'ECONNRESET','ETIMEDOUT','EPIPE','ENETUNREACH','ECONNREFUSED',
]);

function isTransient(err) {
  const code = String(err.code || err.errno || '').toUpperCase();
  const msg  = String(err.message || '');
  return TRANSIENT_CODES.has(code) || /Connection terminated|read ECONNRESET/i.test(msg);
}

// aqui não trocamos hostname por IP: o pooler já entrega IPv4
async function connectOnce(url) {
  let lastErr = null;
  // usa SNI = host original
  let sni = null;
  try { sni = new NodeURL(url).hostname; } catch {}
  const p = new pg.Pool(cfg(url, sni));
  try {
    await p.query('SELECT 1');
    console.log('[pg] connected on', safe(url));
    p.on('error', (e) => {
      console.error('[pg] pool error', e.code || e.message || e);
      pool = null;
      scheduleReconnect();
    });
    return p;
  } catch (e) {
    lastErr = e;
    console.log('[pg] failed on', safe(url), '->', e.code || e.errno || e.message || e);
    await p.end().catch(() => {});
  }
  throw lastErr || new Error('connect failed');
}

async function connectWithRetry(urlList) {
  const PER_URL_TRIES = Math.max(1, Number(env.DB_PER_URL_TRIES || 1));
  const BASE_DELAY = Math.max(0, Number(env.DB_RETRY_BASE_MS || 0));

  let lastErr = null;

  for (const url of urlList) {
    for (let i = 0; i < PER_URL_TRIES; i++) {
      try {
        return await connectOnce(url);
      } catch (e) {
        lastErr = e;
        if (i < PER_URL_TRIES - 1 && isTransient(e) && BASE_DELAY > 0) {
          await new Promise((r) => setTimeout(r, BASE_DELAY));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error('All database URLs failed');
}

function scheduleReconnect() {
  if (env.DB_DISABLE_BG_RECONNECT === '1') return;
  if (reconnectTimer) return;
  const PERIOD = Math.max(10000, Number(env.DB_BG_RECONNECT_MS || 15000));
  reconnectTimer = setInterval(async () => {
    if (pool) { clearInterval(reconnectTimer); reconnectTimer = null; return; }
    try {
      console.warn('[pg] trying background reconnect...');
      pool = await connectWithRetry(urls);
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      console.log('[pg] reconnected');
    } catch (e) {
      console.warn('[pg] background reconnect failed:', e.code || e.message);
    }
  }, PERIOD);
}

export async function getPool() {
  if (!pool) {
    console.log('[pg] will try', JSON.stringify(urls.map(safe), null, 2));
    try {
      pool = await connectWithRetry(urls);
    } catch (e) {
      console.error('[pg] initial connect failed:', e.code || e.message);
      scheduleReconnect();
      throw e;
    }
  }
  return pool;
}

export async function query(text, params) {
  try {
    const p = await getPool();
    return await p.query(text, params);
  } catch (e) {
    if (isTransient(e)) {
      console.warn('[pg] transient query error; not retrying (lean mode)');
    }
    throw e;
  }
}
