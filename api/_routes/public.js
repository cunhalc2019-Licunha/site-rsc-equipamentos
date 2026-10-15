// Rotas públicas do site: catálogo, pedidos (com reserva), acompanhamento do pedido e tarefas agendadas.
import { timingSafeEqual, createHash } from "node:crypto";
import { db } from "../_lib/db.js";
import { body, fail, clientIp } from "../_lib/http.js";
import { rateLimit } from "../_lib/rate.js";
import { text, email as parseEmail } from "../_lib/validate.js";
import { resolvePublicStore, settingsOf } from "../_lib/store.js";
import { createOnlineOrder, expireReservations } from "../_lib/orders.js";

const CONDITION = { novo: "Novo", seminovo: "Seminovo", usado_revisado: "Usado revisado" };
const ALL_METHODS = ["pix", "card", "boleto"];
const ORDER_STATUS = { aguardando_pagamento: "Aguardando pagamento", pago: "Pago", em_processamento: "Em processamento",
  concluido: "Concluído", cancelado: "Cancelado", expirado: "Expirado", estornado: "Estornado" };

// Verificação oportunista de reservas vencidas (garante consistência mesmo se o cron atrasar).
let lastSweep = 0;
async function sweep(storeId) {
  if (Date.now() - lastSweep < 30_000) return;
  lastSweep = Date.now();
  await expireReservations(await db(), { storeId, limit: 50 }).catch(e => console.error("[expiração]", e.message));
}

export default [
  // Catálogo público no MESMO formato do antigo data/products.json.
  // Só entram produtos ativos, publicados, com foto e com estoque DISPONÍVEL (físico − reservado > 0).
  ["GET", "/catalog", async (req, res) => {
    const store = await resolvePublicStore(req);
    if (!store) return { configured: false, sectors: [], products: [] };
    await sweep(store.id);
    const q = await db();
    const products = await q.query(`
      SELECT p.id, p.slug, p.name, p.brand, p.description, p.specs, p.condition, p.price_cents, p.promo_price_cents,
             p.discount_pix_pct, p.discount_card_pct, p.payment_methods, p.badge, p.sell_online, p.stock_type,
             i.on_hand - i.reserved AS available, c.slug AS sector,
             COALESCE((SELECT json_agg(url ORDER BY position) FROM product_images WHERE product_id = p.id), '[]') AS images
        FROM products p
        JOIN inventory i ON i.product_id = p.id
        JOIN categories c ON c.id = p.category_id AND c.active
       WHERE p.store_id = $1 AND p.state = 'ativo' AND p.published AND i.on_hand - i.reserved > 0
       ORDER BY p.updated_at DESC`, [store.id]);
    const categories = await q.query(
      "SELECT slug, name, description, cover_url FROM categories WHERE store_id = $1 AND active ORDER BY position, name", [store.id]);

    const out = products.filter(p => p.images.length).map(p => {
      const discounts = {};
      if (Number(p.discount_pix_pct)) discounts.pix = Number(p.discount_pix_pct);
      if (Number(p.discount_card_pct)) discounts.card = Number(p.discount_card_pct);
      const methods = ALL_METHODS.filter(m => p.payment_methods.includes(m));
      const sale = p.promo_price_cents || p.price_cents;
      return {
        id: p.slug, uid: p.id, name: p.name, brand: p.brand || "", sector: p.sector, images: p.images,
        price: sale ? sale / 100 : null,
        ...(p.promo_price_cents ? { oldPrice: p.price_cents / 100 } : {}),
        ...(Object.keys(discounts).length ? { discounts } : {}),
        ...(methods.length < ALL_METHODS.length ? { methods } : {}),
        ...(p.badge ? { badge: p.badge } : {}),
        condition: CONDITION[p.condition], stock: Math.max(0, p.available), online: p.sell_online,
        desc: p.description || "", specs: Object.fromEntries((p.specs || []).map(s => [s.k, s.v])),
      };
    });
    const sectors = categories.filter(c => out.some(p => p.sector === c.slug)).map(c => ({
      slug: c.slug, name: c.name, desc: c.description || "", cover: c.cover_url || out.find(p => p.sector === c.slug).images[0],
    }));
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=15, stale-while-revalidate=30");
    return { configured: true, reservationHours: settingsOf(store).reservationHours, sectors, products: out };
  }],

  // Checkout: cria o pedido e reserva os itens. O navegador envia SÓ produto + quantidade + dados do cliente.
  // Preço, total, disponibilidade e prazo da reserva são decididos aqui.
  ["POST", "/orders", async req => {
    const store = await resolvePublicStore(req);
    if (!store) fail(503, "Loja ainda não configurada.");
    await rateLimit(`checkout:${clientIp(req)}`, 10, 3600, "Muitos pedidos em sequência. Aguarde e tente novamente.");
    await sweep(store.id);
    const b = body(req);
    const method = ALL_METHODS.includes(b.method) ? b.method : fail(422, "Forma de pagamento inválida.");
    const delivery = b.delivery === "entrega" ? "entrega" : "retirada";
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) fail(422, "Carrinho vazio ou inválido.");
    const c = b.customer || {};
    const customer = {
      name: text(c.name, "Nome", { required: true, max: 120 }),
      email: parseEmail(c.email),
      phone: text(c.phone, "Telefone", { required: true, max: 30 }),
      document: text(c.document, "CPF/CNPJ", { required: true, max: 20 }),
    };
    const digits = customer.document.replace(/\D/g, "");
    if (digits.length !== 11 && digits.length !== 14) fail(422, "CPF ou CNPJ inválido.");
    let address = null;
    if (delivery === "entrega") {
      const a = b.address || {};
      address = {
        cep: text(a.cep, "CEP", { required: true, max: 10 }), street: text(a.street, "Endereço", { required: true, max: 160 }),
        number: text(a.number, "Número", { required: true, max: 20 }), comp: text(a.comp, "Complemento", { max: 80 }),
        district: text(a.district, "Bairro", { required: true, max: 80 }), city: text(a.city, "Cidade", { required: true, max: 80 }),
        uf: text(a.uf, "UF", { required: true, max: 2 }),
      };
    }
    const q = await db();
    // aceita o slug (id do site) ou o uuid do produto
    const items = [];
    for (const it of b.items) {
      const qty = Number(it.quantity ?? it.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 100) fail(422, "Quantidade inválida.");
      const [p] = await q.query("SELECT id FROM products WHERE store_id = $1 AND (slug = $2 OR id::text = $2)", [store.id, String(it.id || it.productId || "")]);
      if (!p) fail(404, "Produto não encontrado.", { code: "UNAVAILABLE", productId: it.id });
      items.push({ productId: p.id, quantity: qty });
    }
    const order = await q.tx(t => createOnlineOrder(t, store.id, { items, customer, method, delivery, address }));
    return { order: { number: order.number, token: order.public_token, reservedUntil: order.reserved_until, totalCents: order.total_cents } };
  }],

  // Acompanhamento do pedido pelo cliente (link com token secreto, sem login).
  ["GET", "/orders/:token", async req => {
    const q = await db();
    const [o] = await q.query(
      `SELECT o.id, o.number, o.status, o.payment_status, o.payment_method, o.delivery, o.total_cents, o.discount_cents,
              o.subtotal_cents, o.reserved_until, o.created_at
         FROM orders o WHERE o.public_token = $1 AND o.channel = 'online'`, [req.params.token]);
    if (!o) fail(404, "Pedido não encontrado.");
    const items = await q.query("SELECT name, sku, quantity, unit_price_cents, total_cents FROM order_items WHERE order_id = $1", [o.id]);
    delete o.id;
    return { order: { ...o, statusLabel: ORDER_STATUS[o.status], items } };
  }],

  // Tarefa agendada (Vercel Cron ou serviço externo): processa reservas vencidas de todas as lojas.
  ["GET", "/cron/expire-reservations", async req => {
    const secret = process.env.CRON_SECRET;
    const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const h = s => createHash("sha256").update(s).digest();
    if (!secret || !timingSafeEqual(h(got), h(secret))) fail(401, "Não autorizado.");
    const released = await expireReservations(await db(), { limit: 500 });
    return { ok: true, released };
  }, { skipOrigin: true }],

  // Webhook do Mercado Pago: estrutura reservada para a ETAPA 3. Ainda não processa nada.
  ["POST", "/webhooks/mercadopago", async () => {
    fail(501, "Integração com o Mercado Pago será ativada na etapa 3.");
  }, { skipOrigin: true }],
];
