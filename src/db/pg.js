// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL as NodeURL } from 'url';

const env = process.env;

// ===== 1) Coleta URLs sem mexer em ENV: pooler primeiro, direct só se não houver pooler
const poolerURL = [
  env.DATABASE_URL_POOLING,
  env.POSTGRES_PRISMA_URL,
  env.POSTGRES_URL,
].find(v => v && v.trim()) || '';

const altPooler = (env.DATABASE_URL_POOLING_ALT || '').trim();

const directURL = [
  env.DATABASE_URL,
  env.POSTGRES_URL_NON_POOLING,
].find(v => v && v.trim()) || '';

const HAS_POOLER = Boolean(poolerURL || altPooler);

// ===== 2) Normaliza (porta correta e sslmode=require)
function normalize(url) {
  if (!url) return null;
  try {
    const u = new NodeURL(url);
    if (/pooler\.supabase\.com$/i.test(u.hostname)) u.port = '6543';   // pooler sempre 6543
    if (/\.supabase\.co$/i.test(u.hostname) && !u.port) u.port = '5432'; // direct padrão 5432
    if (!/[?&]sslmode=/.test(u.search)) u.search += (u.search ? '&' : '?') + 'sslmode=require';
    return u.toString();
  } catch {
    return url;
  }
}

// Ordem final: (pooler → altPooler) OU (direct sozinho se não houver pooler)
const urlsRaw = (HAS_POOLER ? [poolerURL, altPooler] : [directURL])
  .map(normalize)
  .filter(Boolean);

// remove duplicadas preservando ordem
const seen = new Set();
const urls = urlsRaw.filter(u => (seen.has(u) ? false : (seen.add(u), true)));

if (urls.length === 0) {
  console.error('[pg] nenhuma DATABASE_URL definida nas ENVs');
}

// ===== 3) SSL (no-verify para supabase) + SNI (hostname original)
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

// ===== 4) Resolve IPv4 de verdade (evita conexões IPv6 que dão ENETUNREACH)
const dnp = dns.promises;
async function toIPv4URL(url) {
  try {
    const u = new NodeURL(url);
    // Força apenas p/ domínios do Supabase
    if (!/\.(supabase\.co|supabase\.com)$/i.test(u.hostname)) return { url, sni: undefined };
    const { address } = await dnp.lookup(u.hostname, { family: 4, hints: dns.ADDRCONFIG });
    const originalHost = u.hostname;
    u.hostname = address; // passa IP v4 literal
    // mantém porta/user/pass/db/query
    return { url: u.toString(), sni: originalHost };
  } catch {
    return { url, sni: undefined };
  }
}

// ===== 5) Config do Pool
function cfg(url, sni) {
  return {
    connectionString: url,
    ssl: sslFor(url, sni),
    // lookup não é mais crucial pois já trocamos host por IPv4, mas manter não atrapalha:
    lookup: (hostname, _opts, cb) => dns.lookup(hostname, { family: 4, hints: dns.ADDRCONFIG }, cb),
    max: Number(env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  };
}

let pool;
let reconnectTimer = null;

function safe(url) {
  return String(url).replace(/:[^@]+@/, '://***:***@');
}

// Erros transitórios que merecem retry
const TRANSIENT_CODES = new Set([
  '57P01','57P02','57P03','08006',   // PG
  'ECONNRESET','ETIMEDOUT','EPIPE','ENETUNREACH','ECONNREFUSED', // Node
]);

function isTransient(err) {
  const code = String(err.code || err.errno || '').toUpperCase();
  const msg  = String(err.message || '');
  return TRANSIENT_CODES.has(code) || /Connection terminated|read ECONNRESET/i.test(msg);
}

// Conecta 1x numa URL (resolvendo IPv4 e mantendo SNI)
async function connectOnce(url) {
  const { url: v4url, sni } = await toIPv4URL(url);
  const p = new pg.Pool(cfg(v4url, sni));
  try {
    await p.query('SELECT 1');
    console.log('[pg] connected on', safe(v4url));
    // Se o pool quebrar depois, recriaremos
    p.on('error', (e) => {
      console.error('[pg] pool error', e.code || e.message || e);
      pool = null;
      scheduleReconnect();
    });
    return p;
  } catch (e) {
    console.log('[pg] failed on', safe(v4url), '->', e.code || e.errno || e.message || e);
    await p.end().catch(() => {});
    throw e;
  }
}

// Tenta conectar com backoff por URL (5 tentativas por URL)
async function connectWithRetry(urlList) {
  const PER_URL_TRIES = 5;
  const BASE_DELAY = 500;

  let lastErr = null;

  for (const url of urlList) {
    for (let i = 0; i < PER_URL_TRIES; i++) {
      try {
        return await connectOnce(url);
      } catch (e) {
        lastErr = e;
        if (i < PER_URL_TRIES - 1 && isTransient(e)) {
          const delay = BASE_DELAY * Math.pow(2, i); // 0.5s → 1s → 2s → 4s → 8s
          console.warn('[pg] transient connect error, retrying', i + 1, 'of', PER_URL_TRIES, 'in', delay, 'ms');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        break; // vai para a próxima URL
      }
    }
  }
  throw lastErr || new Error('All database URLs failed');
}

// Agenda tentativas periódicas até reconectar
function scheduleReconnect() {
  if (reconnectTimer) return;
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
  }, 5_000);
}

export async function getPool() {
  if (!pool) {
    console.log('[pg] will try', JSON.stringify(urls, null, 2));
    try {
      pool = await connectWithRetry(urls);
    } catch (e) {
      console.error('[pg] initial connect failed:', e.code || e.message);
      // não derruba o processo; agenda reconexão e propaga erro
      scheduleReconnect();
      throw e;
    }
  }
  return pool;
}

// ===== 6) Query com retry 1x em falha transitória
export async function query(text, params) {
  try {
    const p = await getPool();
    return await p.query(text, params);
  } catch (e) {
    if (isTransient(e)) {
      console.warn('[pg] transient query error, recreating pool and retrying once');
      pool = null;
      scheduleReconnect();
      const p = await getPool();
      return await p.query(text, params);
    }
    throw e;
  }
}
