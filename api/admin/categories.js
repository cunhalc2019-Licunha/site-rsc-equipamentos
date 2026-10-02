// GET  /api/admin/categories          lista com contagem de produtos
// POST /api/admin/categories          cria
// PUT  /api/admin/categories?id=...   atualiza
import { db } from "../_lib/db.js";
import { route, body } from "../_lib/http.js";
import { requireUser, audit } from "../_lib/auth.js";
import { text, int, bool, uuid, slugify } from "../_lib/validate.js";
import { fail } from "../_lib/http.js";

const parse = b => ({
  name: text(b.name, "Nome", { required: true, max: 60 }),
  description: text(b.description, "Descrição", { max: 300 }),
  position: int(b.position, "Ordem", { min: 0, max: 999 }) ?? 0,
  active: b.active === undefined ? true : bool(b.active),
});

export default route({
  async GET(req, res) {
    const ctx = await requireUser(req, res);
    return {
      categories: await (await db()).query(`
        SELECT c.id, c.name, c.slug, c.description, c.position, c.active,
               (SELECT count(*)::int FROM products p WHERE p.category_id = c.id AND p.status <> 'arquivado') AS products
          FROM categories c WHERE c.store_id = $1 ORDER BY c.position, c.name`, [ctx.storeId]),
    };
  },

  async POST(req, res) {
    const ctx = await requireUser(req, res, ["owner", "admin"]);
    const c = parse(body(req));
    const [row] = await (await db()).query(
      "INSERT INTO categories (store_id, name, slug, description, position, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [ctx.storeId, c.name, slugify(c.name), c.description, c.position, c.active]);
    await audit(ctx, "category.create", "category", row.id, c, req);
    return { id: row.id };
  },

  async PUT(req, res) {
    const ctx = await requireUser(req, res, ["owner", "admin"]);
    const id = uuid(req.query.id, "id");
    const c = parse(body(req));
    const rows = await (await db()).query(
      "UPDATE categories SET name = $3, description = $4, position = $5, active = $6 WHERE id = $1 AND store_id = $2 RETURNING id",
      [id, ctx.storeId, c.name, c.description, c.position, c.active]);
    if (!rows.length) fail(404, "Categoria não encontrada.");
    await audit(ctx, "category.update", "category", id, c, req);
    return { id };
  },
});
