// ESM
import { MercadoPagoConfig, Payment } from 'mercadopago';

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
if (!ACCESS_TOKEN) {
  throw new Error('MP_ACCESS_TOKEN ausente no .env');
}

const mp = new MercadoPagoConfig({
  accessToken: ACCESS_TOKEN,
  options: { timeout: 8000 },
});

const payments = new Payment(mp);

/**
 * Cria pagamento PIX e retorna dados para o front.
 * amount em BRL (number) – ex.: 55 * qtd
 */
export async function createPixPayment({ amount, description, reservationId, payer }) {
  const body = {
    transaction_amount: Number(Number(amount).toFixed(2)),
    description: description || `Reserva ${reservationId}`,
    payment_method_id: 'pix',
    payer: {
      email: payer?.email || undefined,
      first_name: payer?.first_name || undefined,
      last_name: payer?.last_name || undefined,
      identification: payer?.identification, // { type:'CPF', number:'...' } se tiver
    },
    // opcional: expiração do QR (ex.: +30 min)
    // date_of_expiration: new Date(Date.now() + 30*60*1000).toISOString(),
  };

  // Idempotência simples
  const idempotencyKey = `pix-${reservationId}-${Date.now()}`;
  const resp = await payments.create({ body }, { idempotencyKey });

  const td = resp?.point_of_interaction?.transaction_data || {};
  return {
    paymentId: String(resp.id),
    status: resp.status,
    qr_code: td.qr_code || null,               // copia-e-cola
    qr_code_base64: td.qr_code_base64 || null, // imagem
    expires_in: td.expires_in ?? 30 * 60,      // segundos
    raw: resp,
  };
}

export async function getPayment(paymentId) {
  const p = await payments.get({ id: paymentId });
  const td = p?.point_of_interaction?.transaction_data || {};
  return {
    paymentId: String(p.id),
    status: p.status,
    status_detail: p.status_detail,
    qr_code: td.qr_code || null,
    qr_code_base64: td.qr_code_base64 || null,
    expires_in: td.expires_in ?? null,
    raw: p,
  };
}
