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

const TOKEN_TTL = process.env.JWT_TTL || '7d';
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'ns_auth';
const IS_PROD = (process.env.NODE_ENV || 'production') === 'production';

// helpers ------------------------------------------------------------------
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

async function findUserByEmail(pool, email) {
  const tries = [
    ['admin_users', 'email', 'password_hash', 'id', 'role'],
    ['admins',      'email', 'password',      'id', 'role'],
    ['users',       'email', 'password_hash', 'id', 'role'],
    ['users',       'email', 'password',      'id', 'role'],
  ];

  for (const [table, cEmail, cPass, cId, cRole] of tries) {
    try {
      const q = `SELECT ${cId} as id, ${cEmail} as email, ${cPass} as hash${cRole ? `, ${cRole} as role` : ''} 
                 FROM ${table} WHERE ${cEmail} = $1 LIMIT 1`;
      const { rows } = await pool.query(q, [email]);
      if (rows.length) {
        const u = rows[0];
        return { id: u.id, email: u.email, hash: u.hash, role: u.role || 'user' };
      }
    } catch { /* ignora e tenta próxima tabela */ }
  }
  return null;
}

// routes -------------------------------------------------------------------
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'invalid_payload' });
    }
    const pool = await getPool();

    const dupe = await pool.query('SELECT 1 FROM users WHERE email=$1', [email]);
    if (dupe.rows.length) return res.status(409).json({ error: 'email_in_use' });

    const hash = await bcrypt.hash(String(password), 10);
    const ins = await pool.query(
      'INSERT INTO users(name, email, password_hash) VALUES($1,$2,$3) RETURNING id,name,email',
      [name, email, hash]
    );
    const u = ins.rows[0];
    const token = signToken({ sub: u.id, email: u.email, name: u.name, role: 'user' });

    res.cookie(COOKIE_NAME, token, {
      httpOnly: true, secure: IS_PROD, sameSite: IS_PROD ? 'none' : 'lax', path: '/',
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
    const user = await findUserByEmail(pool, String(email).trim().toLowerCase());
    if (!user || !user.hash) return res.status(401).json({ error: 'invalid_credentials' });

    const ok = await bcrypt.compare(String(password), String(user.hash));
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    const token = signToken({ sub: user.id, email: user.email, role: user.role });

    res.cookie(COOKIE_NAME, token, {
      httpOnly: true, secure: IS_PROD, sameSite: IS_PROD ? 'none' : 'lax', path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({ ok: true, token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (e) {
    console.error('[auth] login error', e);
    return res.status(500).json({ error: 'login_failed' });
  }
});

router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: IS_PROD, sameSite: IS_PROD ? 'none' : 'lax', path: '/' });
  return res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  return res.json({ ok: true, user: req.user });
});

export default router;
