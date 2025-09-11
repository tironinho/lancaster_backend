// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL as NodeURL } from 'url';

const env = process.env;

// ===== helpers
const clean = (s) =>
  s && typeof s === 'string' ? s.trim().replace(/^['"]+|['"]+$/g, '') : s;

// ===== 1) Coleta URLs (limpando aspas) — pooler + direct (sempre haverá fallback)
const poolerURL = [
  clean(env.DATABASE_URL_POOLING),
  clean(env.POSTGRES_PRISMA_URL),
  clean(env.POSTGRES_URL),
].find(Boolean) || '';

const altPooler = clean(env.DATABASE_URL_POOLING_ALT || '');

const directURL = [
  clean(env.DATABASE_URL),
  clean(env.POSTGRES_URL_NON_POOLING),
].find(Boolean) || '';

// ===== 2) Normaliza (porta correta e sslmode=require)
function normalize(url) {
  if (!url) return null;
  try {
    const u = new NodeURL(url);
    if (/pooler\.supabase\.com$/i.test(u.hostname)) u.port = '6543';
    if (/\.supabase\.co$/i.test(u.hostname) && !u.port) u.port = '5432';
    if (!/[?&]sslmode=/.test(u.search))
      u.search += (u.search ? '&' : '?') + 'sslmode=require';
    return u.toString();
  } catch {
    return url;
  }
}

// Ordem de tentativa:
// - default: poolers → direct (fallback real)
// - se DB_PREFER_DIRECT=1 ou DB_DISABLE_POOLER=1: direct → poolers
const preferDirect =
  env.DB_PREFER_DIRECT === '1' || env.DB_DISABLE_POOLER === '1';

const ordered = preferDirect
  ? [directURL, poolerURL, altPooler]
  : [poolerURL, altPooler, directURL];

const urlsRaw = ordered.map(normalize).filter(Boolean);

// remove duplicadas preservando ordem
const seen = new Set();
const urls = urlsRaw.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));

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

// ===== 4) DNS helpers: tente TODOS os IPv4 do host (evita IP “ruim” da rotação)
const dnp = dns.promises;

async function resolveAllIPv4(host) {
  try {
    const addrs = await dnp.resolve4(host);
    return Array.isArray(addrs) && addrs.length ? addrs : [];
  } catch {
    try {
      const { address } = await dnp.lookup(host, {
        family: 4,
        hints: dns.ADDRCONFIG,
      });
      return address ? [address] : [];
    } catch {
      return [];
    }
  }
}

/**
 * Para uma URL com hostname, retorna uma lista de objetos:
 *   { url: mesmaURL mas com hostname = IPv4, sni: hostnameOriginal }
 * Um item para cada IPv4 resolvido.
 */
async function toIPv4Candidates(url) {
  try {
    const u = new NodeURL(url);
    const host = u.hostname;
    if (!/\.(supabase\.co|supabase\.com)$/i.test(host)) {
      return [{ url, sni: undefined }];
    }
    const ips = await resolveAllIPv4(host);
    if (!ips.length) return [{ url, sni: host }];

    return ips.map((ip) => {
      const clone = new NodeURL(url);
      clone.hostname = ip;
      return { url: clone.toString(), sni: host };
    });
  } catch {
    return [{ url, sni: undefined }];
  }
}

// ===== 5) Pool config
function cfg(url, sni) {
  return {
    connectionString: url,
    ssl: sslFor(url, sni),
    lookup: (hostname, _opts, cb) =>
      dns.lookup(hostname, { family: 4, hints: dns.ADDRCONFIG }, cb),
    max: Number(env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000, // menor p/ fallback mais ágil
    keepAlive: true,
  };
}

let pool;
let reconnectTimer = null;

function safe(url) {
  return String(url).replace(/:[^@]+@/, '://***:***@');
}

const TRANSIENT_CODES = new Set([
  '57P01',
  '57P02',
  '57P03',
  '08006',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'ECONNREFUSED',
]);

function isTransient(err) {
  const code = String(err.code || err.errno || '').toUpperCase();
  const msg = String(err.message || '');
  return TRANSIENT_CODES.has(code) || /Connection terminated|read ECONNRESET/i.test(msg);
}

// Conecta 1x numa URL tentando TODOS os IPv4 do host
async function connectOnce(url) {
  const candidates = await toIPv4Candidates(url);
  let lastErr = null;

  for (const c of candidates) {
    const p = new pg.Pool(cfg(c.url, c.sni));
    try {
      await p.query('SELECT 1');
      console.log('[pg] connected on', safe(c.url));
      p.on('error', (e) => {
        console.error('[pg] pool error', e.code || e.message || e);
        pool = null;
        scheduleReconnect();
      });
      return p;
    } catch (e) {
      lastErr = e;
      console.log(
        '[pg] failed on',
        safe(c.url),
        '->',
        e.code || e.errno || e.message || e
      );
      await p.end().catch(() => {});
      continue;
    }
  }
  throw lastErr || new Error('All IPv4 candidates failed');
}

// Backoff por URL
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
          const delay = BASE_DELAY * Math.pow(2, i); // 0.5s→1s→2s→4s→8s
          console.warn(
            '[pg] transient connect error, retrying',
            i + 1,
            'of',
            PER_URL_TRIES,
            'in',
            delay,
            'ms'
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break; // próxima URL
      }
    }
  }
  throw lastErr || new Error('All database URLs failed');
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(async () => {
    if (pool) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      return;
    }
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

// Query com retry 1x
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
