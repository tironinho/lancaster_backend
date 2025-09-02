import { Router } from 'express';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const mpPayment = new Payment(mpClient);
router.post('/pix', requireAuth, async (req, res) => {
  try {
    const { reservationId } = req.body || {};
    if (!reservationId) return res.status(400).json({ error: 'missing_reservation' });

    const r = await query(
      `select r.id, r.user_id, r.draw_id, r.numbers, r.status, r.expires_at, u.email, u.name
         from reservations r
         join users u on u.id=r.user_id
        where r.id=$1`,
      [reservationId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'reservation_not_found' });

    const rs = r.rows[0];
    if (rs.status !== 'active') return res.status(400).json({ error: 'reservation_not_active' });
    if (new Date(rs.expires_at).getTime() < Date.now())
      return res.status(400).json({ error: 'reservation_expired' });

    const price = Number(process.env.PRICE_CENTS || 5500);
    const amount = (rs.numbers.length * price) / 100;

    const description = `Sorteio New Store - números ${rs.numbers
      .map((n) => n.toString().padStart(2, '0'))
      .join(', ')}`;

    const payment = await mpPayment.create({ body: { 
      transaction_amount: amount,
      description,
      payment_method_id: 'pix',
      payer: { email: rs.email },
      external_reference: String(reservationId),
      notification_url: `${process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`}/api/mercadopago/webhook`,
      date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    }, requestOptions: { idempotencyKey: uuidv4() } });

    const body = payment?.body || payment;
    const { id, status, point_of_interaction } = body;
    const td = point_of_interaction?.transaction_data || {};
    const { qr_code, qr_code_base64 } = td;

    await query(
      `insert into payments(id, user_id, draw_id, numbers, amount_cents, status, qr_code, qr_code_base64)
       values($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set status=excluded.status`,
      [String(id), rs.user_id, rs.draw_id, rs.numbers, rs.numbers.length * price, status, qr_code, qr_code_base64]
    );

    await query(`update reservations set payment_id=$2 where id=$1`, [reservationId, String(id)]);

    res.json({ paymentId: String(id), status, qr_code, qr_code_base64 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'pix_failed' });
  }
});

router.get('/:id/status', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const resp = await mpPayment.get({ id: String(id) });
    const body = resp?.body || resp;

    await query(`update payments set status=$2 where id=$1`, [id, body.status]);

    if (body.status === 'approved') {
      const pr = await query(`select draw_id, numbers from payments where id=$1`, [id]);
      if (pr.rows.length) {
        const { draw_id, numbers } = pr.rows[0];
        await query(`update numbers set status='sold', reservation_id=null where draw_id=$1 and n = any($2)`, [
          draw_id,
          numbers
        ]);
        await query(`update reservations set status='paid' where payment_id=$1`, [id]);

        const cnt = await query(
          `select count(*)::int as sold from numbers where draw_id=$1 and status='sold'`,
          [draw_id]
        );
        if (cnt.rows[0].sold === 100) {
          await query(`update draws set status='closed', closed_at=now() where id=$1`, [draw_id]);
          const newDraw = await query(`insert into draws(status) values('open') returning id`);
          const newId = newDraw.rows[0].id;
          const tuples = [];
          for (let i = 0; i < 100; i++) tuples.push(`($1, ${i}, 'available', null)`);
          const sql = `insert into numbers(draw_id, n, status, reservation_id) values ${tuples.join(', ')}`;
          await query(sql, [newId]);
        }
      }
    }

    res.json({ id, status: body.status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'status_failed' });
  }
});


router.post('/webhook', async (req, res) => {
  try {
    const paymentId = req.body?.data?.id || req.query?.id || req.body?.id;
    const type = req.body?.type || req.query?.type;

    if (type && type !== 'payment') {
      return res.sendStatus(200);
    }
    if (!paymentId) {
      return res.sendStatus(200);
    }

    const resp = await mpPayment.get({ id: String(paymentId) });
    const body = resp?.body || resp;

    const id = String(body.id);
    const status = body.status;

    await query(`update payments set status=$2, paid_at = case when $2='approved' then now() else paid_at end where id=$1`, [id, status]);

    if (status === 'approved') {
      const pr = await query(`select draw_id, numbers from payments where id=$1`, [id]);
      if (pr.rows.length) {
        const { draw_id, numbers } = pr.rows[0];
        await query(`update numbers set status='sold', reservation_id=null where draw_id=$1 and n = any($2)`, [
          draw_id,
          numbers
        ]);
        // Fecha o sorteio quando vender 100
        const cnt = await query(`select count(*)::int as sold from numbers where draw_id=$1 and status='sold'`, [draw_id]);
        if (cnt.rows[0].sold === 100) {
          await query(`update draws set status='closed', closed_at=now() where id=$1`, [draw_id]);
          const newDraw = await query(`insert into draws(status) values('open') returning id`);
          const newId = newDraw.rows[0].id;
          const tuples = [];
          for (let i = 0; i < 100; i++) tuples.push(`($1, ${i}, 'available', null)`);
          const sql = `insert into numbers(draw_id, n, status, reservation_id) values ${tuples.join(', ')}`;
          await query(sql, [newId]);
        }
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error('[webhook] erro:', e);
    return res.sendStatus(200);
  }
});

export default router;
