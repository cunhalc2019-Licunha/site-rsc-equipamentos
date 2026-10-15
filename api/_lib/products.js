// Cadastro de produtos: validação da ficha, gravação e leitura.
import { fail } from "./http.js";
import { text, int, num, oneOf, bool, uuid, slugify } from "./validate.js";
import { lockInventory, move, ENTRY_ORIGINS } from "./stock.js";

const CONDITIONS = ["novo", "seminovo", "usado_revisado"];
const STOCK_TYPES = ["unico", "quantidade"];
const STATES = ["ativo", "inativo", "arquivado"];
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
    promoPriceCents: int(b.promoPriceCents, "Preço promocional", { min: 1, max: 100_000_000 }),
    discountPixPct: num(b.discountPixPct, "Desconto PIX", { max: 90 }),
    discountCardPct: num(b.discountCardPct, "Desconto cartão", { max: 90 }),
    paymentMethods: Array.isArray(b.paymentMethods) ? [...new Set(b.paymentMethods)].filter(m => METHODS.includes(m)) : METHODS,
    badge: text(b.badge, "Selo", { max: 30 }),
    description: text(b.description, "Descrição", { max: 6000 }),
    internalNotes: text(b.internalNotes, "Observações internas", { max: 2000 }),
    sellOnline: b.sellOnline === undefined ? true : bool(b.sellOnline),
    state: oneOf(b.state || "ativo", "Estado", STATES),
    published: bool(b.published),
    specs: (Array.isArray(b.specs) ? b.specs : [])
      .map(s => ({ k: text(s?.k, "Especificação", { max: 60 }), v: text(s?.v, "Valor da especificação", { max: 200 }) }))
      .filter(s => s.k && s.v).slice(0, 30),
    images: (Array.isArray(b.images) ? b.images : []).slice(0, MAX_IMAGES).map(u => {
      const url = text(u, "Imagem", { max: 500 });
      if (!/^(https:\/\/|\/)[^\s"'<>]+$/.test(url || "")) fail(422, "Endereço de imagem inválido.");
      return url;
    }),
  };
  if (p.sku && !/^[A-Za-z0-9][A-Za-z0-9._\-\/]*$/.test(p.sku)) fail(422, "SKU deve ter apenas letras, números, ponto, hífen, barra ou sublinhado.");
  if (!p.paymentMethods.length) fail(422, "Selecione ao menos uma forma de pagamento.");
  if (p.promoPriceCents && !p.priceCents) fail(422, "Informe o preço normal antes do preço promocional.");
  if (p.promoPriceCents && p.promoPriceCents >= p.priceCents) fail(422, "O preço promocional deve ser menor que o preço normal.");
  if (p.state !== "ativo") p.published = false;
  if (p.published && !p.images.length) fail(422, "Adicione pelo menos uma foto antes de publicar.");
  return p;
}

export function parseEntry(e, { allowZero = false } = {}) {
  const origin = String(e.origin || e.reason || "compra");
  if (!ENTRY_ORIGINS[origin]) fail(422, "Origem da mercadoria inválida.");
  const quantity = int(e.quantity, "Quantidade recebida", { required: !allowZero, min: allowZero ? 0 : 1, max: 100000 }) || 0;
  let movementDate = null;
  if (e.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.date))) fail(422, "Data inválida.");
    if (new Date(e.date) > new Date(Date.now() + 86400000)) fail(422, "A data da entrada não pode ser futura.");
    movementDate = e.date;
  }
  return {
    quantity, origin, movementDate,
    unitCostCents: int(e.unitCostCents, "Custo de aquisição", { min: 0, max: 100_000_000 }),
    supplier: text(e.supplier, "Fornecedor / origem", { max: 120 }),
    document: text(e.document, "Documento", { max: 60 }),
    note: text(e.note, "Observação", { max: 500 }),
  };
}

// Entrada de mercadoria (usada pela ficha e pela tela "Entrada de mercadoria").
export async function stockEntry(t, ctx, productId, entry) {
  const inv = (await lockInventory(t, ctx.storeId, [productId]))[productId];
  if (inv.state === "arquivado") fail(422, "Produto arquivado não recebe entrada. Reative-o antes.");
  if (inv.stock_type === "unico" && entry.quantity > 1) fail(422, "Produto único: a entrada máxima é 1 unidade.");
  return move(t, {
    storeId: ctx.storeId, inv, type: "entrada", quantity: entry.quantity, physicalDelta: entry.quantity,
    reason: entry.origin, userId: ctx.user?.id, origin: "painel", note: entry.note, unitCostCents: entry.unitCostCents,
    supplier: entry.supplier, document: entry.document, movementDate: entry.movementDate,
  });
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
  p.priceCents, p.promoPriceCents, p.discountPixPct, p.discountCardPct, p.paymentMethods, p.badge, p.sellOnline,
  p.state, p.published, p.internalNotes];

export async function createProduct(t, ctx, p, entry) {
  await assertCategory(t, ctx.storeId, p.categoryId);
  if (p.stockType === "unico" && entry?.quantity > 1) fail(422, "Produto único: a quantidade inicial máxima é 1.");
  const slug = await uniqueSlug(t, ctx.storeId, p.name);
  const sku = p.sku || `RSC-${(await t.query("SELECT nextval('product_sku_seq') AS n"))[0].n}`;
  const [row] = await t.query(
    `INSERT INTO products (store_id, sku, slug, category_id, name, brand, description, specs, condition, stock_type,
       price_cents, promo_price_cents, discount_pix_pct, discount_card_pct, payment_methods, badge, sell_online,
       state, published, internal_notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [ctx.storeId, sku, slug, ...cols(p)]);
  await t.query("INSERT INTO inventory (product_id, store_id) VALUES ($1, $2)", [row.id, ctx.storeId]);
  await saveImages(t, row.id, p.images);
  if (entry?.quantity > 0) await stockEntry(t, ctx, row.id, entry);
  return row.id;
}

export async function updateProduct(t, ctx, id, p) {
  const [cur] = await t.query(
    `SELECT p.id, p.sku, p.price_cents, p.promo_price_cents, p.state, p.published, i.on_hand, i.reserved
       FROM products p JOIN inventory i ON i.product_id = p.id
      WHERE p.id = $1 AND p.store_id = $2 FOR UPDATE OF i`, [id, ctx.storeId]);
  if (!cur) fail(404, "Produto não encontrado.");
  if (p.stockType === "unico" && cur.on_hand > 1) fail(422, `Este produto tem ${cur.on_hand} unidades. Ajuste o estoque para 1 antes de marcá-lo como único.`);
  if (p.state === "arquivado" && cur.reserved > 0) fail(409, "Há reservas ativas deste produto. Resolva os pedidos antes de arquivar.");
  await assertCategory(t, ctx.storeId, p.categoryId);
  const slug = await uniqueSlug(t, ctx.storeId, p.name, id);
  const sku = p.sku || cur.sku;
  await t.query(
    `UPDATE products SET sku = $2, slug = $3, category_id = $4, name = $5, brand = $6, description = $7, specs = $8,
       condition = $9, stock_type = $10, price_cents = $11, promo_price_cents = $12, discount_pix_pct = $13,
       discount_card_pct = $14, payment_methods = $15, badge = $16, sell_online = $17, state = $18, published = $19,
       internal_notes = $20, updated_at = now()
     WHERE id = $1`, [id, sku, slug, ...cols(p)]);
  await saveImages(t, id, p.images);
  return { before: cur };
}

// Mudança rápida de estado/publicação (publicar, despublicar, inativar, arquivar, reativar).
export async function setProductState(t, ctx, id, { state, published }) {
  const [cur] = await t.query(
    `SELECT p.state, p.published, i.reserved, (SELECT count(*)::int FROM product_images WHERE product_id = p.id) AS imgs
       FROM products p JOIN inventory i ON i.product_id = p.id WHERE p.id = $1 AND p.store_id = $2 FOR UPDATE OF i`, [id, ctx.storeId]);
  if (!cur) fail(404, "Produto não encontrado.");
  const st = oneOf(state ?? cur.state, "Estado", STATES);
  let pub = published === undefined ? cur.published : bool(published);
  if (st !== "ativo") pub = false;
  if (pub && !cur.imgs) fail(422, "Adicione pelo menos uma foto antes de publicar.");
  if (st === "arquivado" && cur.reserved > 0) fail(409, "Há reservas ativas deste produto. Resolva os pedidos antes de arquivar.");
  await t.query("UPDATE products SET state = $2, published = $3, updated_at = now() WHERE id = $1", [id, st, pub]);
  return { before: { state: cur.state, published: cur.published }, after: { state: st, published: pub } };
}

const LIST_SQL = `
  SELECT p.id, p.sku, p.slug, p.name, p.brand, p.condition, p.stock_type, p.price_cents, p.promo_price_cents,
         p.state, p.published, p.sell_online, p.updated_at, c.name AS category, c.id AS category_id,
         i.on_hand, i.reserved, i.sold, (i.on_hand - i.reserved) AS available,
         (SELECT url FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) AS image,
         (SELECT max(created_at) FROM stock_movements m WHERE m.product_id = p.id) AS last_movement_at
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    LEFT JOIN categories c ON c.id = p.category_id
   WHERE p.store_id = $1`;

// Filtros da tela de estoque/produtos.
export async function listProducts(t, storeId, f = {}, lowStock = 2) {
  const params = [storeId];
  const add = (sql, v) => { params.push(v); return sql.replace("?", `$${params.length}`); };
  let sql = LIST_SQL;
  if (f.state && STATES.includes(f.state)) sql += add(" AND p.state = ?", f.state);
  else if (!f.includeArchived) sql += " AND p.state <> 'arquivado'";
  if (f.published === "1") sql += " AND p.published";
  if (f.published === "0") sql += " AND NOT p.published";
  if (f.categoryId) sql += add(" AND p.category_id = ?", uuid(f.categoryId, "Categoria"));
  if (f.condition === "novo") sql += " AND p.condition = 'novo'";
  if (f.condition === "usado") sql += " AND p.condition <> 'novo'";
  switch (f.stock) {
    case "disponiveis": sql += " AND i.on_hand - i.reserved > 0"; break;
    case "reservados": sql += " AND i.reserved > 0 AND i.reserved = i.on_hand"; break;
    case "parcial": sql += " AND i.reserved > 0 AND i.reserved < i.on_hand"; break;
    case "vendidos": sql += " AND i.sold > 0"; break;
    case "sem_estoque": sql += " AND i.on_hand = 0"; break;
    case "baixo": sql += add(" AND p.stock_type = 'quantidade' AND i.on_hand - i.reserved > 0 AND i.on_hand - i.reserved <= ?", lowStock); break;
  }
  if (f.q) sql += add(" AND (p.name ILIKE ? OR p.sku ILIKE $X OR p.brand ILIKE $X)", `%${String(f.q).slice(0, 80)}%`).replace(/\$X/g, `$${params.length}`);
  return t.query(sql + " ORDER BY p.updated_at DESC LIMIT 1000", params);
}

export async function getProduct(t, storeId, id) {
  const [p] = await t.query(`
    SELECT p.*, i.on_hand, i.reserved, i.sold, (i.on_hand - i.reserved) AS available
      FROM products p JOIN inventory i ON i.product_id = p.id
     WHERE p.id = $1 AND p.store_id = $2`, [id, storeId]);
  if (!p) fail(404, "Produto não encontrado.");
  p.images = (await t.query("SELECT url FROM product_images WHERE product_id = $1 ORDER BY position", [id])).map(r => r.url);
  p.movements = await t.query(`
    SELECT m.id, m.type, m.quantity, m.physical_delta, m.reserved_delta, m.physical_before, m.physical_after,
           m.reserved_after, m.reason, m.unit_cost_cents, m.supplier, m.document, m.note, m.created_at, m.movement_date,
           u.name AS user_name, o.number AS order_number
      FROM stock_movements m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN orders o ON o.id = m.order_id
     WHERE m.product_id = $1 ORDER BY m.created_at DESC LIMIT 100`, [id]);
  p.reservations = await t.query(`
    SELECT r.id, r.quantity, r.status, r.expires_at, o.number AS order_number, o.id AS order_id
      FROM reservations r JOIN orders o ON o.id = r.order_id
     WHERE r.product_id = $1 AND r.status = 'ativa' ORDER BY r.expires_at`, [id]);
  return p;
}
