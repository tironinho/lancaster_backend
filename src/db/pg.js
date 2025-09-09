// src/db/pg.js
import pg from "pg";


/**
 * Monta a lista de URLs de banco. Mantém compatibilidade com as envs que você já usa.
 * Ordem: direto (5432) -> alternativo direto -> pooler (6543) -> alternativo pooler
 * -> compat de projetos antigos (POSTGRES_URL / POSTGRES_URL_NON_POOLING).
 */
const URLS = [
  process.env.DATABASE_URL,
  process.env.DATABASE_URL_ALT,
  process.env.DATABASE_URL_POOLING,
  process.env.DATABASE_URL_POOLING_ALT,
  process.env.POSTGRES_URL,
  process.env.POSTGRES_URL_NON_POOLING,
].filter(Boolean);

/**
 * Mapeia PGSSLMODE para a configuração esperada pelo 'pg'.
 * - 'require' ou 'no-verify'  => criptografa sem validar a cadeia (evita SELF_SIGNED_CERT_IN_CHAIN)
 * - 'verify-ca' / 'verify-full' => valida a cadeia (precisaria de CA configurada)
 * - 'disable' => sem TLS
 */
function sslFromEnv() {
  const mode = String(process.env.PGSSLMODE || "require").toLowerCase();

  if (mode === "disable" || mode === "off" || mode === "false") return false;

  if (mode === "verify-ca" || mode === "verify-full") {
    return { rejectUnauthorized: true };
  }

  // Padrão: 'require' ou 'no-verify' -> TLS sem validação da cadeia
  return { rejectUnauthorized: false };
}

function maskUrl(u) {
  // esconde a senha nos logs
  return u.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");
}

function cfg(url) {
  return {
    connectionString: url,
    ssl: sslFromEnv(),
    max: Number(process.env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  };
}

let pool;

/**
 * Tenta conectar em uma URL e retorna um Pool válido.
 * Loga os erros de forma limpa (com senha mascarada).
 */
async function tryConnect(url, attempt) {
  const masked = maskUrl(url);
  console.log(`[pg] trying ${masked} (attempt ${attempt})`);
  const candidate = new pg.Pool(cfg(url));

  try {
    await candidate.query("select 1");
    console.log(`[pg] connected on ${masked}`);
    return candidate;
  } catch (err) {
    const code = err?.code || err?.message || "unknown";
    const where =
      err?.address && err?.port ? ` (IPv4=${err.address}:${err.port})` : "";
    console.log(`[pg] failed on ${masked}${where} -> ${code}`);
    await candidate.end().catch(() => {});
    throw err;
  }
}

/**
 * Testa em ordem todas as URLs disponíveis, com pequenos backoffs.
 */
async function connectWithRetry(urls, wave = 1) {
  if (!urls.length) throw new Error("No database URL available");

  for (let i = 0; i < urls.length; i++) {
    try {
      return await tryConnect(urls[i], wave);
    } catch (_) {
      // tenta a próxima URL
    }
  }

  if (wave < 3) {
    await new Promise((r) => setTimeout(r, 1000 * wave));
    return connectWithRetry(urls, wave + 1);
  }

  throw new Error("All database URLs failed");
}

export async function getPool() {
  if (pool) return pool;
  pool = await connectWithRetry(URLS);
  pool.on("error", (e) => {
    console.error("[pg] pool error", e?.code || e?.message);
  });
  return pool;
}

export default getPool;
