// Cadastro de produtos: validação da ficha, gravação e leitura.
import { fail } from "./http.js";
import { text, int, num, oneOf, bool, uuid, slugify } from "./validate.js";
import { applyMovement } from "./stock.js";

const CONDITIONS = ["novo", "seminovo", "usado_revisado"];
const STOCK_TYPES = ["unico", "quantidade"];
const STATUSES = ["rascunho", "publicado", "arquivado"];
const METHODS = ["pix", "card", "boleto"];
const MAX_IMAGES = 10;

export function parseProduct(b) {
  const p = {
    name: text(b.name, "Nome do produto", { required: true, max: 120 }),
    brand: text(b.brand, "Marca / modelo", { max: 120 }),
    categoryId: uuid(b.categoryId, "Categoria"),
    sku: text(b.sku, "SKU", { max: 40 }),
    condition: oneOf(b.condition, "Condição", CONDITIONS),
    stockType: oneOf(b.stockType, "Tipo de estoque", STOCK_TYPES),
    priceCents: int(b.priceCents, "Preço", { min: 1, max: 100_000_000 }),
    oldPriceCents: int(b.oldPriceCents, "Preço \"De\"", { min: 1, max: 100_000_000 }),
    discountPixPct: num(b.discountPixPct, "Desconto PIX", { max: 90 }),
    discountCardPct: num(b.discountCardPct, "Desconto cartão", { max: 90 }),
    paymentMethods: Array.isArray(b.paymentMethods) ? [...new Set(b.paymentMethods)].filter(m => METHODS.includes(m)) : METHODS,
    badge: text(b.badge, "Selo", { max: 30 }),
    description: text(b.description, "Descrição", { max: 4000 }),
    internalNotes: text(b.internalNotes, "Observações internas", { max: 2000 }),
    sellOnline: bool(b.sellOnline),
    status: oneOf(b.status || "rascunho", "Status", STATUSES),
    specs: (Array.isArray(b.specs) ? b.specs : [])
      .map(s => ({ k: text(s?.k, "Especificação", { max: 60 }), v: text(s?.v, "Valor da especificação", { max: 200 }) }))
      .filter(s => s.k && s.v).slice(0, 30),
    images: (Array.isArray(b.images) ? b.images : []).slice(0, MAX_IMAGES).map(u => {
      const url = text(u, "Imagem", { max: 500 });
      if (!/^(https:\/\/|\/)[^\s"'<>]+$/.test(url || "")) fail(422, "Endereço de imagem inválido.");
      return url;
    }),
  };
  if (!p.paymentMethods.length) fail(422, "Selecione ao menos uma forma de pagamento.");
  if (p.oldPriceCents && p.priceCents && p.oldPriceCents <= p.priceCents) fail(422, "O preço \"De\" deve ser maior que o preço de venda.");
  if (p.status === "publicado" && !p.images.length) fail(422, "Adicione pelo menos uma foto antes de publicar.");
  return p;
}

async function uniqueSlug(t, storeId, name, exceptId = null) {
  const base = slugify(name);
  const rows = await t.query("SELECT slug FROM products WHERE store_id = $1 AND slug LIKE $2 AND id IS DISTINCT FROM $3",
    [storeId, `${base}%`, exceptId]);
  const used = new Set(rows.map(r => r.slug));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

async function assertCategory(t, storeId, categoryId) {
  const [c] = await t.query("SELECT id FROM categories WHERE id = $1 AND store_id = $2", [categoryId, storeId]);
  if (!c) fail(422, "Categoria inválida.");
}

async function saveImages(t, productId, images) {
  await t.query("DELETE FROM product_images WHERE product_id = $1", [productId]);
  for (const [i, url] of images.entries())
    await t.query("INSERT INTO product_images (product_id, url, position) VALUES ($1, $2, $3)", [productId, url, i]);
}

const cols = p => [p.categoryId, p.name, p.brand, p.description, JSON.stringify(p.specs), p.condition, p.stockType,
  p.priceCents, p.oldPriceCents, p.discountPixPct, p.discountCardPct, p.paymentMethods, p.badge, p.sellOnline, p.status, p.internalNotes];

// entry = entrada inicial opcional { quantity, reason, unitCostCents, supplier, document, note }
export async function createProduct(t, ctx, p, entry) {
  await assertCategory(t, ctx.storeId, p.categoryId);
  const slug = await uniqueSlug(t, ctx.storeId, p.name);
  const sku = p.sku || `RSC-${(await t.query("SELECT nextval('product_sku_seq') AS n"))[0].n}`;
  const [row] = await t.query(
    `INSERT INTO products (store_id, sku, slug, category_id, name, brand, description, specs, condition, stock_type,
       price_cents, old_price_cents, discount_pix_pct, discount_card_pct, payment_methods, badge, sell_online, status, internal_notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [ctx.storeId, sku, slug, ...cols(p)]);
  await t.query("INSERT INTO inventory (product_id, store_id) VALUES ($1, $2)", [row.id, ctx.storeId]);
  await saveImages(t, row.id, p.images);
  if (entry?.quantity > 0)
    await applyMovement(t, { ...entry, type: "entrada", storeId: ctx.storeId, productId: row.id, userId: ctx.user?.id });
  return row.id;
}

export async function updateProduct(t, ctx, id, p) {
  const [cur] = await t.query(
    `SELECT p.id, i.on_hand FROM products p JOIN inventory i ON i.product_id = p.id
      WHERE p.id = $1 AND p.store_id = $2 FOR UPDATE OF i`, [id, ctx.storeId]);
  if (!cur) fail(404, "Produto não encontrado.");
  if (p.stockType === "unico" && cur.on_hand > 1) fail(422, `Este produto tem ${cur.on_hand} unidades. Ajuste o estoque para 1 antes de marcá-lo como único.`);
  await assertCategory(t, ctx.storeId, p.categoryId);
  const slug = await uniqueSlug(t, ctx.storeId, p.name, id);
  const sku = p.sku || (await t.query("SELECT sku FROM products WHERE id = $1", [id]))[0].sku;
  await t.query(
    `UPDATE products SET sku = $2, slug = $3, category_id = $4, name = $5, brand = $6, description = $7, specs = $8, condition = $9,
       stock_type = $10, price_cents = $11, old_price_cents = $12, discount_pix_pct = $13, discount_card_pct = $14,
       payment_methods = $15, badge = $16, sell_online = $17, status = $18, internal_notes = $19, updated_at = now()
     WHERE id = $1`, [id, sku, slug, ...cols(p)]);
  await saveImages(t, id, p.images);
}

const LIST_SQL = `
  SELECT p.id, p.sku, p.slug, p.name, p.brand, p.condition, p.stock_type, p.price_cents, p.old_price_cents,
         p.status, p.sell_online, p.updated_at, c.name AS category, c.id AS category_id,
         i.on_hand, i.reserved,
         (SELECT url FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) AS image
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    LEFT JOIN categories c ON c.id = p.category_id
   WHERE p.store_id = $1`;

export async function listProducts(t, storeId, { q, status, categoryId } = {}) {
  const params = [storeId];
  let sql = LIST_SQL;
  if (status && STATUSES.includes(status)) { params.push(status); sql += ` AND p.status = $${params.length}`; }
  else sql += " AND p.status <> 'arquivado'";
  if (categoryId) { params.push(uuid(categoryId, "Categoria")); sql += ` AND p.category_id = $${params.length}`; }
  if (q) { params.push(`%${String(q).slice(0, 80)}%`); sql += ` AND (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length} OR p.brand ILIKE $${params.length})`; }
  return t.query(sql + " ORDER BY p.updated_at DESC LIMIT 500", params);
}

export async function getProduct(t, storeId, id) {
  const [p] = await t.query(`
    SELECT p.*, i.on_hand, i.reserved FROM products p JOIN inventory i ON i.product_id = p.id
     WHERE p.id = $1 AND p.store_id = $2`, [id, storeId]);
  if (!p) fail(404, "Produto não encontrado.");
  p.images = (await t.query("SELECT url FROM product_images WHERE product_id = $1 ORDER BY position", [id])).map(r => r.url);
  p.movements = await t.query(`
    SELECT m.id, m.type, m.quantity, m.reason, m.unit_cost_cents, m.supplier, m.document, m.note, m.balance_after, m.created_at,
           u.name AS user_name
      FROM stock_movements m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.product_id = $1 ORDER BY m.created_at DESC LIMIT 100`, [id]);
  return p;
}
