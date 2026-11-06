// Ponte entre o Mercado Pago e os pedidos: gera o link de pagamento e aplica o status REAL consultado na API.
import { db } from "./db.js";
import { applyPaymentStatus, recordEvent } from "./payments.js";
import { createPreference, getPayment, searchPayments, mapStatus, mapMethod, mpConfigured } from "./mercadopago.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cria (ou reaproveita) o link de pagamento do pedido. Só para pedido aguardando pagamento e com reserva válida.
export async function paymentLink(orderId, baseUrl) {
  if (!mpConfigured()) return null;
  const q = await db();
  const [order] = await q.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  if (!order || order.status !== "aguardando_pagamento" || new Date(order.reserved_until) <= new Date()) return null;
  if (order.payment_url) return order.payment_url;
  const items = await q.query("SELECT product_id, sku, name, quantity, unit_price_cents FROM order_items WHERE order_id = $1", [orderId]);
  const [customer] = await q.query("SELECT name, email, phone, document FROM customers WHERE id = $1", [order.customer_id]);
  const pref = await createPreference({ order, items, customer: customer || {}, baseUrl });
  await q.query("UPDATE orders SET payment_url = $2, payment_pref_id = $3 WHERE id = $1 AND payment_url IS NULL", [orderId, pref.url, pref.id]);
  return pref.url;
}

// Aplica um pagamento já CONSULTADO na API do Mercado Pago. Eventos repetidos são ignorados.
export async function applyMpPayment(payment) {
  const orderId = String(payment.external_reference || "");
  if (!UUID.test(orderId)) return { result: "ignorado_sem_pedido" };
  const q = await db();
  const [order] = await q.query("SELECT id FROM orders WHERE id = $1 AND channel = 'online'", [orderId]);
  if (!order) return { result: "ignorado_pedido_desconhecido" };
  if (payment.currency_id && payment.currency_id !== "BRL") return { result: "ignorado_moeda" };
  const status = mapStatus(payment.status);
  const eventId = `payment:${payment.id}:${payment.status}:${payment.date_last_updated || ""}`;
  return q.tx(async t => {
    if (!(await recordEvent(t, "mercadopago", eventId, { id: payment.id, status: payment.status, status_detail: payment.status_detail })))
      return { result: "duplicado" };
    const r = await applyPaymentStatus(t, { orderId, provider: "mercadopago", externalId: String(payment.id), status,
      amountCents: payment.transaction_amount != null ? Math.round(Number(payment.transaction_amount) * 100) : null,
      method: mapMethod(payment.payment_type_id),
      raw: { id: payment.id, status: payment.status, status_detail: payment.status_detail, payment_method_id: payment.payment_method_id,
        payment_type_id: payment.payment_type_id, installments: payment.installments, date_approved: payment.date_approved } });
    await t.query("UPDATE payment_events SET processed_at = now() WHERE provider = 'mercadopago' AND event_id = $1", [eventId]);
    return r;
  });
}

export async function applyMpPaymentId(paymentId) {
  return applyMpPayment(await getPayment(paymentId));
}

// Verificação ativa (não depende do webhook): consulta os pagamentos do pedido, no máximo a cada 20 s.
export async function syncOrder(orderId) {
  if (!mpConfigured()) return;
  const q = await db();
  const rows = await q.query(
    `UPDATE orders SET payment_checked_at = now()
      WHERE id = $1 AND payment_pref_id IS NOT NULL AND status IN ('aguardando_pagamento','expirado','cancelado')
        AND (payment_checked_at IS NULL OR payment_checked_at < now() - interval '20 seconds') RETURNING id`, [orderId]);
  if (!rows.length) return;
  const payments = await searchPayments(orderId);
  // aplica do mais antigo para o mais recente (o último estado vale)
  for (const p of payments.reverse()) await applyMpPayment(p);
}
