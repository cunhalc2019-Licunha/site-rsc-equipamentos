// Função serverless (Vercel) — cria a preferência de pagamento no Mercado Pago (Checkout Pro).
// Variáveis de ambiente necessárias na Vercel:
//   MP_ACCESS_TOKEN  → Access Token de produção (ou de teste) do Mercado Pago
//   SITE_URL         → URL pública do site, ex.: https://rscequipamentos.com.br
//
// Os preços SEMPRE são recalculados aqui a partir de data/products.json —
// nunca confiamos no valor enviado pelo navegador.
import { readFileSync } from "node:fs";
import path from "node:path";

const catalog = JSON.parse(readFileSync(path.join(process.cwd(), "data", "products.json"), "utf8"));
const ALL_METHODS = ["pix", "card", "boleto"];
// Tipos de pagamento do Mercado Pago que NÃO devem aparecer para cada método escolhido no site
const EXCLUDE = {
  pix:    ["credit_card", "debit_card", "ticket", "atm", "prepaid_card"],
  card:   ["bank_transfer", "ticket", "atm"],
  boleto: ["credit_card", "debit_card", "bank_transfer", "atm", "prepaid_card"],
};

const unitPrice = (p, method) => Math.round(p.price * (1 - ((p.discounts || {})[method] || 0) / 100) * 100) / 100;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });
  const { MP_ACCESS_TOKEN, SITE_URL } = process.env;
  if (!MP_ACCESS_TOKEN || !SITE_URL) return res.status(500).json({ error: "Pagamento não configurado" });

  const { items = [], method, delivery, buyer = {} } = req.body || {};
  if (!ALL_METHODS.includes(method)) return res.status(400).json({ error: "Forma de pagamento inválida" });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Carrinho vazio" });

  const mpItems = [];
  for (const { id, qty } of items) {
    const p = catalog.products.find(x => x.id === id);
    const q = Number.parseInt(qty, 10);
    if (!p || !p.price) return res.status(400).json({ error: `Produto indisponível para compra online: ${id}` });
    if (!(q >= 1 && q <= (p.stock || 99))) return res.status(400).json({ error: `Quantidade inválida: ${p.name}` });
    if (!(p.methods || ALL_METHODS).includes(method)) return res.status(400).json({ error: `${p.name} não aceita esta forma de pagamento` });
    mpItems.push({
      id: p.id,
      title: `${p.name} — ${p.brand}`,
      quantity: q,
      unit_price: unitPrice(p, method),
      currency_id: "BRL",
      picture_url: `${SITE_URL}/${p.images[0]}`,
      category_id: "home",
    });
  }

  const orderId = "RSC-" + Date.now().toString(36).toUpperCase();
  const digits = s => String(s || "").replace(/\D/g, "");
  const doc = digits(buyer.doc);
  const phone = digits(buyer.phone);
  const [first, ...rest] = String(buyer.name || "").trim().split(/\s+/);

  const preference = {
    items: mpItems,
    external_reference: orderId,
    statement_descriptor: "RSC EQUIPAMENTOS",
    payer: {
      name: first, surname: rest.join(" "),
      email: buyer.email,
      phone: { area_code: phone.slice(0, 2), number: phone.slice(2) },
      identification: { type: doc.length === 14 ? "CNPJ" : "CPF", number: doc },
      ...(buyer.address ? { address: { zip_code: digits(buyer.address.cep), street_name: buyer.address.street, street_number: buyer.address.number } } : {}),
    },
    payment_methods: { excluded_payment_types: EXCLUDE[method].map(id => ({ id })), installments: 12 },
    back_urls: {
      success: `${SITE_URL}/#/pedido/sucesso`,
      pending: `${SITE_URL}/#/pedido/pendente`,
      failure: `${SITE_URL}/#/pedido/falha`,
    },
    auto_return: "approved",
    notification_url: `${SITE_URL}/api/webhook`,
    metadata: { delivery, address: buyer.address || null, buyer_phone: buyer.phone, method },
  };

  const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, "Content-Type": "application/json", "X-Idempotency-Key": orderId },
    body: JSON.stringify(preference),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("Mercado Pago:", data);
    return res.status(502).json({ error: "Erro ao criar pagamento" });
  }
  return res.status(200).json({ order_id: orderId, init_point: data.init_point });
}
