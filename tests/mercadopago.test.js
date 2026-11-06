// Mercado Pago (Checkout Pro) com a API simulada: link de pagamento com o valor do servidor, webhook assinado,
// status sempre consultado na API, idempotência e verificação ativa pela página do pedido.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { call, setupOwner, makeProduct, customer, inv, db } from "./helpers.js";

process.env.MP_ACCESS_TOKEN = "TEST-token-da-loja";
process.env.MP_WEBHOOK_SECRET = "segredo-webhook";

// ---- API do Mercado Pago simulada ----
const MP = { prefs: [], payments: {}, calls: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith("https://api.mercadopago.com")) return realFetch(url, opts);
  MP.calls.push({ url: u, opts });
  assert.equal(opts.headers.Authorization, "Bearer TEST-token-da-loja", "token só no servidor");
  const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
  if (u.endsWith("/checkout/preferences")) {
    const body = JSON.parse(opts.body); const id = "pref-" + (MP.prefs.length + 1);
    MP.prefs.push({ id, body, idem: opts.headers["X-Idempotency-Key"] });
    return json(201, { id, init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${id}` });
  }
  let m = u.match(/\/v1\/payments\/(\d+)$/);
  if (m) return MP.payments[m[1]] ? json(200, MP.payments[m[1]]) : json(404, { message: "not found" });
  m = u.match(/\/v1\/payments\/search\?external_reference=([^&]+)/);
  if (m) return json(200, { results: Object.values(MP.payments).filter(p => p.external_reference === decodeURIComponent(m[1])) });
  return json(404, {});
};
const pay = (id, orderId, status, amount, type = "bank_transfer") =>
  (MP.payments[id] = { id: Number(id), external_reference: orderId, status, status_detail: status, transaction_amount: amount,
    currency_id: "BRL", payment_type_id: type, date_last_updated: `2026-11-06T12:00:${String(Object.keys(MP.payments).length).padStart(2, "0")}Z` });

function signed(id, secret = "segredo-webhook") {
  const ts = String(Date.now()), reqId = "req-" + id + "-" + ts;
  const v1 = createHmac("sha256", secret).update(`id:${id};request-id:${reqId};ts:${ts};`).digest("hex");
  return { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": reqId };
}
const webhook = (id, headers) => call("POST", `/api/webhooks/mercadopago?data.id=${id}&type=payment`, {
  origin: false, headers, body: { type: "payment", action: "payment.updated", data: { id: String(id) } } });

let jar, product, orderRow, token;

test("pedido gera link do Mercado Pago com o valor calculado no servidor e só a forma escolhida", async () => {
  ({ jar } = await setupOwner());
  product = await makeProduct(jar, { priceCents: 250000, discountPixPct: 5 }, 3);
  const cat = await call("GET", "/api/catalog");
  assert.equal(cat.body.onlinePayment, true);

  const r = await call("POST", "/api/orders", { ip: "60.0.0.1", body: {
    items: [{ id: product.id, quantity: 2 }], customer, method: "pix", delivery: "retirada", totalCents: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.order.paymentUrl, /^https:\/\/www\.mercadopago\.com\.br\//);
  token = r.body.order.token;
  [orderRow] = await (await db()).query("SELECT * FROM orders WHERE public_token = $1", [token]);

  const pref = MP.prefs.at(-1).body;
  const total = Math.round(pref.items.reduce((s, i) => s + i.unit_price * 100 * i.quantity, 0));
  assert.equal(total, orderRow.total_cents, "Mercado Pago cobra exatamente o total do pedido");
  assert.equal(orderRow.total_cents, 2 * 237500, "PIX com 5% de desconto");
  assert.equal(pref.external_reference, orderRow.id);
  assert.deepEqual(pref.payment_methods.excluded_payment_types.map(x => x.id).sort(), ["atm", "credit_card", "debit_card", "prepaid_card", "ticket"]);
  assert.equal(pref.payer.identification.type, "CPF");
  assert.ok(pref.expires && new Date(pref.expiration_date_to).getTime() === new Date(orderRow.reserved_until).getTime(), "link vence junto com a reserva");
  assert.equal(MP.prefs.at(-1).idem, `pref-${orderRow.id}`);

  // "Pagar agora" reaproveita o mesmo link
  const again = await call("POST", `/api/orders/${token}/pay`, { ip: "60.0.0.1" });
  assert.equal(again.status, 200);
  assert.equal(again.body.paymentUrl, r.body.order.paymentUrl);
  assert.equal(MP.prefs.length, 1);
});

test("webhook: assinatura obrigatória e status consultado na API (corpo da notificação não decide nada)", async () => {
  pay("1001", orderRow.id, "approved", orderRow.total_cents / 100);
  assert.equal((await webhook("1001", {})).status, 401, "sem assinatura");
  assert.equal((await webhook("1001", signed("1001", "segredo-errado"))).status, 401, "assinatura falsa");
  assert.equal((await inv(product.id)).reserved, 2, "nada mudou");

  const ok = await webhook("1001", signed("1001"));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.result, "aprovado");
  assert.deepEqual(await inv(product.id), { on_hand: 1, reserved: 0, sold: 2 }, "reserva virou venda");
  const pub = (await call("GET", `/api/orders/${token}`)).body.order;
  assert.equal(pub.status, "pago");
  assert.equal(pub.paymentLabel, "Aprovado");

  // notificação repetida não baixa o estoque de novo
  const dup = await webhook("1001", signed("1001"));
  assert.equal(dup.body.result, "duplicado");
  assert.deepEqual(await inv(product.id), { on_hand: 1, reserved: 0, sold: 2 });

  // pagamento inexistente no Mercado Pago → erro (o Mercado Pago tenta de novo), nada muda
  assert.ok((await webhook("999999", signed("999999"))).status >= 500);
  // outros tipos de aviso só são confirmados
  const other = await call("POST", "/api/webhooks/mercadopago", { origin: false, body: { type: "merchant_order", data: { id: "5" } } });
  assert.equal(other.body.ignored, true);
});

test("sem webhook: a página do pedido confere o pagamento no Mercado Pago; estorno devolve ao estoque", async () => {
  const r = await call("POST", "/api/orders", { ip: "60.0.0.2", body: { items: [{ id: product.id, quantity: 1 }], customer, method: "pix", delivery: "retirada" } });
  const t2 = r.body.order.token;
  const [o2] = await (await db()).query("SELECT * FROM orders WHERE public_token = $1", [t2]);
  pay("2001", o2.id, "rejected", o2.total_cents / 100);
  let pub = (await call("GET", `/api/orders/${t2}`)).body.order;
  assert.equal(pub.status, "aguardando_pagamento");
  assert.equal(pub.payment_status, "recusado");
  assert.equal((await inv(product.id)).reserved, 1, "recusado: reserva continua");

  pay("2002", o2.id, "approved", o2.total_cents / 100, "credit_card");
  await (await db()).query("UPDATE orders SET payment_checked_at = NULL WHERE id = $1", [o2.id]); // pula o intervalo de 20 s
  pub = (await call("GET", `/api/orders/${t2}`)).body.order;
  assert.equal(pub.status, "pago");
  assert.deepEqual(await inv(product.id), { on_hand: 0, reserved: 0, sold: 3 });

  // estorno (aviso pelo webhook) antes da entrega → volta ao estoque
  MP.payments["2002"] = { ...MP.payments["2002"], status: "refunded", date_last_updated: "2026-11-06T13:00:00Z" };
  const ref = await webhook("2002", signed("2002"));
  assert.equal(ref.body.result, "estornado");
  assert.deepEqual(await inv(product.id), { on_hand: 1, reserved: 0, sold: 2 });
});

test("pagamento com valor diferente do pedido gera ocorrência para o lojista", async () => {
  const r = await call("POST", "/api/orders", { ip: "60.0.0.3", body: { items: [{ id: product.id, quantity: 1 }], customer, method: "pix", delivery: "retirada" } });
  const [o3] = await (await db()).query("SELECT * FROM orders WHERE public_token = $1", [r.body.order.token]);
  pay("3001", o3.id, "approved", 1.0);
  await webhook("3001", signed("3001"));
  const issues = await (await db()).query("SELECT type FROM order_issues WHERE order_id = $1", [o3.id]);
  assert.ok(issues.some(i => i.type === "valor_divergente"));
});
