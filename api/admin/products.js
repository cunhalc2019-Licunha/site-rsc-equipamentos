// GET    /api/admin/products            lista (filtros: q, status, categoryId)
// GET    /api/admin/products?id=...     ficha completa + histórico de estoque
// POST   /api/admin/products            cria (com entrada inicial opcional)
// PUT    /api/admin/products?id=...     atualiza a ficha
// DELETE /api/admin/products?id=...     arquiva (não apaga: preserva o histórico)
import { db } from "../_lib/db.js";
import { route, body, fail } from "../_lib/http.js";
import { requireUser, audit } from "../_lib/auth.js";
import { uuid, int, text } from "../_lib/validate.js";
import { parseProduct, createProduct, updateProduct, listProducts, getProduct } from "../_lib/products.js";

const EDITORS = ["owner", "admin", "estoque"];

export default route({
  async GET(req, res) {
    const ctx = await requireUser(req, res);
    const q = await db();
    if (req.query.id) return { product: await getProduct(q, ctx.storeId, uuid(req.query.id, "id")) };
    return { products: await listProducts(q, ctx.storeId, req.query) };
  },

  async POST(req, res) {
    const ctx = await requireUser(req, res, EDITORS);
    const b = body(req);
    const p = parseProduct(b);
    const e = b.initialEntry || {};
    const entry = {
      quantity: int(e.quantity, "Quantidade de entrada", { min: 0, max: 100000 }) || 0,
      reason: e.reason || "estoque_inicial",
      unitCostCents: int(e.unitCostCents, "Custo unitário", { min: 0, max: 100_000_000 }),
      supplier: text(e.supplier, "Fornecedor / origem", { max: 120 }),
      document: text(e.document, "Documento", { max: 60 }),
      note: text(e.note, "Observação", { max: 500 }),
    };
    if (p.stockType === "unico" && entry.quantity > 1) fail(422, "Produto único: a entrada máxima é 1 unidade.");
    const id = await (await db()).tx(t => createProduct(t, ctx, p, entry));
    await audit(ctx, "product.create", "product", id, { name: p.name, initialQuantity: entry.quantity }, req);
    return { id };
  },

  async PUT(req, res) {
    const ctx = await requireUser(req, res, EDITORS);
    const id = uuid(req.query.id, "id");
    const p = parseProduct(body(req));
    await (await db()).tx(t => updateProduct(t, ctx, id, p));
    await audit(ctx, "product.update", "product", id, { name: p.name, status: p.status, priceCents: p.priceCents }, req);
    return { id };
  },

  async DELETE(req, res) {
    const ctx = await requireUser(req, res, ["owner", "admin"]);
    const id = uuid(req.query.id, "id");
    const rows = await (await db()).query(
      "UPDATE products SET status = 'arquivado', updated_at = now() WHERE id = $1 AND store_id = $2 RETURNING id", [id, ctx.storeId]);
    if (!rows.length) fail(404, "Produto não encontrado.");
    await audit(ctx, "product.archive", "product", id, null, req);
    return { ok: true };
  },
});
