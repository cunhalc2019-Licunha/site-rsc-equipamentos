// Pedidos online, reservas com prazo, venda física e expiração automática.
import { randomBytes } from "node:crypto";
import { fail } from "./http.js";
import { lockInventory, move, available } from "./stock.js";
import { nextNumber, settingsOf, getStore } from "./store.js";

// Preço de venda definido SEMPRE pelo banco (o navegador só envia id e quantidade).
export function unitPrice(p, method) {
  const base = p.promo_price_cents || p.price_cents;
  const pct = method === "pix" ? Number(p.discount_pix_pct) : method === "card" ? Number(p.discount_card_pct) : 0;
  return Math.round(base * (1 - (pct || 0) / 100));
}

async function upsertCustomer(t, storeId, c) {
  if (c.email) {
    const [ex] = await t.query("SELECT id FROM customers WHERE store_id = $1 AND lower(email) = lower($2)", [storeId, c.email]);
    if (ex) {
      await t.query("UPDATE customers SET name = $2, phone = $3, document = $4, updated_at = now() WHERE id = $1", [ex.id, c.name, c.phone, c.document]);
      return ex.id;
    }
  }
  const [row] = await t.query("INSERT INTO customers (store_id, name, email, phone, document) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [storeId, c.name, c.email || null, c.phone || null, c.document || null]);
  return row.id;
}

// Checkout online: cria o pedido e RESERVA o estoque por N horas (padrão 24h), de forma transacional.
// items: [{ productId, quantity }]
export async function createOnlineOrder(t, storeId, { items, customer, method, delivery, address }) {
  const store = await getStore(storeId, t);
  const hours = settingsOf(store).reservationHours;
  const merged = {};
  for (const it of items) merged[it.productId] = (merged[it.productId] || 0) + it.quantity;
  const ids = Object.keys(merged);

  const prods = await t.query(
    `SELECT id, sku, name, condition, stock_type, price_cents, promo_price_cents, discount_pix_pct, discount_card_pct,
            payment_methods, state, published, sell_online
       FROM products WHERE store_id = $1 AND id = ANY($2::uuid[])`, [storeId, ids]);
  if (prods.length !== ids.length) fail(404, "Um ou mais produtos não foram encontrados.");
  const invs = await lockInventory(t, storeId, ids); // trava na mesma ordem em todas as transações (evita deadlock)

  for (const p of prods) {
    const q = merged[p.id];
    if (p.state !== "ativo" || !p.published || !p.sell_online || !p.price_cents)
      fail(409, `"${p.name}" não está disponível para compra online.`, { code: "UNAVAILABLE", productId: p.id });
    if (!p.payment_methods.includes(method)) fail(422, `"${p.name}" não aceita esta forma de pagamento.`);
    if (p.stock_type === "unico" && q > 1) fail(422, `"${p.name}" é um produto único (máx. 1 unidade).`);
    if (available(invs[p.id]) < q)
      fail(409, `"${p.name}" acabou de ser reservado ou vendido. Disponível agora: ${Math.max(0, available(invs[p.id]))}.`, { code: "UNAVAILABLE", productId: p.id });
  }

  const customerId = await upsertCustomer(t, storeId, customer);
  const number = await nextNumber(t, storeId, "order");
  const lines = prods.map(p => ({ p, q: merged[p.id], unit: unitPrice(p, method), full: p.promo_price_cents || p.price_cents }));
  const subtotal = lines.reduce((s, l) => s + l.full * l.q, 0);
  const total = lines.reduce((s, l) => s + l.unit * l.q, 0);
  const token = randomBytes(18).toString("base64url");

  const [order] = await t.query(
    `INSERT INTO orders (store_id, number, channel, customer_id, status, payment_status, payment_method, delivery, address,
        subtotal_cents, discount_cents, total_cents, reserved_until, public_token)
     VALUES ($1,$2,'online',$3,'aguardando_pagamento','pendente',$4,$5,$6,$7,$8,$9, now() + make_interval(hours => $10), $11)
     RETURNING id, number, reserved_until, public_token, total_cents`,
    [storeId, number, customerId, method, delivery, address ? JSON.stringify(address) : null, subtotal, subtotal - total, total, hours, token]);

  for (const l of lines) {
    const [item] = await t.query(
      `INSERT INTO order_items (order_id, product_id, sku, name, condition, unit_price_cents, quantity, total_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [order.id, l.p.id, l.p.sku, l.p.name, l.p.condition, l.unit, l.q, l.unit * l.q]);
    const [res] = await t.query(
      `INSERT INTO reservations (store_id, order_id, order_item_id, product_id, quantity, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,'ativa',$6) RETURNING id`, [storeId, order.id, item.id, l.p.id, l.q, order.reserved_until]);
    await move(t, { storeId, inv: invs[l.p.id], type: "reserva_criada", quantity: l.q, reservedDelta: l.q,
      reason: "checkout_online", orderId: order.id, reservationId: res.id, origin: "site" });
  }
  return order;
}

// Libera reservas ativas de um pedido (cancelamento/expiração). Não mexe no estoque físico.
export async function releaseReservations(t, storeId, orderId, { status, reason, userId = null, origin = "sistema" }) {
  const rs = await t.query("SELECT * FROM reservations WHERE order_id = $1 AND store_id = $2 AND status = 'ativa' FOR UPDATE", [orderId, storeId]);
  if (!rs.length) return 0;
  const invs = await lockInventory(t, storeId, rs.map(r => r.product_id));
  for (const r of rs) {
    await t.query("UPDATE reservations SET status = $2, released_at = now(), release_reason = $3 WHERE id = $1", [r.id, status, reason]);
    await move(t, { storeId, inv: invs[r.product_id], type: "reserva_liberada", quantity: r.quantity, reservedDelta: -r.quantity,
      reason, orderId, reservationId: r.id, userId, origin });
  }
  return rs.length;
}

// Processa reservas vencidas. Idempotente: cada reserva é travada e só é liberada se ainda estiver ativa
// e se o pagamento do pedido NÃO estiver aprovado. Pode rodar várias vezes (cron + verificação oportunista).
export async function expireReservations(q, { storeId = null, limit = 200 } = {}) {
  const due = await q.query(
    `SELECT DISTINCT o.id, o.store_id FROM reservations r JOIN orders o ON o.id = r.order_id
      WHERE r.status = 'ativa' AND r.expires_at <= now() ${storeId ? "AND r.store_id = $2" : ""}
      LIMIT $1`, storeId ? [limit, storeId] : [limit]);
  let released = 0;
  for (const o of due) {
    released += await q.tx(async t => {
      const [order] = await t.query("SELECT id, status, payment_status FROM orders WHERE id = $1 FOR UPDATE", [o.id]);
      if (order.payment_status === "aprovado") {
        // Pagamento já confirmado: nunca liberar. Registra ocorrência para conferência (a conversão deveria ter ocorrido).
        await t.query(`INSERT INTO order_issues (store_id, order_id, type, description)
          SELECT $1, $2, 'reserva_vencida_com_pagamento', 'Reserva venceu mas o pagamento consta como aprovado. Conferir a baixa do pedido.'
          WHERE NOT EXISTS (SELECT 1 FROM order_issues WHERE order_id = $2 AND type = 'reserva_vencida_com_pagamento')`, [o.store_id, o.id]);
        return 0;
      }
      const n = await t.query(
        "SELECT id FROM reservations WHERE order_id = $1 AND status = 'ativa' AND expires_at <= now()", [o.id]);
      if (!n.length) return 0;
      const count = await releaseReservations(t, o.store_id, o.id, { status: "expirada", reason: "prazo_expirado" });
      if (order.status === "aguardando_pagamento") {
        await t.query("UPDATE orders SET status = 'expirado', updated_at = now() WHERE id = $1", [o.id]);
      }
      return count;
    });
  }
  return released;
}

// Cancelamento pelo lojista de um pedido que ainda aguarda pagamento.
export async function cancelOrder(t, ctx, orderId, reason) {
  const [o] = await t.query("SELECT id, status, payment_status FROM orders WHERE id = $1 AND store_id = $2 FOR UPDATE", [orderId, ctx.storeId]);
  if (!o) fail(404, "Pedido não encontrado.");
  if (o.payment_status === "aprovado") fail(409, "Pagamento aprovado: o pedido não pode ser cancelado aqui. O estorno será tratado pela integração de pagamento.");
  if (!["aguardando_pagamento"].includes(o.status)) fail(409, "Só pedidos aguardando pagamento podem ser cancelados.");
  await releaseReservations(t, ctx.storeId, orderId, { status: "cancelada", reason: `cancelado_pelo_lojista: ${reason}`, userId: ctx.user.id, origin: "painel" });
  await t.query("UPDATE orders SET status = 'cancelado', note = coalesce(note || E'\\n', '') || $2, updated_at = now() WHERE id = $1", [orderId, `Cancelado: ${reason}`]);
}

// Andamento operacional de um pedido PAGO (separação/entrega). Nunca altera o status do pagamento.
const FLOW = { pago: ["em_processamento", "concluido"], em_processamento: ["concluido"] };
export async function advanceOrder(t, ctx, orderId, next) {
  const [o] = await t.query("SELECT status, payment_status, channel FROM orders WHERE id = $1 AND store_id = $2 FOR UPDATE", [orderId, ctx.storeId]);
  if (!o) fail(404, "Pedido não encontrado.");
  if (!(FLOW[o.status] || []).includes(next)) fail(409, `Não é possível passar de "${o.status}" para "${next}".`);
  await t.query("UPDATE orders SET status = $2, updated_at = now() WHERE id = $1", [orderId, next]);
  return o.status;
}

// Venda física (balcão). Consome apenas o estoque DISPONÍVEL.
// override = { reason } permite (owner/admin) usar uma unidade reservada: cancela explicitamente a reserva
// conflitante, cancela o pedido online, registra ocorrência e auditoria. Nada é liberado silenciosamente.
export async function physicalSale(t, ctx, { items, paymentMethod, customerName, note, override }) {
  const merged = {};
  for (const it of items) merged[it.productId] = (merged[it.productId] || 0) + it.quantity;
  const ids = Object.keys(merged);
  const prods = await t.query(
    "SELECT id, sku, name, condition, price_cents, promo_price_cents, state FROM products WHERE store_id = $1 AND id = ANY($2::uuid[])",
    [ctx.storeId, ids]);
  if (prods.length !== ids.length) fail(404, "Produto não encontrado.");
  let invs = await lockInventory(t, ctx.storeId, ids);
  const affectedOrders = [];

  for (const p of prods) {
    const q = merged[p.id], inv = invs[p.id];
    if (p.state === "arquivado") fail(422, `"${p.name}" está arquivado.`);
    if (inv.on_hand < q) fail(422, `Estoque físico insuficiente de "${p.name}": há ${inv.on_hand}.`, { code: "INSUFFICIENT_STOCK" });
    if (available(inv) < q) {
      const rs = await t.query(
        `SELECT r.id, r.quantity, r.expires_at, o.id AS order_id, o.number FROM reservations r JOIN orders o ON o.id = r.order_id
          WHERE r.product_id = $1 AND r.status = 'ativa' ORDER BY r.expires_at DESC`, [p.id]);
      if (!override) {
        fail(409, `"${p.name}" tem ${inv.reserved} unidade(s) reservada(s) por pedido online (pedido ${rs.map(r => "#" + r.number).join(", ")}). Disponível para venda física: ${available(inv)}.`,
          { code: "RESERVED", reservations: rs.map(r => ({ order: r.number, quantity: r.quantity, expiresAt: r.expires_at })) });
      }
      // Exceção autorizada: cancela as reservas mais recentes até liberar a quantidade necessária.
      let need = q - available(inv);
      for (const r of rs) {
        if (need <= 0) break;
        const [o] = await t.query("SELECT payment_status FROM orders WHERE id = $1 FOR UPDATE", [r.order_id]);
        if (o.payment_status === "aprovado") fail(409, `O pedido #${r.number} já tem pagamento aprovado. A unidade não pode ser vendida no balcão.`);
        await releaseReservations(t, ctx.storeId, r.order_id, { status: "cancelada", reason: `venda_fisica_autorizada: ${override.reason}`, userId: ctx.user.id, origin: "painel" });
        await t.query("UPDATE orders SET status = 'cancelado', note = coalesce(note || E'\\n', '') || $2, updated_at = now() WHERE id = $1",
          [r.order_id, `Reserva cancelada para venda física autorizada por ${ctx.user.name}: ${override.reason}`]);
        await t.query(`INSERT INTO order_issues (store_id, order_id, type, description) VALUES ($1, $2, 'reserva_cancelada_venda_fisica', $3)`,
          [ctx.storeId, r.order_id, `Pedido #${r.number} cancelado: unidade vendida no balcão. Motivo: ${override.reason}. Avisar o cliente.`]);
        affectedOrders.push(r.number);
        need -= r.quantity;
      }
      invs = await lockInventory(t, ctx.storeId, ids);
    }
  }

  const number = await nextNumber(t, ctx.storeId, "order");
  const lines = prods.map(p => ({ p, q: merged[p.id], unit: p.promo_price_cents || p.price_cents || 0 }));
  const total = lines.reduce((s, l) => s + l.unit * l.q, 0);
  const [order] = await t.query(
    `INSERT INTO orders (store_id, number, channel, customer_id, status, payment_status, payment_method, subtotal_cents, total_cents, public_token, note, created_by)
     VALUES ($1,$2,'loja',NULL,'concluido','aprovado',$3,$4,$4,$5,$6,$7) RETURNING id, number`,
    [ctx.storeId, number, paymentMethod, total, randomBytes(18).toString("base64url"),
     [customerName && `Cliente: ${customerName}`, note].filter(Boolean).join("\n") || null, ctx.user.id]);
  await t.query(`INSERT INTO payments (store_id, order_id, provider, status, method, amount_cents) VALUES ($1,$2,'presencial','aprovado',$3,$4)`,
    [ctx.storeId, order.id, paymentMethod, total]);
  for (const l of lines) {
    await t.query(`INSERT INTO order_items (order_id, product_id, sku, name, condition, unit_price_cents, quantity, total_cents)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [order.id, l.p.id, l.p.sku, l.p.name, l.p.condition, l.unit, l.q, l.unit * l.q]);
    await move(t, { storeId: ctx.storeId, inv: invs[l.p.id], type: "venda_fisica", quantity: l.q, physicalDelta: -l.q, soldDelta: l.q,
      reason: override ? "venda_fisica_autorizada" : "venda_fisica", note: override ? `Exceção autorizada: ${override.reason}` : note,
      userId: ctx.user.id, orderId: order.id, origin: "painel" });
  }
  return { ...order, total_cents: total, affectedOrders };
}
