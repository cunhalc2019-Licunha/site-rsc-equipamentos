// Integração com o Mercado Pago (Checkout Pro).
// • O site cria uma "preferência" com o valor CALCULADO NO SERVIDOR e manda o cliente para a página do Mercado Pago.
// • A confirmação NUNCA vem do navegador: o webhook (e a verificação na página do pedido) CONSULTA o pagamento
//   na API do Mercado Pago com o Access Token da loja e só então aplica o status (applyPaymentStatus).
// Variáveis: MP_ACCESS_TOKEN (obrigatória, secreta) e MP_WEBHOOK_SECRET (assinatura das notificações, recomendada).
import { createHmac, timingSafeEqual } from "node:crypto";
import { fail } from "./http.js";

const API = "https://api.mercadopago.com";
export const mpConfigured = () => !!(process.env.MP_ACCESS_TOKEN || "").trim();

async function mp(path, { method = "GET", body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN.trim()}`, "Content-Type": "application/json" };
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
  let r;
  try { r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { fail(502, "Não foi possível falar com o Mercado Pago agora. Tente novamente."); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("[mercadopago]", method, path, r.status, data?.message || "");
    fail(r.status === 401 ? 503 : 502, r.status === 401
      ? "Credencial do Mercado Pago inválida no servidor (MP_ACCESS_TOKEN)."
      : "O Mercado Pago recusou a operação. Tente novamente em instantes.");
  }
  return data;
}

// Cada forma de pagamento do site tem seu preço (ex.: desconto no PIX), então o Mercado Pago só oferece a escolhida.
const EXCLUDE = {
  pix: ["credit_card", "debit_card", "ticket", "atm", "prepaid_card"],
  card: ["ticket", "atm", "bank_transfer"],
  boleto: ["credit_card", "debit_card", "bank_transfer", "atm", "prepaid_card"],
};

// order: linha de orders; items: order_items; customer: { name, email, document, phone }; baseUrl: https://dominio
export async function createPreference({ order, items, customer, baseUrl }) {
  const cents = c => Math.round(c) / 100;
  let lines = items.map(i => ({ id: i.sku || String(i.product_id), title: String(i.name).slice(0, 250), quantity: i.quantity,
    unit_price: cents(i.unit_price_cents), currency_id: "BRL" }));
  if (order.shipping_cents > 0) lines.push({ id: "frete", title: "Frete (entrega própria RSC)", quantity: 1, unit_price: cents(order.shipping_cents), currency_id: "BRL" });
  // O total cobrado tem que ser exatamente o do pedido; se o detalhamento não fechar, cobra numa linha só.
  const sum = Math.round(lines.reduce((s, l) => s + l.unit_price * 100 * l.quantity, 0));
  if (sum !== order.total_cents) lines = [{ id: `pedido-${order.number}`, title: `Pedido #${order.number} — RSC Equipamentos`, quantity: 1, unit_price: cents(order.total_cents), currency_id: "BRL" }];

  const doc = String(customer.document || "").replace(/\D/g, "");
  const [first, ...rest] = String(customer.name || "").trim().split(/\s+/);
  const https = /^https:\/\//.test(baseUrl);
  const back = `${baseUrl}/?pedido=${encodeURIComponent(order.public_token)}`;
  const body = {
    items: lines,
    external_reference: order.id,
    statement_descriptor: "RSC EQUIPAMENTOS",
    payer: { name: first || undefined, surname: rest.join(" ") || undefined, email: customer.email || undefined,
      ...(doc.length === 11 || doc.length === 14 ? { identification: { type: doc.length === 11 ? "CPF" : "CNPJ", number: doc } } : {}) },
    payment_methods: { excluded_payment_types: (EXCLUDE[order.payment_method] || []).map(id => ({ id })), installments: 12 },
    back_urls: { success: back, pending: back, failure: back },
    // a página do Mercado Pago deixa de aceitar pagamento quando a reserva vence
    expires: true, expiration_date_to: new Date(order.reserved_until).toISOString(),
    metadata: { pedido: order.number },
  };
  if (https) { body.auto_return = "approved"; body.notification_url = `${baseUrl}/api/webhooks/mercadopago?source_news=webhooks`; }
  if (order.payment_method === "boleto") body.date_of_expiration = new Date(order.reserved_until).toISOString();
  const pref = await mp("/checkout/preferences", { method: "POST", body, idempotencyKey: `pref-${order.id}` });
  return { id: pref.id, url: pref.init_point };
}

export const getPayment = id => mp(`/v1/payments/${encodeURIComponent(id)}`);
export const searchPayments = externalRef =>
  mp(`/v1/payments/search?external_reference=${encodeURIComponent(externalRef)}&sort=date_last_updated&criteria=desc&limit=10`).then(r => r.results || []);

export function mapStatus(s) {
  if (s === "approved") return "aprovado";
  if (["pending", "in_process", "authorized", "in_mediation"].includes(s)) return "pendente";
  if (s === "rejected") return "recusado";
  if (["cancelled", "expired"].includes(s)) return "cancelado";
  if (["refunded", "charged_back"].includes(s)) return "estornado";
  return "desconhecido";
}
export function mapMethod(type) {
  if (type === "bank_transfer") return "pix";
  if (["credit_card", "debit_card", "prepaid_card"].includes(type)) return "card";
  if (type === "ticket" || type === "atm") return "boleto";
  return type || null;
}

// Assinatura das notificações (cabeçalho x-signature). Sem MP_WEBHOOK_SECRET a checagem é pulada, mas o
// status continua vindo SÓ da consulta à API (uma notificação falsa não consegue aprovar nada).
export function verifySignature(req, dataId) {
  const secret = (process.env.MP_WEBHOOK_SECRET || "").trim();
  if (!secret) return true;
  const parts = Object.fromEntries(String(req.headers["x-signature"] || "").split(",").map(p => p.trim().split("=")));
  const reqId = req.headers["x-request-id"] || "";
  if (!parts.ts || !parts.v1) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : dataId;
  // valores ausentes ficam fora do texto assinado (regra do Mercado Pago)
  const manifest = `${id ? `id:${id};` : ""}${reqId ? `request-id:${reqId};` : ""}ts:${parts.ts};`;
  const expected = createHmac("sha256", secret).update(manifest).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(String(parts.v1));
  return a.length === b.length && timingSafeEqual(a, b);
}
