// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL as NodeURL } from 'url';

// ===== 1) Carrega e normaliza ENVs =====
const basePooler = (process.env.DATABASE_URL_POOLING || '').trim();
const altPooler  = (process.env.DATABASE_URL_POOLING_ALT || '').trim();
// Opcional: se quiser manter um direto, deixe aqui (eu sugiro deixar vazio no Render)
const directDB   = (process.env.DATABASE_URL || '').trim();

// ===== 2) Expande URLs do pooler para também tentar porta 5432 =====
function expandPoolerPorts(u) {
  if (!u) return [];
  try {
    const a = new NodeURL(u);
    // Sempre incluir o original
    const out = [a.toString()];
    // Se for pooler.supabase.com, adiciona fallback na porta 5432
    if (/pooler\.supabase\.com$/i.test(a.hostname)) {
      const b = new NodeURL(a.toString());
      b.port = '5432';
      out.push(b.toString());
    }
    return out;
  } catch {
    return [u]; // se por algum motivo não parsear, tenta bruto
  }
}

// Ordem pensada: aws-0 6543 → aws-0 5432 → aws-1 6543 → aws-1 5432 → (opcional) direto
const urls = [
  ...expandPoolerPorts(basePooler),
  ...expandPoolerPorts(altPooler),
  ...(directDB ? [directDB] : []),
].filter(Boolean);

// ===== 3) SSL: desabilita verificação para qualquer *.supabase.com =====
function sslFor(url) {
  try {
    const u = new NodeURL(url);
    if (u.hostname.endsWith('.supabase.com')) {
      // Pooler e hosts db de Supabase frequentemente têm cadeia self-signed
      return { rejectUnauthorized: false };
    }
  } catch {}
  // Fallback: respeita PGSSLMODE (default require)
  const mode = String(process.env.PGSSLMODE || 'require').trim().toLowerCase();
  if (mode === 'disable' || mode === 'allow') return false;
  return { rejectUnauthorized: mode !== 'no-verify' };
}

// ===== 4) Força IPv4 no socket (mata ENETUNREACH por IPv6) =====
function ipv4Lookup(hostname, opts, cb) {
  // ADDRCONFIG evita endereços não roteáveis, V4 apenas
  dns.lookup(hostname, { family: 4, hints: dns.ADDRCONFIG }, cb);
}

// ===== 5) Config comum do pool =====
function cfg(url) {
  return {
    connectionString: url,
    ssl: sslFor(url),
    lookup: ipv4Lookup, // <- força IPv4 na resolução de DNS/socket
    max: Number(process.env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  };
}

let pool;

// Apenas sanitiza a URL logada (esconde senha)
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
