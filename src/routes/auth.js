// src/routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getPool } from '../db/pg.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.SUPABASE_JWT_SECRET ||
  'change-me-in-env';

const TOKEN_TTL  = process.env.JWT_TTL || '7d';
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'ns_auth';
const IS_PROD = (process.env.NODE_ENV || 'production') === 'production';

// ------------------------------ helpers
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

async function verifyPassword(plain, hashed) {
  if (!hashed) return false;
  try {
    if (String(hashed).startsWith('$2')) {
      // bcrypt ($2a/$2b/..)
      return await bcrypt.compare(String(plain), String(hashed));
    }
    // (fallback apenas se alguém gravou texto puro — não recomendado)
    if (!String(hashed).startsWith('$')) return String(plain) === String(hashed);
    return false;
  } catch {
    return false;
  }
}

// --- mantém imports e variáveis como estão ---

async function findUserByEmail(pool, emailRaw) {
  const email = String(emailRaw).trim();
  const tries = [
    // tabela, colEmail, colHash, id, roleExpr (ajustado ao seu schema)
    { table: 'users', colE: 'email', colP: 'pass_hash', colId: 'id', roleExpr: "CASE WHEN is_admin THEN 'admin' ELSE 'user' END" },
    { table: 'admin_users', colE: 'email', colP: 'password_hash', colId: 'id', roleExpr: 'role' },
    { table: 'admins', colE: 'email', colP: 'password', colId: 'id', roleExpr: "'admin'" },
  ];

  // ping leve (força reconectar se pool estiver quebrado)
  await pool.query('SELECT 1');

  let lastErr = null;
  for (const t of tries) {
    try {
      const q = `
        SELECT ${t.colId} AS id,
               ${t.colE} AS email,
               ${t.colP} AS hash,
               ${t.roleExpr} AS role
        FROM ${t.table}
        WHERE LOWER(${t.colE}) = LOWER($1)
        LIMIT 1`;
      const { rows } = await pool.query(q, [email]);
      if (rows.length) return rows[0];
    } catch (e) {
      lastErr = e; // registra erro real de DB
    }
  }
  if (lastErr) throw lastErr; // <- NÃO mascara como 401
  return null;                // só null se realmente não achou
}

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'invalid_payload' });

    const pool = await getPool();
    const user = await findUserByEmail(pool, email);

    if (!user || !user.hash) return res.status(401).json({ error: 'invalid_credentials' });

    const ok = user.hash.startsWith('$2')
      ? await bcrypt.compare(String(password), String(user.hash))
      : (!user.hash.startsWith('$') && String(password) === String(user.hash));

    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    const token = signToken({ sub: user.id, email: user.email, role: user.role || 'user' });
    res.cookie(/* ...igual estava... */);
    return res.json({ ok: true, token, user: { id: user.id, email: user.email, role: user.role || 'user' } });
  } catch (e) {
    // Se foi erro de banco, devolve 503 (ou 500) para diferenciar de 401
    console.error('[auth] login error', e.code || e.message || e);
    return res.status(503).json({ error: 'db_unavailable' });
  }
});

// ------------------------------ routes
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    const pool = await getPool();
    const emailNorm = String(email).trim().toLowerCase();

    const dupe = await pool.query('SELECT 1 FROM users WHERE LOWER(email)=LOWER($1)', [emailNorm]);
    if (dupe.rows.length) return res.status(409).json({ error: 'email_in_use' });

    const hash = await bcrypt.hash(String(password), 10);
    const ins = await pool.query(
      // grava em pass_hash; is_admin default FALSE
      `INSERT INTO users (name, email, pass_hash)
       VALUES ($1,$2,$3)
       RETURNING id, name, email, CASE WHEN is_admin THEN 'admin' ELSE 'user' END AS role`,
      [name, emailNorm, hash]
    );
    const u = ins.rows[0];
    const token = signToken({ sub: u.id, email: u.email, name: u.name, role: u.role });

    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({ ok: true, token, user: u });
  } catch (e) {
    console.error('[auth] register error', e);
    return res.status(500).json({ error: 'register_failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'invalid_payload' });

    const pool = await getPool();
    const user = await findUserByEmail(pool, email);
    if (!user || !user.hash) return res.status(401).json({ error: 'invalid_credentials' });

    const ok = await verifyPassword(password, user.hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    const token = signToken({ sub: user.id, email: user.email, role: user.role });

    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({ ok: true, token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (e) {
    console.error('[auth] login error', e);
    return res.status(500).json({ error: 'login_failed' });
  }
});

router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
    path: '/',
  });
  return res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  return res.json({ ok: true, user: req.user });
});

export default router;
