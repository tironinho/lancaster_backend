// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL as NodeURL } from 'url';

const env = process.env;

// ===== 1) Coleta ENVs (pooler primeiro para Render) =====
const poolerURL = [
  env.DATABASE_URL_POOLING,
  env.POSTGRES_PRISMA_URL,
  env.POSTGRES_URL,
].find(v => v && v.trim()) || '';

const directURL = [
  env.DATABASE_URL,
  env.POSTGRES_URL_NON_POOLING,
].find(v => v && v.trim()) || '';

const altPooler = (env.DATABASE_URL_POOLING_ALT || '').trim();

// ===== 2) Normaliza URLs (porta/sslmode) =====
function normalize(url) {
  if (!url) return null;
  try {
    const u = new NodeURL(url);
    if (/pooler\.supabase\.com$/i.test(u.hostname)) u.port = '6543'; // pooler sempre 6543
    if (!/[?&]sslmode=/.test(u.search)) u.search += (u.search ? '&' : '?') + 'sslmode=require';
    return u.toString();
  } catch {
    return url;
  }
}

// Ordem: pooler → altPooler → direct
const urlsRaw = [poolerURL, altPooler, directURL].map(normalize).filter(Boolean);

// remove duplicadas preservando ordem
const seen = new Set();
const urls = urlsRaw.filter(u => (seen.has(u) ? false : (seen.add(u), true)));

if (urls.length === 0) {
  console.error('[pg] Nenhuma DATABASE_URL definida. Defina DATABASE_URL_POOLING e/ou DATABASE_URL.');
}

// ===== 3) SSL (no-verify para supabase) =====
function sslFor(url) {
  try {
    const u = new NodeURL(url);
    if (/\.(supabase\.co|supabase\.com)$/i.test(u.hostname)) {
      return { rejectUnauthorized: false };
    }
  } catch {}
  const mode = String(env.PGSSLMODE || 'require').trim().toLowerCase();
  if (mode === 'disable' || mode === 'allow') return false;
  return { rejectUnauthorized: mode !== 'no-verify' };
}

// ===== 4) Força IPv4 =====
function ipv4Lookup(hostname, _opts, cb) {
  dns.lookup(hostname, { family: 4, hints: dns.ADDRCONFIG }, cb);
}

// ===== 5) Config do Pool =====
function cfg(url) {
  return {
    connectionString: url,
    ssl: sslFor(url),
    lookup: ipv4Lookup,
    max: Number(env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
    application_name: env.RENDER_SERVICE_NAME || 'newstore-backend',
  };
}

let pool;

function safe(url) {
  return String(url).replace(/:[^@]+@/, '://***:***@');
}

// Códigos que tratamos como transitórios
const TRANSIENT_CODES = new Set([
  '57P01', '57P02', '57P03', '08006', // PG
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'ECONNREFUSED', // Node
]);

function isTransient(err) {
  const code = String(err.code || err.errno || '').toUpperCase();
  const msg = String(err.message || '');
  return TRANSIENT_CODES.has(code) || /Connection terminated|read ECONNRESET/i.test(msg);
}

// tenta conectar 1x numa URL
async function connectOnce(url) {
  const p = new pg.Pool(cfg(url));
  try {
    await p.query('SELECT 1');
    console.log('[pg] connected on', safe(url));
    return p;
  } catch (e) {
    console.log('[pg] failed on', safe(url), '->', e.code || e.errno || e.message || e);
    await p.end().catch(() => {});
    throw e;
  }
}

// tenta conectar com backoff por URL (3 tentativas por URL)
async function connectWithRetry(urlList) {
  const PER_URL_TRIES = Number(env.PG_URL_TRIES || 3);
  const BASE_DELAY = Number(env.PG_RETRY_BASE_MS || 500);

  let lastErr = null;

  for (const url of urlList) {
    for (let i = 0; i < PER_URL_TRIES; i++) {
      try {
        const p = await connectOnce(url);
        // hook para recriar pool se quebrar
        p.on('error', (e) => {
          console.error('[pg] pool error', e.code || e.message || e);
          pool = null;
        });
        return p;
      } catch (e) {
        lastErr = e;
        if (i < PER_URL_TRIES - 1 && isTransient(e)) {
          const delay = BASE_DELAY * Math.pow(2, i); // 500ms, 1s, 2s...
          console.warn('[pg] transient connect error, retrying', i + 1, 'of', PER_URL_TRIES, 'in', delay, 'ms');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        // sai para próxima URL
        break;
      }
    }
  }

  throw lastErr || new Error('All database URLs failed');
}

export async function getPool() {
  if (!pool) {
    console.log('[pg] will try', JSON.stringify(urls, null, 2));
    pool = await connectWithRetry(urls);
  }
  return pool;
}

// ===== 6) Query com retry 1x em falha transitória =====
export async function query(text, params) {
  try {
    const p = await getPool();
    return await p.query(text, params);
  } catch (e) {
    if (isTransient(e)) {
      console.warn('[pg] transient query error, recreating pool and retrying once');
      pool = null;
      const p = await getPool();
      return await p.query(text, params);
    }
    throw e;
  }
}
