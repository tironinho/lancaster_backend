// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL as NodeURL } from 'url';

const env = process.env;

// ===== helpers
const clean = (s) =>
  s && typeof s === 'string' ? s.trim().replace(/^['"]+|['"]+$/g, '') : s;

// ===== URLs: pooler + direct (com fallback configurável)
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

// Ordem configurável:
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

// ===== SSL + SNI
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

// ===== DNS/IP — força IPv4 para Supabase
const dnp = dns.promises;
const OVERRIDE_IPV4 = clean(env.DB_HOST_IPV4 || ''); // <<< NOVO

async function resolveOneIPv4(host) {
  try {
    const addrs = await dnp.resolve4(host);
    if (Array.isArray(addrs) && addrs.length) return addrs[0];
  } catch {
    try {
      const { address } = await dnp.lookup(host, { family: 4, hints: dns.ADDRCONFIG });
      if (address) return address;
    } catch {}
  }
  return null;
}

/**
 * Para hosts do Supabase:
 * - se DB_HOST_IPV4 definido -> usa esse IP (sem consultar DNS)
 * - senão -> resolve 1 IPv4; se falhar, NÃO volta pro hostname (evita IPv6)
 */
async function toIPv4Candidates(url) {
  try {
    const u = new NodeURL(url);
    const host = u.hostname;
    if (!/\.(supabase\.co|supabase\.com)$/i.test(host)) {
      return [{ url, sni: undefined }];
    }

    let ip = OVERRIDE_IPV4;
    if (!ip) ip = await resolveOneIPv4(host);

    if (!ip) {
      const msg = `[pg] nenhum IPv4 encontrado para ${host}. Defina DB_HOST_IPV4 com um A record válido.`;
      console.error(msg);
      throw new Error('NO_IPV4_SUPABASE');
    }

    const clone = new NodeURL(url);
    clone.hostname = ip; // força IPv4
    return [{ url: clone.toString(), sni: host }]; // mantém SNI
  } catch (e) {
    // se algo der muito errado, ainda assim evite cair no IPv6
    throw e instanceof Error ? e : new Error('IPV4_RESOLVE_FAILED');
  }
}

// ===== Pool config
const CONN_TIMEOUT_MS = Number(env.DB_CONN_TIMEOUT_MS || 2000);

function cfg(url, sni) {
  return {
    connectionString: url,
    ssl: sslFor(url, sni),
    // força IPv4 em qualquer resolução interna
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

// Conecta 1x numa URL
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
      console.log('[pg] failed on', safe(c.url), '->', e.code || e.errno || e.message || e);
      await p.end().catch(() => {});
      break;
    }
  }
  throw lastErr || new Error('All IPv4 candidates failed');
}

// Tentativas por URL (curtas)
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
        break; // próxima URL
      }
    }
  }
  throw lastErr || new Error('All database URLs failed');
}

function scheduleReconnect() {
  if (env.DB_DISABLE_BG_RECONNECT === '1') return; // desliga reconexão
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
