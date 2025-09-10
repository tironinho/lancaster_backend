// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL as NodeURL } from 'url';

// ===== 1) Lê ENVs com fallback p/ variáveis do Supabase =====
const env = process.env;

// Direto (host db.<proj>.supabase.co:5432)
const directDB = [
  env.DATABASE_URL,
  env.POSTGRES_URL_NON_POOLING, // Supabase "direct"
].find(v => v && v.trim()) || '';

// Pooler (host *.pooler.supabase.com:6543)
const basePooler = [
  env.DATABASE_URL_POOLING,
  env.POSTGRES_PRISMA_URL,      // pooling (com pgbouncer=true)
  env.POSTGRES_URL,             // pooling padrão
].find(v => v && v.trim()) || '';

const altPooler = (env.DATABASE_URL_POOLING_ALT || '').trim();

// ===== 2) Normalização segura das URLs =====
function normalize(url) {
  if (!url) return null;
  try {
    const u = new NodeURL(url);

    // Corrige porta se for pooler (sempre 6543)
    if (/pooler\.supabase\.com$/i.test(u.hostname)) {
      u.port = '6543';
    }

    // Garante sslmode=require
    if (!/[?&]sslmode=/.test(u.search)) {
      u.search += (u.search ? '&' : '?') + 'sslmode=require';
    }
    return u.toString();
  } catch {
    // Se não parsear, tenta bruto assim mesmo
    return url;
  }
}

// Ordem: direto (5432) → pooler base (6543) → pooler alt (6543)
const urlsRaw = [directDB, basePooler, altPooler].map(normalize).filter(Boolean);

// Remove duplicadas preservando ordem
const seen = new Set();
const urls = urlsRaw.filter(u => (seen.has(u) ? false : (seen.add(u), true)));

// ===== 3) SSL (no-verify para domínios Supabase) =====
function sslFor(url) {
  try {
    const u = new NodeURL(url);
    if (/\.(supabase\.co|supabase\.com)$/i.test(u.hostname)) {
      // Evita problemas de cadeia em alguns ambientes
      return { rejectUnauthorized: false };
    }
  } catch {}
  const mode = String(env.PGSSLMODE || 'require').trim().toLowerCase();
  if (mode === 'disable' || mode === 'allow') return false;
  return { rejectUnauthorized: mode !== 'no-verify' };
}

// ===== 4) Força IPv4 (evita bugs de IPv6 em hosts cloud) =====
function ipv4Lookup(hostname, opts, cb) {
  dns.lookup(hostname, { family: 4, hints: dns.ADDRCONFIG }, cb);
}

// ===== 5) Config do Pool =====
function cfg(url) {
  return {
    connectionString: url,
    ssl: sslFor(url),
    lookup: ipv4Lookup, // repassado ao net/tls pelo pg
    max: Number(env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  };
}

let pool;

function safe(url) {
  return String(url).replace(/:[^@]+@/, '://***:***@');
}

async function tryOnce(url) {
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

async function connectWithRetry(list, i = 0) {
  if (i >= list.length) throw new Error('All database URLs failed');
  try {
    return await tryOnce(list[i]);
  } catch {
    return connectWithRetry(list, i + 1);
  }
}

export async function getPool() {
  if (!pool) {
    console.log('[pg] will try', JSON.stringify(urls, null, 2));
    pool = await connectWithRetry(urls);
    pool.on('error', (e) => {
      console.error('[pg] pool error', (e && (e.code || e.message)) || e);
    });
  }
  return pool;
}

export async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}
