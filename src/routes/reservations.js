import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

async function cleanupExpired() {
  // Marca reservas expiradas e libera números
  const expired = await query(
    `update reservations
       set status='expired'
     where status='active' and expires_at < now()
     returning id, draw_id, numbers`
  );
  if (expired.rows.length) {
    for (const r of expired.rows) {
      await query(
        `update numbers
           set status='available', reservation_id=null
         where draw_id=$1 and n = any($2) and status='reserved' and reservation_id=$3`,
        [r.draw_id, r.numbers, r.id]
      );
    }
  }
}

router.post('/', requireAuth, async (req, res) => {
  try {
    await cleanupExpired();

    const { numbers } = req.body || {};
    if (!Array.isArray(numbers) || numbers.length === 0)
      return res.status(400).json({ error: 'no_numbers' });

    const ttl = Number(process.env.RESERVATION_TTL_MIN || 15);
    const dr = await query(`select id from draws where status='open' order by id desc limit 1`);
    if (!dr.rows.length) return res.status(400).json({ error: 'no_open_draw' });
    const drawId = dr.rows[0].id;

    // disponibilidade
    const checks = await query(
      `select n, status from numbers where draw_id=$1 and n = any($2)`,
      [drawId, numbers]
    );
    for (const row of checks.rows) {
      if (row.status !== 'available') {
        return res.status(409).json({ error: 'unavailable', n: row.n });
      }
    }

    const id = uuid();
    const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

    await query(
      `insert into reservations(id, user_id, draw_id, numbers, expires_at)
       values($1,$2,$3,$4,$5)`,
      [id, req.user.id, drawId, numbers, expiresAt]
    );

    await query(
      `update numbers
         set status='reserved', reservation_id=$3
       where draw_id=$1 and n = any($2)`,
      [drawId, numbers, id]
    );

    res.json({ reservationId: id, drawId, expiresAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'reserve_failed' });
  }
});

export default router;
