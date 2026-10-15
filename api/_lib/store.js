// Identificação da loja e configurações.
import { db } from "./db.js";
import { fail } from "./http.js";

export const DEFAULT_SETTINGS = {
  reservationHours: 24,     // prazo da reserva após o pedido (seção 12)
  lowStockThreshold: 2,     // aviso de estoque baixo para produtos com várias unidades
  whatsapp: "5511984599584",
};

export const settingsOf = store => ({ ...DEFAULT_SETTINGS, ...(store?.settings || {}) });

// Loja das rotas PÚBLICAS (site): pelo domínio cadastrado; se só existir uma loja, usa ela.
// Rotas do painel nunca usam isto — a loja vem da sessão do usuário.
export async function resolvePublicStore(req) {
  const q = await db();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(":")[0].toLowerCase();
  const [byDomain] = host ? await q.query("SELECT id, name, settings FROM stores WHERE domain = $1", [host]) : [];
  if (byDomain) return byDomain;
  const stores = await q.query("SELECT id, name, settings FROM stores ORDER BY created_at LIMIT 2");
  if (stores.length === 1) return stores[0];
  if (!stores.length) return null;
  fail(404, "Loja não encontrada para este endereço.");
}

export async function getStore(storeId, t = null) {
  const q = t || await db();
  const [s] = await q.query("SELECT id, name, slug, domain, settings FROM stores WHERE id = $1", [storeId]);
  return s;
}

export async function nextNumber(t, storeId, name) {
  const [r] = await t.query(
    `INSERT INTO store_counters (store_id, name, value) VALUES ($1, $2, 1)
     ON CONFLICT (store_id, name) DO UPDATE SET value = store_counters.value + 1 RETURNING value`, [storeId, name]);
  return r.value;
}
