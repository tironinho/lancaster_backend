// src/routes/payments.js
import express from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db/pg.js';
import { createPixPayment, getPayment } from '../payments/mercadopago.js';

const router = express.Router();

/** Decodifica o usuário do Authorization: Bearer <token>
 *  - Se JWT_PUBLIC_KEY estiver definido: verifica RS256 com chave pública
 *  - Senão: verifica HS256 com JWT_SECRET (ou AUTH_SECRET)
 *  - Se DISABLE_AUTH=1, permite cabeçalhos x-user-* (apenas p/ teste)
 */
function resolveUser(req) {
  // 1) Se outro middleware já populou req.user
  if (req.user) return req.user;

  // 2) Tenta Bearer JWT
  const hdr = req.headers.authorization || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const token = m[1];
    try {
      let payload;
      if (process.env.JWT_PUBLIC_KEY) {
        // RS256
        payload = jwt.verify(token, process.env.JWT_PUBLIC_KEY, {
          algorithms: ['RS256'],
        });
      } else {
        // HS256 (padrão)
        const secret = process.env.JWT_SECRET || process.env.AUTH_SECRET;
        if (!secret) throw new Error('JWT_SECRET/AUTH_SECRET ausente');
        payload = jwt.verify(token, secret, { algorithms: ['HS256', 'HS512'] });
      }

      const user =
        payload?.user && typeof payload.user === 'object'
          ? payload.user
          : {};

      return {
        id:
          payload.sub ||
          payload.id ||
          payload.userId ||
          user.id,
        email: payload.email || user.email,
        name: payload.name || user.name,
        role: payload.role || user.role,
        ...user,
      };
    } catch (_e) {
      // continua para fallback de teste, se habilitado
    }
  }

  // 3) Fallback de teste (não usar em produção)
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
  if (!u || !u.id) {
    return res.status(401).json({ error: 'unauthorized' });
  }
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

    // 1) Carrega reserva
    const rRes = await query(
      `select id, user_id, status, coalesce(amount,0) as amount
         from reservations
        where id = $1`,
      [reservationId]
    );
    const r = rRes.rows[0];
    if (!r) return res.status(404).json({ error: 'reserva não encontrada' });
    if (String(r.user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (r.status && !['pendente','reservado',null].includes(r.status)) {
      return res.status(409).json({ error: `reserva com status ${r.status}` });
    }

    // 2) Define amount: usa coluna amount; senão calcula por quantidade*preço
    let amount = Number(r.amount || 0);
    if (!amount) {
      // verifica se existe tabela reservation_numbers
      const tRes = await query(`select to_regclass('public.reservation_numbers') as t`);
      if (tRes.rows[0]?.t) {
        const nRes = await query(
          `select count(*)::int as n from reservation_numbers where reservation_id = $1`,
          [reservationId]
        );
        const n = nRes.rows[0]?.n || 0;
        const unit = Number(process.env.NUMBER_PRICE || 55);
        amount = n * unit;
      }
      if (!amount) return res.status(400).json({ error: 'valor (amount) não definido para a reserva' });
    }

    // 3) Cria PIX no Mercado Pago
    const name = String(req.user.name || '').trim();
    const payer = {
      email: req.user.email,
      first_name: name.split(' ')[0] || undefined,
      last_name: name.split(' ').slice(1).join(' ') || undefined,
    };

    const pay = await createPixPayment({
      amount,
      description: `Reserva ${reservationId}`,
      reservationId,
      payer,
    });

    // 4) Persiste/atualiza pagamento
    await query(
      `insert into payments (reservation_id, mp_payment_id, status, payload)
       values ($1, $2, $3, $4)
       on conflict (mp_payment_id) do update
       set status = excluded.status,
           payload = excluded.payload`,
      [reservationId, pay.paymentId, pay.status, pay.raw]
    );

    // 5) Atualiza status da reserva para pendente
    await query(
      `update reservations
          set status = 'pendente'
        where id = $1
          and (status is null or status in ('reservado','pendente'))`,
      [reservationId]
    );

    // 6) Resposta esperada pelo front
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

    // se aprovado, marca reserva como paga (ajuste lógica dos números se quiser)
    if (p.status === 'approved') {
      const rRes = await query(
        `select reservation_id from payments where mp_payment_id = $1`,
        [p.paymentId]
      );
      const rid = rRes.rows[0]?.reservation_id;
      if (rid) {
        await query(`update reservations set status = 'pago' where id = $1`, [rid]);
        // TODO (opcional): atualizar status dos números da reserva, se houver.
      }
    }

    res.json({ paymentId: p.paymentId, status: p.status, status_detail: p.status_detail });
  } catch (err) {
    next(err);
  }
});

export default router;
