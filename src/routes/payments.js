import express from 'express';
import { query } from '../db/pg.js';
import { createPixPayment, getPayment } from '../payments/mercadopago.js';

const router = express.Router();

// Auth mínimo: usa req.user se existir; para teste defina DISABLE_AUTH=1
function resolveUser(req) {
  if (req.user) return req.user;
  if (process.env.DISABLE_AUTH === '1') {
    return {
      id: req.headers['x-user-id'] || 'test-user',
      email: req.headers['x-user-email'] || 'test@example.com',
      name: req.headers['x-user-name'] || 'Test User',
    };
  }
  return null;
}

function requireAuth(req, res, next) {
  const u = resolveUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.user = u;
  next();
}

/**
 * POST /api/payments/pix
 * body: { reservationId: string }
 * resp: { id,status,qr_code,qr_code_base64,expires_in }
 */
router.post('/api/payments/pix', requireAuth, express.json(), async (req, res, next) => {
  try {
    const { reservationId } = req.body || {};
    if (!reservationId) return res.status(400).json({ error: 'reservationId obrigatório' });

    // 1) Carrega a reserva (sem depender de 'amount')
    const rRes = await query(
      `select id, user_id, status, numbers
         from reservations
        where id = $1`,
      [reservationId]
    );
    const r = rRes.rows[0];
    if (!r) return res.status(404).json({ error: 'reserva não encontrada' });

    // Se houver user_id salvo na reserva e houver id no token, exige que coincidam
    if (r.user_id && req.user.id && String(r.user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    if (r.status && !['pendente','reservado',null,'active'].includes(r.status)) {
      return res.status(409).json({ error: `reserva com status ${r.status}` });
    }

    // 2) Calcula o valor pelo número de cotas
    const qty = Array.isArray(r.numbers) ? r.numbers.length : 0;
    if (!qty) return res.status(400).json({ error: 'reserva sem números' });

    // PRICE_CENTS (ex: 5500) -> BRL
    const unitCents = Number(process.env.PRICE_CENTS || 0);
    const unitBRL = unitCents ? unitCents / 100 : Number(process.env.NUMBER_PRICE || 55);
    const amount = +(qty * unitBRL).toFixed(2);
    if (!amount || !isFinite(amount)) {
      return res.status(400).json({ error: 'valor inválido' });
    }

    // 3) Dados do pagador (se existirem)
    const name = String(req.user.name || '').trim();
    const payer = {
      email: req.user.email,
      first_name: name.split(' ')[0] || undefined,
      last_name: name.split(' ').slice(1).join(' ') || undefined,
    };

    // 4) Cria o PIX no Mercado Pago
    const pay = await createPixPayment({
      amount,
      description: `Reserva ${reservationId}`,
      reservationId,
      payer,
    });

    // 5) Persiste/atualiza pagamento
    await query(
      `insert into payments (reservation_id, mp_payment_id, status, payload)
       values ($1, $2, $3, $4)
       on conflict (mp_payment_id) do update
         set status = excluded.status,
             payload = excluded.payload`,
      [reservationId, pay.paymentId, pay.status, pay.raw]
    );

    // 6) Atualiza status da reserva para 'pendente'
    await query(
      `update reservations
          set status = 'pendente'
        where id = $1
          and (status is null or status in ('reservado','pendente','active'))`,
      [reservationId]
    );

    // 7) Resposta esperada pelo front
    res.json({
      id: pay.paymentId,
      status: pay.status,
      qr_code: pay.qr_code,
      qr_code_base64: pay.qr_code_base64?.replace(/\s/g, '') || null,
      expires_in: pay.expires_in,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/payments/:id/status
 */
router.get('/api/payments/:id/status', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const p = await getPayment(id);

    // cacheia status
    await query(
      `update payments set status = $2, payload = $3 where mp_payment_id = $1`,
      [p.paymentId, p.status, p.raw]
    );

    // se aprovado, marca reserva como paga
    if (p.status === 'approved') {
      const rRes = await query(
        `select reservation_id from payments where mp_payment_id = $1`,
        [p.paymentId]
      );
      const rid = rRes.rows[0]?.reservation_id;
      if (rid) {
        await query(`update reservations set status = 'pago' where id = $1`, [rid]);
      }
    }

    res.json({ paymentId: p.paymentId, status: p.status, status_detail: p.status_detail });
  } catch (err) {
    next(err);
  }
});

// pegue a reserva e a quantidade de números a partir do array
const rRes = await query(
  `select id, user_id, status, array_length(numbers,1)::int as qty
     from reservations
    where id = $1`,
  [reservationId]
);
const r = rRes.rows[0];
if (!r) return res.status(404).json({ error: 'reserva não encontrada' });

// preço unitário: PRICE_CENTS/100 (ex.: 5500 => 55.00)
const unit = Number(process.env.PRICE_CENTS || 5500) / 100;
const amount = Number((r.qty * unit).toFixed(2));
if (!amount) return res.status(400).json({ error: 'valor (amount) não definido' });


export default router;
