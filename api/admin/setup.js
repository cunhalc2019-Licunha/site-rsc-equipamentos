// Primeiro acesso: cria a loja, o usuário dono e (opcional) importa o catálogo atual do site.
// Só funciona enquanto NÃO existir nenhum usuário, e exige o código ADMIN_SETUP_TOKEN.
import { readFileSync } from "node:fs";
import path from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";
import { db } from "../_lib/db.js";
import { route, body, fail } from "../_lib/http.js";
import { hashPassword, validatePassword, createSession, audit } from "../_lib/auth.js";
import { text, email as parseEmail, slugify } from "../_lib/validate.js";
import { createProduct } from "../_lib/products.js";

const sameSecret = (a, b) => {
  const h = s => createHash("sha256").update(String(s)).digest();
  return timingSafeEqual(h(a), h(b));
};

async function importCatalog(t, ctx) {
  const data = JSON.parse(readFileSync(path.join(process.cwd(), "data", "products.json"), "utf8"));
  const catIds = {};
  for (const [i, s] of data.sectors.entries()) {
    const [c] = await t.query(
      `INSERT INTO categories (store_id, name, slug, description, cover_url, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ctx.storeId, s.name, s.slug, s.desc, "/" + s.cover, i]);
    catIds[s.slug] = c.id;
  }
  for (const p of data.products) {
    const condition = /semi/i.test(p.condition) ? "seminovo" : /usad/i.test(p.condition) ? "usado_revisado" : "novo";
    await createProduct(t, ctx, {
      name: p.name, brand: p.brand, categoryId: catIds[p.sector], sku: null, condition,
      stockType: (p.stock || 1) > 1 ? "quantidade" : "unico",
      priceCents: p.price ? Math.round(p.price * 100) : null,
      oldPriceCents: p.oldPrice ? Math.round(p.oldPrice * 100) : null,
      discountPixPct: p.discounts?.pix || 0, discountCardPct: p.discounts?.card || 0,
      paymentMethods: p.methods || ["pix", "card", "boleto"], badge: p.badge || null,
      description: p.desc, internalNotes: p.note || null, sellOnline: true, status: "publicado",
      specs: Object.entries(p.specs || {}).map(([k, v]) => ({ k, v })),
      images: p.images.map(u => "/" + u),
    }, { quantity: p.stock || 1, reason: "estoque_inicial", note: "Importado do catálogo do site" });
  }
}

export default route({
  async GET() {
    const [{ n }] = await (await db()).query("SELECT count(*)::int AS n FROM users");
    return { needsSetup: n === 0 };
  },

  async POST(req, res) {
    const b = body(req);
    const expected = process.env.ADMIN_SETUP_TOKEN;
    if (!expected) fail(503, "Configure a variável ADMIN_SETUP_TOKEN no servidor antes do primeiro acesso.");
    if (!sameSecret(b.setupToken || "", expected)) fail(403, "Código de configuração incorreto.");
    const storeName = text(b.storeName, "Nome da loja", { required: true, max: 80 });
    const name = text(b.name, "Seu nome", { required: true, max: 80 });
    const mail = parseEmail(b.email);
    validatePassword(b.password);
    const passwordHash = await hashPassword(b.password);

    const q = await db();
    const ctx = await q.tx(async t => {
      await t.query("LOCK TABLE users IN EXCLUSIVE MODE");
      const [{ n }] = await t.query("SELECT count(*)::int AS n FROM users");
      if (n > 0) fail(409, "O painel já foi configurado. Faça login.");
      const [store] = await t.query("INSERT INTO stores (name, slug) VALUES ($1, $2) RETURNING id", [storeName, slugify(storeName)]);
      const [user] = await t.query(
        "INSERT INTO users (store_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'owner') RETURNING id",
        [store.id, name, mail, passwordHash]);
      const c = { storeId: store.id, user: { id: user.id } };
      if (b.importCatalog) await importCatalog(t, c);
      else await t.query("INSERT INTO categories (store_id, name, slug, position) VALUES ($1,'Geral','geral',0)", [store.id]);
      return c;
    });
    await audit(ctx, "setup", "store", ctx.storeId, { importCatalog: !!b.importCatalog }, req);
    await createSession(req, res, ctx.user.id);
    return { ok: true };
  },
});
