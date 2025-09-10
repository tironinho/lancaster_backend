// src/routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getPool } from '../db/pg.js';

const router = express.Router();

// ---- Config de token/cookie ----
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.SUPABASE_JWT_SECRET ||
  'change-me-in-env';

const TOKEN_TTL = process.env.JWT_TTL || '7d'; // tempo de vida do token
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'ns_auth';
const IS_PROD = (process.env.NODE_ENV || '').toLowerCase() === 'production';

// Utils de token --------------------------------------------------------------
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function getTokenFromReq(req) {
  const bearer = req.headers.authorization;
  if (bearer && bearer.startsWith('Bearer ')) return bearer.slice(7);
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  return null;
}

function verifyToken(req, res, next) {
  try {
    const token = getTokenFromReq(req);
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

// ---- Helpers de usuário -----------------------------------------------------
// Tenta descobrir a tabela/colunas de usuário existentes no seu banco.
// Ajuste a ordem/nomes se você souber exatamente o schema.
async function findUserByEmail(pool, email) {
  const candidates = [
    // [tabela, colEmail, colSenha, colId, colRole? , colName?]
    ['admin_users', 'email', 'password_hash', 'id', 'role', 'name'],
    ['admins',      'email', 'password',      'id', 'role', 'name'],
    ['users',       'email', 'pass_hash',     'id', 'role', 'name'],
    ['users',       'email', 'password_hash', 'id', 'role', 'name'],
    ['users',       'email', 'password',      'id', 'role', 'name'],
  ];

  for (const [table, cEmail, cPass, cId, cRole, cName] of candidates) {
    try {
      const q = `
        SELECT
          ${cId}   AS id,
          ${cEmail} AS email,
          ${cPass} AS hash
          ${cRole ? `, ${cRole} AS role` : '' }
          ${cName ? `, ${cName} AS name` : '' }
        FROM ${table}
        WHERE ${cEmail} = $1
        LIMIT 1
      `;
      const { rows } = await pool.query(q, [email]);
      if (rows.length) {
        const u = rows[0];
        return {
          id: u.id,
          email: u.email,
          hash: u.hash,
          role: u.role || 'user',
          name: u.name || null,
          table,
          passColumn: cPass,
        };
      }
    } catch {
      // ignora erro de tabela/coluna inexistente e tenta a próxima
    }
  }
  return null;
}

async function emailExists(pool, email) {
  const checks = [
    ['users', 'email'],
    ['admins', 'email'],
    ['admin_users', 'email'],
  ];
  for (const [table, col] of checks) {
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM ${table} WHERE ${col}=$1 LIMIT 1`,
        [email]
      );
      if (rows.length) return true;
    } catch {
      // ignora e tenta próxima
    }
  }
  return false;
}

async function insertUser(pool, { name, email, passwordHash }) {
  // tenta várias variantes comuns de coluna de senha
  const attempts = [
    // [table, passColumn]
    ['users', 'pass_hash'],
    ['users', 'password_hash'],
    ['users', 'password'],
  ];

  for (const [table, passCol] of attempts) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO ${table}(name, email, ${passCol})
         VALUES ($1, $2, $3)
         RETURNING id, name, email`,
        [name, email, passwordHash]
      );
      if (rows.length) return rows[0];
    } catch {
      // tenta a próxima variante
    }
  }

  // Se nenhuma tabela/coluna conhecida funcionou, falha explicitamente
  throw new Error('users_table_not_found');
}

// ---- Rotas ------------------------------------------------------------------

// Registro (mantém contrato { token, user })
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    const pool = await getPool();
    const normalizedEmail = String(email).trim().toLowerCase();

    // Duplicidade de e-mail
    const dupe = await emailExists(pool, normalizedEmail);
    if (dupe) return res.status(409).json({ error: 'email_in_use' });

    const passHash = await bcrypt.hash(String(password), 10);
    const u = await insertUser(pool, { name, email: normalizedEmail, passwordHash: passHash });

    // Registro gera token padrão (não-admin)
    const token = signToken({ id: u.id, email: u.email, name: u.name, is_admin: false });

    // Cookie httpOnly + body
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      maxAge:
        typeof TOKEN_TTL === 'string' && TOKEN_TTL.endsWith('d')
          ? parseInt(TOKEN_TTL, 10) * 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    return res.json({ token, user: u });
  } catch (e) {
    console.error('[auth] register error', e?.message || e);
    const error = e?.message === 'users_table_not_found' ? 'register_schema_invalid' : 'register_failed';
    return res.status(500).json({ error });
  }
});

// Login (mantém contrato { token, user })
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    const pool = await getPool();
    const normalizedEmail = String(email).trim().toLowerCase();

    // Busca usuário (users/admins/admin_users)
    const user = await findUserByEmail(pool, normalizedEmail);
    if (!user || !user.hash) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    // Confere senha
    const ok = await bcrypt.compare(String(password), String(user.hash));
    if (!ok) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    // Normaliza flag admin (role=admin OU e-mail admin @newstore)
    const is_admin =
      (typeof user.role === 'string' && user.role.toLowerCase() === 'admin') ||
      normalizedEmail === 'admin@newstore.com.br';

    // Gera token no formato esperado pelo middleware (id + is_admin)
    const token = signToken({
      id: user.id,
      email: user.email,
      name: user.name || null,
      is_admin,
    });

    // Cookie httpOnly (e body compat)
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      maxAge:
        typeof TOKEN_TTL === 'string' && TOKEN_TTL.endsWith('d')
          ? parseInt(TOKEN_TTL, 10) * 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    return res.json({
      token,
      user: { id: user.id, name: user.name || null, email: user.email, is_admin },
    });
  } catch (e) {
    console.error('[auth] login error', e?.message || e);
    return res.status(500).json({ error: 'login_failed' });
  }
});

// /me retorna o payload do token válido (sem depender do middleware global aqui)
router.get('/me', verifyToken, async (req, res) => {
  return res.json({ user: req.user });
});

// Logout limpa cookie
router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
    path: '/',
  });
  return res.json({ ok: true });
});

export default router;
