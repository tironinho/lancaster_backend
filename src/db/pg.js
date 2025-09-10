// src/db/pg.js
import pg from 'pg';

// 🔒 Sempre TRIM nas envs para remover espaços/linhas acidentais
const urls = [
  (process.env.DATABASE_URL_POOLING || '').trim(),       // 1ª tentativa (coloque o aws-0 aqui)
  (process.env.DATABASE_URL_POOLING_ALT || '').trim(),   // 2ª tentativa (aws-1 aqui)
  (process.env.DATABASE_URL || '').trim(),               // opcional (db.<ref>.supabase.co:5432)
].filter(Boolean);

// SSL seguro: para pooler.supabase.com (porta 6543) forçamos a NÃO verificar o cert (cadeia self-signed).
// Para hosts "db.<ref>.supabase.co" mantemos verificação (CA pública).
function sslFor(url) {
  const isPooler =
    /pooler\.supabase\.com/i.test(url) || /:6543\b/.test(url);

  if (isPooler) {
    return { rejectUnauthorized: false };
  }

  // Para endpoints diretos (5432) respeite PGSSLMODE (padrão "require")
  const mode = String(process.env.PGSSLMODE || 'require').trim().toLowerCase();
  if (mode === 'disable' || mode === 'allow') return false;
  return { rejectUnauthorized: mode !== 'no-verify' };
}

function cfg(url) {
  return {
    connectionString: url,
    ssl: sslFor(url),
    max: Number(process.env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  };
}

let pool;

async function tryOnce(url) {
  const p = new pg.Pool(cfg(url));
  try {
    await p.query('SELECT 1');
    console.log('[pg] connected on', url.replace(/:[^@]+@/, '://***:***@'));
    return p;
  } catch (e) {
    console.log(
      '[pg] failed on',
      url.replace(/:[^@]+@/, '://***:***@'),
      '->',
      (e && (e.code || e.errno || e.message)) || e
    );
    await p.end().catch(() => {});
    throw e;
  }
}

async function connectWithRetry(list, i = 0) {
  if (i >= list.length) throw new Error('All database URLs failed');
  try { return await tryOnce(list[i]); }
  catch { return connectWithRetry(list, i + 1); }
}

export async function getPool() {
  if (!pool) {
    console.log('[pg] will try', JSON.stringify(urls, null, 2));
    pool = await connectWithRetry(urls);
    pool.on('error', e => console.error('[pg] pool error', (e && (e.code || e.message)) || e));
  }
  return pool;
}

export async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}
