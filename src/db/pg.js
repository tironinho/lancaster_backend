// src/db/pg.js
import pg from 'pg';
import dns from 'dns';

// Garante IPv4 para o módulo, mesmo se alguém importar antes do index
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* node < 18 */ }

// ---- Escolha de URLs (prioriza pooler) ----
const candidates = [
  process.env.DATABASE_URL_POOLING,     // Render/Supabase pooler (6543)
  process.env.POSTGRES_PRISMA_URL,      // também costuma apontar para o pooler
  process.env.POSTGRES_URL,             // conexão normal
  process.env.DATABASE_URL,             // conexão normal (heroku-like)
  process.env.POSTGRES_URL_NON_POOLING, // fallback explícito 5432
].filter(Boolean);

// ---- SSL ----
// Supabase exige SSL. Por padrão usamos 'require' com CA relaxado
// (Render às vezes não tem cadeia CA completa). Se quiser verificação
// estrita do certificado, defina PGSSLMODE=verify-full.
const wantVerify = String(process.env.PGSSLMODE || 'require')
  .toLowerCase()
  .includes('verify');

function cfg(url) {
  return {
    connectionString: url,
    ssl: wantVerify ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
    max: Number(process.env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  };
}

let pool;

// Tenta conectar com backoff simples, passando pelas URLs candidatas
async function connectWithRetry(urls, attempt = 1) {
  const [url, ...rest] = urls;
  if (!url) throw new Error('No database URL available');

  // Cria um pool candidato
  const candidate = new pg.Pool(cfg(url));

  try {
    // Teste rápido (evita travar mais adiante)
    await candidate.query('SELECT 1');
    return candidate;
  } catch (err) {
    await candidate.end().catch(() => {});
    if (rest.length === 0 || attempt >= 3) throw err;
    await new Promise(r => setTimeout(r, 1000 * attempt)); // backoff incremental
    return connectWithRetry(rest, attempt + 1);
  }
}

export async function getPool() {
  if (pool) return pool;
  if (candidates.length === 0) {
    throw new Error('No database connection string configured.');
  }
  pool = await connectWithRetry(candidates);
  pool.on('error', (e) => {
    console.error('[pg] pool error', e?.code || e?.message);
  });
  return pool;
}
