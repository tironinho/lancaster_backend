import { Router } from 'express';
import { query } from '../db.js';
import { comparePassword, hashPassword, signToken } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'missing_fields' });

    const dupe = await query('select 1 from users where email=$1', [email]);
    if (dupe.rows.length) return res.status(409).json({ error: 'email_in_use' });

    const pass = await hashPassword(password);
    const ins = await query(
      'insert into users(name, email, pass_hash) values($1,$2,$3) returning id,name,email',
      [name, email, pass]
    );
    const u = ins.rows[0];
    const token = signToken({ id: u.id, email: u.email, name: u.name });
    res.json({ token, user: u });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'register_failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
    const r = await query('select id,name,email,pass_hash from users where email=$1', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'invalid_credentials' });
    const u = r.rows[0];
    const ok = await comparePassword(password, u.pass_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    const token = signToken({ id: u.id, email: u.email, name: u.name });
    res.json({ token, user: { id: u.id, name: u.name, email: u.email } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'login_failed' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

export default router;
