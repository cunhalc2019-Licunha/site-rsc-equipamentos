// Rotas do painel administrativo. Todas exigem sessão válida, e-mail confirmado e permissão.
// A loja (storeId) vem da sessão — nunca do navegador.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../_lib/db.js";
import { body, fail } from "../_lib/http.js";
import { requireUser, audit, can } from "../_lib/auth.js";
import { text, int, bool, uuid, oneOf, email as parseEmail, slugify } from "../_lib/validate.js";
import { parseProduct, parseEntry, createProduct, updateProduct, setProductState, listProducts, getProduct, stockEntry } from "../_lib/products.js";
import { lockInventory, move, ADJUST_REASONS } from "../_lib/stock.js";
import { physicalSale, cancelOrder, advanceOrder, expireReservations } from "../_lib/orders.js";
import { getStore, settingsOf } from "../_lib/store.js";
import { sendInvite } from "./auth.js";

const tx = async fn => (await db()).tx(fn);
const q = async (sql, params) => (await db()).query(sql, params);

async function freshen(ctx) { await expireReservations(await db(), { storeId: ctx.storeId, limit: 50 }).catch(() => {}); }

function detectImage(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", type: "image/png" };
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return { ext: "webp", type: "image/webp" };
  return null;
}

const MOVEMENTS_SQL = `
  SELECT m.id, m.type, m.quantity, m.physical_delta, m.reserved_delta, m.physical_before, m.physical_after,
         m.reserved_before, m.reserved_after, m.reason, m.unit_cost_cents, m.supplier, m.document, m.note, m.origin,
         m.movement_date, m.created_at, p.id AS product_id, p.name AS product_name, p.sku,
         u.name AS user_name, o.number AS order_number, o.id AS order_id
    FROM stock_movements m JOIN products p ON p.id = m.product_id
    LEFT JOIN users u ON u.id = m.user_id LEFT JOIN orders o ON o.id = m.order_id
   WHERE m.store_id = $1`;

export default [
  // ---------- Visão geral ----------
  ["GET", "/admin/dashboard", async (req, res) => {
    const ctx = await requireUser(req, res, "catalog.read");
    await freshen(ctx);
    const s = ctx.storeId;
    const [k] = await q(`
      SELECT
        count(*) FILTER (WHERE p.state = 'ativo')::int AS active,
        count(*) FILTER (WHERE p.state = 'ativo' AND p.published AND i.on_hand - i.reserved > 0)::int AS available,
        count(*) FILTER (WHERE i.reserved > 0)::int AS reserved,
        count(*) FILTER (WHERE p.state = 'ativo' AND i.on_hand = 0)::int AS out_of_stock
      FROM products p JOIN inventory i ON i.product_id = p.id WHERE p.store_id = $1`, [s]);
    const [o] = await q(`
      SELECT
        count(*) FILTER (WHERE channel = 'online' AND status = 'aguardando_pagamento')::int AS awaiting,
        count(*) FILTER (WHERE channel = 'online' AND payment_status = 'aprovado' AND status IN ('pago','em_processamento','concluido'))::int AS paid,
        count(*) FILTER (WHERE channel = 'loja' AND created_at > now() - interval '30 days')::int AS physical_30d,
        coalesce(sum(total_cents) FILTER (WHERE channel = 'loja' AND created_at > now() - interval '30 days'), 0)::bigint AS physical_30d_total,
        count(*) FILTER (WHERE channel = 'online' AND payment_status = 'aprovado' AND created_at > now() - interval '30 days')::int AS online_30d,
        coalesce(sum(total_cents) FILTER (WHERE channel = 'online' AND payment_status = 'aprovado' AND created_at > now() - interval '30 days'), 0)::bigint AS online_30d_total
      FROM orders WHERE store_id = $1`, [s]);
    const expiring = await q(`
      SELECT r.id, r.quantity, r.expires_at, p.name, p.sku, o.number, o.id AS order_id
        FROM reservations r JOIN products p ON p.id = r.product_id JOIN orders o ON o.id = r.order_id
       WHERE r.store_id = $1 AND r.status = 'ativa' AND r.expires_at < now() + interval '6 hours'
       ORDER BY r.expires_at LIMIT 20`, [s]);
    const [{ issues }] = await q("SELECT count(*)::int AS issues FROM order_issues WHERE store_id = $1 AND status = 'aberta'", [s]);
    const movements = await q(MOVEMENTS_SQL + " ORDER BY m.created_at DESC LIMIT 10", [s]);
    return { products: k, orders: { ...o, physical_30d_total: Number(o.physical_30d_total), online_30d_total: Number(o.online_30d_total) }, expiring, issues, movements };
  }],

  // ---------- Produtos ----------
  ["GET", "/admin/products", async (req, res) => {
    const ctx = await requireUser(req, res, "catalog.read");
    const store = await getStore(ctx.storeId);
    return { products: await listProducts(await db(), ctx.storeId, req.query, settingsOf(store).lowStockThreshold) };
  }],

  ["POST", "/admin/products", async (req, res) => {
    const ctx = await requireUser(req, res, "products.write");
    const b = body(req);
    const p = parseProduct(b);
    const entry = parseEntry({ ...(b.initialEntry || {}), origin: b.initialEntry?.origin || "estoque_inicial" }, { allowZero: true });
    const id = await tx(async t => {
      const id = await createProduct(t, ctx, p, entry);
      await audit(ctx, "product.create", "product", id, { name: p.name, sku: p.sku, priceCents: p.priceCents, initialQuantity: entry.quantity }, req, t);
      return id;
    });
    return { id };
  }],

  ["GET", "/admin/products/:id", async (req, res) => {
    const ctx = await requireUser(req, res, "catalog.read");
    return { product: await getProduct(await db(), ctx.storeId, uuid(req.params.id, "id")) };
  }],

  ["PUT", "/admin/products/:id", async (req, res) => {
    const ctx = await requireUser(req, res, "products.write");
    const id = uuid(req.params.id, "id");
    const p = parseProduct(body(req));
    if (p.state === "arquivado" && !can(ctx.user.role, "products.archive")) fail(403, "Você não tem permissão para arquivar produtos.");
    await tx(async t => {
      const { before } = await updateProduct(t, ctx, id, p);
      const changes = {};
      if (before.price_cents !== p.priceCents) changes.price = [before.price_cents, p.priceCents];
      if (before.promo_price_cents !== p.promoPriceCents) changes.promo = [before.promo_price_cents, p.promoPriceCents];
      if (before.state !== p.state) changes.state = [before.state, p.state];
      if (before.published !== p.published) changes.published = [before.published, p.published];
      await audit(ctx, "product.update", "product", id, { name: p.name, changes }, req, t);
    });
    return { id };
  }],

  // Publicar / despublicar / inativar / arquivar / reativar
  ["POST", "/admin/products/:id/state", async (req, res) => {
    const b = body(req);
    const ctx = await requireUser(req, res, b.state === "arquivado" ? "products.archive" : "products.write");
    const id = uuid(req.params.id, "id");
    const r = await tx(async t => {
      const r = await setProductState(t, ctx, id, { state: b.state, published: b.published });
      await audit(ctx, "product.state", "product", id, r, req, t);
      return r;
    });
    return r.after;
  }],

  ["POST", "/admin/uploads", async (req, res) => {
    const ctx = await requireUser(req, res, "products.write");
    const b64 = String(body(req).data || "");
    if (!b64) fail(422, "Nenhuma imagem enviada.");
    const buf = Buffer.from(b64, "base64");
    if (buf.length > 3 * 1024 * 1024) fail(413, "Imagem muito grande (máx. 3 MB).");
    const kind = detectImage(buf);
    if (!kind) fail(415, "Formato não suportado. Envie JPG, PNG ou WEBP.");
    const name = `produtos/${randomUUID()}.${kind.ext}`;
    let url;
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const { put } = await import("@vercel/blob");
      url = (await put(name, buf, { access: "public", contentType: kind.type, addRandomSuffix: false })).url;
    } else if (process.env.VERCEL) {
      fail(503, "Armazenamento de imagens não configurado (BLOB_READ_WRITE_TOKEN).");
    } else {
      const dir = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
      const file = path.join(dir, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, buf);
      url = `/uploads/${name}`;
    }
    await audit(ctx, "image.upload", "image", null, { url, bytes: buf.length }, req);
    return { url };
  }],

  // ---------- Categorias ----------
  ["GET", "/admin/categories", async (req, res) => {
    const ctx = await requireUser(req, res, "catalog.read");
    return { categories: await q(`
      SELECT c.id, c.name, c.slug, c.description, c.position, c.active,
             (SELECT count(*)::int FROM products p WHERE p.category_id = c.id AND p.state <> 'arquivado') AS products
        FROM categories c WHERE c.store_id = $1 ORDER BY c.position, c.name`, [ctx.storeId]) };
  }],
  ["POST", "/admin/categories", async (req, res) => {
    const ctx = await requireUser(req, res, "categories.write");
    const b = body(req);
    const name = text(b.name, "Nome", { required: true, max: 60 });
    const [row] = await q("INSERT INTO categories (store_id, name, slug, description, position, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [ctx.storeId, name, slugify(name), text(b.description, "Descrição", { max: 300 }), int(b.position, "Ordem", { min: 0, max: 999 }) ?? 0, b.active === undefined ? true : bool(b.active)]);
    await audit(ctx, "category.create", "category", row.id, { name }, req);
    return { id: row.id };
  }],
  ["PUT", "/admin/categories/:id", async (req, res) => {
    const ctx = await requireUser(req, res, "categories.write");
    const b = body(req);
    const id = uuid(req.params.id, "id");
    const rows = await q("UPDATE categories SET name = $3, description = $4, position = $5, active = $6 WHERE id = $1 AND store_id = $2 RETURNING id",
      [id, ctx.storeId, text(b.name, "Nome", { required: true, max: 60 }), text(b.description, "Descrição", { max: 300 }), int(b.position, "Ordem", { min: 0, max: 999 }) ?? 0, bool(b.active)]);
    if (!rows.length) fail(404, "Categoria não encontrada.");
    await audit(ctx, "category.update", "category", id, { name: b.name }, req);
    return { id };
  }],

  // ---------- Estoque ----------
  ["POST", "/admin/stock/entries", async (req, res) => {
    const ctx = await requireUser(req, res, "stock.entry");
    const b = body(req);
    const productId = uuid(b.productId, "Produto");
    const entry = parseEntry(b);
    const mov = await tx(async t => {
      const m = await stockEntry(t, ctx, productId, entry);
      await audit(ctx, "stock.entry", "product", productId, { quantity: entry.quantity, origin: entry.origin, after: m.physical_after }, req, t);
      return m;
    });
    return { movement: mov };
  }],

  ["POST", "/admin/stock/adjustments", async (req, res) => {
    const ctx = await requireUser(req, res, "stock.adjust");
    const b = body(req);
    const productId = uuid(b.productId, "Produto");
    const delta = int(b.delta, "Quantidade do ajuste", { required: true, min: -100000, max: 100000 });
    if (!delta) fail(422, "O ajuste não pode ser zero.");
    const reason = oneOf(b.reason, "Motivo", Object.keys(ADJUST_REASONS));
    const note = text(b.note, "Justificativa", { required: true, max: 500 });
    const mov = await tx(async t => {
      const inv = (await lockInventory(t, ctx.storeId, [productId]))[productId];
      const m = await move(t, { storeId: ctx.storeId, inv, type: "ajuste", quantity: Math.abs(delta), physicalDelta: delta, reason, note, userId: ctx.user.id });
      await audit(ctx, "stock.adjust", "product", productId, { delta, reason, note, after: m.physical_after }, req, t);
      return m;
    });
    return { movement: mov };
  }],

  // ---------- Venda física ----------
  ["POST", "/admin/sales", async (req, res) => {
    const b = body(req);
    const ctx = await requireUser(req, res, b.override ? "sales.override" : "sales.physical");
    if (!Array.isArray(b.items) || !b.items.length) fail(422, "Selecione ao menos um produto.");
    const items = b.items.map(i => ({ productId: uuid(i.productId, "Produto"), quantity: int(i.quantity, "Quantidade", { required: true, min: 1, max: 10000 }) }));
    const paymentMethod = oneOf(b.paymentMethod || "dinheiro", "Forma de pagamento", ["dinheiro", "pix", "cartao_credito", "cartao_debito", "transferencia", "outro"]);
    const override = b.override ? { reason: text(b.override.reason, "Motivo da exceção", { required: true, max: 300 }) } : null;
    const sale = await tx(async t => {
      const s = await physicalSale(t, ctx, { items, paymentMethod, override,
        customerName: text(b.customerName, "Cliente", { max: 120 }), note: text(b.note, "Observação", { max: 500 }) });
      await audit(ctx, override ? "sale.physical.override" : "sale.physical", "order", s.id, { items, total: s.total_cents, override, affectedOrders: s.affectedOrders }, req, t);
      return s;
    });
    return { sale };
  }],

  // ---------- Histórico ----------
  ["GET", "/admin/movements", async (req, res) => {
    const ctx = await requireUser(req, res, "catalog.read");
    const params = [ctx.storeId];
    let sql = MOVEMENTS_SQL;
    const f = req.query;
    if (f.productId) { params.push(uuid(f.productId, "Produto")); sql += ` AND m.product_id = $${params.length}`; }
    if (f.type) { params.push(String(f.type)); sql += ` AND m.type = $${params.length}`; }
    if (f.kind === "fisico") sql += " AND m.physical_delta <> 0";
    if (f.kind === "reserva") sql += " AND m.type IN ('reserva_criada','reserva_liberada')";
    if (f.q) { params.push(`%${String(f.q).slice(0, 80)}%`); sql += ` AND (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`; }
    if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) { params.push(f.from); sql += ` AND m.created_at >= $${params.length}::date`; }
    if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) { params.push(f.to); sql += ` AND m.created_at < $${params.length}::date + 1`; }
    return { movements: await q(sql + " ORDER BY m.created_at DESC LIMIT 500", params) };
  }],

  // ---------- Reservas ----------
  ["GET", "/admin/reservations", async (req, res) => {
    const ctx = await requireUser(req, res, "orders.read");
    await freshen(ctx);
    const params = [ctx.storeId];
    let where = "r.store_id = $1";
    const st = req.query.status;
    if (["ativa", "convertida", "expirada", "cancelada"].includes(st)) { params.push(st); where += ` AND r.status = $${params.length}`; }
    if (req.query.expiring === "1") where += " AND r.status = 'ativa' AND r.expires_at < now() + interval '6 hours'";
    return { reservations: await q(`
      SELECT r.id, r.quantity, r.status, r.expires_at, r.created_at, r.released_at, r.release_reason,
             p.id AS product_id, p.name, p.sku, o.id AS order_id, o.number, o.status AS order_status, o.payment_status
        FROM reservations r JOIN products p ON p.id = r.product_id JOIN orders o ON o.id = r.order_id
       WHERE ${where} ORDER BY (r.status = 'ativa') DESC, r.expires_at LIMIT 500`, params) };
  }],

  // ---------- Pedidos ----------
  ["GET", "/admin/orders", async (req, res) => {
    const ctx = await requireUser(req, res, "orders.read");
    await freshen(ctx);
    const params = [ctx.storeId];
    let where = "o.store_id = $1";
    const channel = req.query.channel === "loja" ? "loja" : req.query.channel === "todos" ? null : "online";
    if (channel) { params.push(channel); where += ` AND o.channel = $${params.length}`; }
    if (req.query.status) { params.push(String(req.query.status)); where += ` AND o.status = $${params.length}`; }
    if (req.query.q) { params.push(`%${String(req.query.q).slice(0, 80)}%`); where += ` AND (c.name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR o.number::text = trim(both '%' from $${params.length}))`; }
    return { orders: await q(`
      SELECT o.id, o.number, o.channel, o.status, o.payment_status, o.payment_method, o.total_cents, o.reserved_until, o.created_at,
             c.name AS customer, (SELECT count(*)::int FROM order_items WHERE order_id = o.id) AS items,
             (SELECT count(*)::int FROM order_issues WHERE order_id = o.id AND status = 'aberta') AS open_issues
        FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE ${where} ORDER BY o.created_at DESC LIMIT 500`, params) };
  }],

  ["GET", "/admin/orders/:id", async (req, res) => {
    const ctx = await requireUser(req, res, "orders.read");
    const id = uuid(req.params.id, "id");
    const [o] = await q(`SELECT o.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone, c.document AS customer_document,
                                u.name AS created_by_name
                           FROM orders o LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.created_by
                          WHERE o.id = $1 AND o.store_id = $2`, [id, ctx.storeId]);
    if (!o) fail(404, "Pedido não encontrado.");
    delete o.public_token;
    const [items, reservations, payments, issues, movements] = await Promise.all([
      q("SELECT * FROM order_items WHERE order_id = $1", [id]),
      q("SELECT r.*, p.name FROM reservations r JOIN products p ON p.id = r.product_id WHERE r.order_id = $1 ORDER BY r.created_at", [id]),
      q("SELECT provider, external_id, status, method, amount_cents, created_at, updated_at FROM payments WHERE order_id = $1 ORDER BY created_at", [id]),
      q("SELECT id, type, description, status, resolution, created_at, resolved_at FROM order_issues WHERE order_id = $1 ORDER BY created_at", [id]),
      q(MOVEMENTS_SQL + " AND m.order_id = $2 ORDER BY m.created_at", [ctx.storeId, id]),
    ]);
    return { order: { ...o, items, reservations, payments, issues, movements } };
  }],

  ["POST", "/admin/orders/:id/advance", async (req, res) => {
    const ctx = await requireUser(req, res, "orders.manage");
    const id = uuid(req.params.id, "id");
    const next = oneOf(body(req).status, "Status", ["em_processamento", "concluido"]);
    await tx(async t => {
      const from = await advanceOrder(t, ctx, id, next);
      await audit(ctx, "order.status", "order", id, { from, to: next }, req, t);
    });
    return { ok: true };
  }],

  ["POST", "/admin/orders/:id/cancel", async (req, res) => {
    const ctx = await requireUser(req, res, "orders.manage");
    const id = uuid(req.params.id, "id");
    const reason = text(body(req).reason, "Motivo do cancelamento", { required: true, max: 300 });
    await tx(async t => {
      await cancelOrder(t, ctx, id, reason);
      await audit(ctx, "order.cancel", "order", id, { reason }, req, t);
    });
    return { ok: true };
  }],

  // Acompanhamento da loja digital: cada linha = item reservado/vendido por um pedido online.
  ["GET", "/admin/tracking", async (req, res) => {
    const ctx = await requireUser(req, res, "orders.read");
    await freshen(ctx);
    const rows = await q(`
      SELECT o.id AS order_id, o.number, o.status, o.payment_status, o.created_at, o.reserved_until,
             oi.name, oi.sku, oi.quantity, r.status AS reservation_status, r.expires_at, r.release_reason
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN reservations r ON r.order_item_id = oi.id
       WHERE o.store_id = $1 AND o.channel = 'online'
         AND (o.status IN ('aguardando_pagamento','pago','em_processamento') OR o.created_at > now() - interval '30 days')
       ORDER BY o.created_at DESC LIMIT 500`, [ctx.storeId]);
    const issues = await q(`SELECT i.id, i.type, i.description, i.created_at, o.number, o.id AS order_id
                              FROM order_issues i LEFT JOIN orders o ON o.id = i.order_id
                             WHERE i.store_id = $1 AND i.status = 'aberta' ORDER BY i.created_at DESC`, [ctx.storeId]);
    return { rows, issues };
  }],

  ["POST", "/admin/issues/:id/resolve", async (req, res) => {
    const ctx = await requireUser(req, res, "issues.resolve");
    const id = uuid(req.params.id, "id");
    const resolution = text(body(req).resolution, "Como foi resolvido", { required: true, max: 500 });
    const rows = await q(`UPDATE order_issues SET status = 'resolvida', resolution = $3, resolved_by = $4, resolved_at = now()
                           WHERE id = $1 AND store_id = $2 AND status = 'aberta' RETURNING id`, [id, ctx.storeId, resolution, ctx.user.id]);
    if (!rows.length) fail(404, "Ocorrência não encontrada ou já resolvida.");
    await audit(ctx, "issue.resolve", "issue", id, { resolution }, req);
    return { ok: true };
  }],

  // ---------- Configurações ----------
  ["GET", "/admin/settings", async (req, res) => {
    const ctx = await requireUser(req, res, "catalog.read");
    const s = await getStore(ctx.storeId);
    return { store: { name: s.name, domain: s.domain }, settings: settingsOf(s) };
  }],
  ["PUT", "/admin/settings", async (req, res) => {
    const ctx = await requireUser(req, res, "settings.write");
    const b = body(req);
    const name = text(b.name, "Nome da loja", { required: true, max: 80 });
    const settings = {
      reservationHours: int(b.reservationHours, "Prazo da reserva (horas)", { required: true, min: 1, max: 168 }),
      lowStockThreshold: int(b.lowStockThreshold, "Estoque baixo", { required: true, min: 0, max: 1000 }),
      whatsapp: (text(b.whatsapp, "WhatsApp", { max: 20 }) || "").replace(/\D/g, ""),
    };
    const before = settingsOf(await getStore(ctx.storeId));
    await q("UPDATE stores SET name = $2, settings = $3 WHERE id = $1", [ctx.storeId, name, JSON.stringify(settings)]);
    await audit(ctx, "settings.update", "store", ctx.storeId, { before, after: settings, name }, req);
    return { ok: true };
  }],

  // ---------- Usuários e permissões ----------
  ["GET", "/admin/users", async (req, res) => {
    const ctx = await requireUser(req, res, "users.manage");
    const users = await q(`SELECT id, name, email, role, active, email_verified_at IS NOT NULL AS verified, last_login_at, created_at
                             FROM users WHERE store_id = $1 ORDER BY created_at`, [ctx.storeId]);
    const invites = await q(`SELECT id, email, role, expires_at, created_at FROM invites
                              WHERE store_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [ctx.storeId]);
    return { users, invites };
  }],
  ["POST", "/admin/invites", async (req, res) => {
    const ctx = await requireUser(req, res, "users.manage");
    const b = body(req);
    const email = parseEmail(b.email);
    const role = oneOf(b.role, "Função", ["admin", "estoque", "vendedor"]);
    if (role === "admin" && ctx.user.role !== "owner") fail(403, "Só o proprietário pode convidar administradores.");
    const inv = await sendInvite(req, ctx, email, role);
    await audit(ctx, "invite.create", "invite", inv.id, { email, role }, req);
    return { invite: inv };
  }],
  ["POST", "/admin/invites/:id/revoke", async (req, res) => {
    const ctx = await requireUser(req, res, "users.manage");
    const id = uuid(req.params.id, "id");
    const rows = await q("UPDATE invites SET revoked_at = now() WHERE id = $1 AND store_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id", [id, ctx.storeId]);
    if (!rows.length) fail(404, "Convite não encontrado.");
    await audit(ctx, "invite.revoke", "invite", id, null, req);
    return { ok: true };
  }],
  ["PUT", "/admin/users/:id", async (req, res) => {
    const ctx = await requireUser(req, res, "users.manage");
    const id = uuid(req.params.id, "id");
    const b = body(req);
    const [u] = await q("SELECT id, role, active FROM users WHERE id = $1 AND store_id = $2", [id, ctx.storeId]);
    if (!u) fail(404, "Usuário não encontrado.");
    if (u.role === "owner") fail(403, "O proprietário não pode ser alterado por aqui.");
    if (id === ctx.user.id) fail(403, "Você não pode alterar o próprio acesso.");
    const role = b.role ? oneOf(b.role, "Função", ["admin", "estoque", "vendedor"]) : u.role;
    if ((role === "admin" || u.role === "admin") && ctx.user.role !== "owner") fail(403, "Só o proprietário altera administradores.");
    const active = b.active === undefined ? u.active : bool(b.active);
    await q("UPDATE users SET role = $2, active = $3 WHERE id = $1", [id, role, active]);
    if (!active) await q("DELETE FROM sessions WHERE user_id = $1", [id]);
    await audit(ctx, "user.update", "user", id, { from: { role: u.role, active: u.active }, to: { role, active } }, req);
    return { ok: true };
  }],

  ["GET", "/admin/audit", async (req, res) => {
    const ctx = await requireUser(req, res, "users.manage");
    return { logs: await q(`SELECT a.action, a.entity, a.entity_id, a.data, a.created_at, u.name AS user_name
                              FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
                             WHERE a.store_id = $1 ORDER BY a.created_at DESC LIMIT 300`, [ctx.storeId]) };
  }],
];
