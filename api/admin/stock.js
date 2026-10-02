// GET  /api/admin/stock?productId=&type=   histórico de movimentações
// POST /api/admin/stock                    registra entrada, saída (ex.: venda na loja física) ou ajuste
import { db } from "../_lib/db.js";
import { route, body } from "../_lib/http.js";
import { requireUser, audit } from "../_lib/auth.js";
import { uuid, int, text, oneOf } from "../_lib/validate.js";
import { applyMovement } from "../_lib/stock.js";

export default route({
  async GET(req, res) {
    const ctx = await requireUser(req, res);
    const params = [ctx.storeId];
    let where = "m.store_id = $1";
    if (req.query.productId) { params.push(uuid(req.query.productId, "Produto")); where += ` AND m.product_id = $${params.length}`; }
    if (req.query.type) { params.push(oneOf(req.query.type, "Tipo", ["entrada", "saida", "ajuste"])); where += ` AND m.type = $${params.length}`; }
    return {
      movements: await (await db()).query(`
        SELECT m.id, m.type, m.quantity, m.reason, m.unit_cost_cents, m.supplier, m.document, m.note, m.balance_after, m.created_at,
               p.id AS product_id, p.name AS product_name, p.sku, u.name AS user_name
          FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
         WHERE ${where} ORDER BY m.created_at DESC LIMIT 300`, params),
    };
  },

  async POST(req, res) {
    const b = body(req);
    const type = oneOf(b.type, "Tipo", ["entrada", "saida", "ajuste"]);
    const ctx = await requireUser(req, res, type === "saida" ? ["owner", "admin", "estoque", "vendedor"] : ["owner", "admin", "estoque"]);
    const m = {
      storeId: ctx.storeId, userId: ctx.user.id, type,
      productId: uuid(b.productId, "Produto"),
      quantity: int(b.quantity, "Quantidade", { required: true, min: -100000, max: 100000 }),
      reason: String(b.reason || ""),
      unitCostCents: int(b.unitCostCents, "Custo unitário", { min: 0, max: 100_000_000 }),
      supplier: text(b.supplier, "Fornecedor / cliente", { max: 120 }),
      document: text(b.document, "Documento", { max: 60 }),
      note: text(b.note, "Observação", { max: 500 }),
    };
    const mov = await (await db()).tx(t => applyMovement(t, m));
    await audit(ctx, `stock.${type}`, "product", m.productId, { quantity: m.quantity, reason: m.reason, balance: mov.balance_after }, req);
    return { movement: mov };
  },
});
