import pg from "pg";
import dns from "dns";

const { Pool } = pg;

// Garante IPv4 primeiro (mitiga ENETUNREACH mesmo se o painel ignorar NODE_OPTIONS)
try { dns.setDefaultResultOrder("ipv4first"); } catch {}

// URLs candidatas — prioriza 5432 (session) e depois 6543 (pgBouncer)
const CANDIDATES = [
  process.env.DATABASE_URL,               // ex.: pooler/session 5432
  process.env.DATABASE_URL_ALT,           // ex.: db.supabase.co:5432
  process.env.POSTGRES_URL,               // compat
  process.env.POSTGRES_URL_NON_POOLING,   // compat 5432
  process.env.DATABASE_URL_POOLING,       // pooler 6543
  process.env.DATABASE_URL_POOLING_ALT,   // pooler 6543 alternativo
].filter(Boolean);

// SSL: require | no-verify | disable
const SSLMODE = (process.env.PGSSLMODE || "require").toLowerCase();
const ssl = SSLMODE === "disable" ? false : { rejectUnauthorized: SSLMODE !== "no-verify" };

function makeCfg(url) {
  return {
    connectionString: url,
    ssl,
    max: Number(process.env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    keepAlive: true,
    application_name: "lancaster_backend",
  };
}

function normalize(list) {
  const uniq = Array.from(new Set(list));
  return uniq.sort((a, b) => (/:5432\b/.test(a) ? 0 : 1) - (/:5432\b/.test(b) ? 0 : 1));
}

let pool;

async function connectWithRetry(list, attempt = 1) {
  const urls = normalize(list);
  if (!urls.length) throw new Error("All database URLs failed");

  for (const raw of urls) {
    const redacted = raw.replace(/:[^@]*@/, ":***@");
    const p = new Pool(makeCfg(raw));
    try {
      console.log("[pg] trying %s (attempt %d)", redacted, attempt);
      await p.query("select 1");
      console.log("[pg] connected on %s", redacted);
      return p;
    } catch (err) {
      console.log(
        "[pg] failed on %s -> %s%s",
        redacted,
        err.code || err.name || "ERR",
        err.message ? ` :: ${err.message}` : ""
      );
      await p.end().catch(() => {});
    }
  }

  if (attempt >= 3) throw new Error("All database URLs failed");
  await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 4000)));
  return connectWithRetry(urls, attempt + 1);
}

export async function getPool() {
  if (pool) return pool;
  pool = await connectWithRetry(CANDIDATES);
  pool.on("error", (e) => console.error("[pg] pool error", e?.code || e?.message || e));
  return pool;
}

export async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}
