// GET /api/catalog — catálogo público do site, gerado a partir do banco.
// Devolve o MESMO formato do antigo data/products.json, então o front-end não precisa mudar.
// Só aparecem produtos "publicado". Preço e estoque vêm do banco (fonte de verdade).
import { db } from "./_lib/db.js";
import { route } from "./_lib/http.js";

const CONDITION = { novo: "Novo", seminovo: "Seminovo", usado_revisado: "Usado revisado" };
const ALL_METHODS = ["pix", "card", "boleto"];

export default route({
  async GET(req, res) {
    const q = await db();
    const [store] = await q.query("SELECT id FROM stores ORDER BY created_at LIMIT 1");
    if (!store) return { configured: false, sectors: [], products: [] };

    const products = await q.query(`
      SELECT p.id, p.slug, p.name, p.brand, p.description, p.specs, p.condition, p.price_cents, p.old_price_cents,
             p.discount_pix_pct, p.discount_card_pct, p.payment_methods, p.badge, p.sell_online,
             i.on_hand - i.reserved AS available, c.slug AS sector,
             COALESCE((SELECT json_agg(url ORDER BY position) FROM product_images WHERE product_id = p.id), '[]') AS images
        FROM products p
        JOIN inventory i ON i.product_id = p.id
        JOIN categories c ON c.id = p.category_id AND c.active
       WHERE p.store_id = $1 AND p.status = 'publicado'
       ORDER BY (i.on_hand - i.reserved > 0) DESC, p.updated_at DESC`, [store.id]);

    const categories = await q.query(
      "SELECT slug, name, description, cover_url FROM categories WHERE store_id = $1 AND active ORDER BY position, name", [store.id]);

    const out = products.filter(p => p.images.length).map(p => {
      const discounts = {};
      if (Number(p.discount_pix_pct)) discounts.pix = Number(p.discount_pix_pct);
      if (Number(p.discount_card_pct)) discounts.card = Number(p.discount_card_pct);
      const methods = ALL_METHODS.filter(m => p.payment_methods.includes(m));
      return {
        id: p.slug,
        name: p.name,
        brand: p.brand || "",
        sector: p.sector,
        images: p.images,
        price: p.price_cents ? p.price_cents / 100 : null,
        ...(p.old_price_cents ? { oldPrice: p.old_price_cents / 100 } : {}),
        ...(Object.keys(discounts).length ? { discounts } : {}),
        ...(methods.length < ALL_METHODS.length ? { methods } : {}),
        ...(p.badge ? { badge: p.badge } : {}),
        condition: CONDITION[p.condition],
        stock: Math.max(0, p.available),
        online: p.sell_online,
        desc: p.description || "",
        specs: Object.fromEntries((p.specs || []).map(s => [s.k, s.v])),
      };
    });

    const sectors = categories
      .filter(c => out.some(p => p.sector === c.slug))
      .map(c => ({
        slug: c.slug, name: c.name, desc: c.description || "",
        cover: c.cover_url || out.find(p => p.sector === c.slug).images[0],
      }));

    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=20, stale-while-revalidate=40");
    return { configured: true, sectors, products: out };
  },
});
