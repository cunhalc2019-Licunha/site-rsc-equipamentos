// Frete com entrega própria, calculado pelo CEP do cliente (sempre no servidor).
//
// Regras (configuráveis em Configurações → Frete), aplicadas nesta ordem:
//   1. até `near.km` em linha reta da loja ............ `near.cents`   (padrão: 7 km → R$ 50)
//   2. cidade do ABC ................................. `abc.cents`    (padrão: R$ 100)
//   3. até `region.km` em linha reta .................. `region.cents` (padrão: 110 km → R$ 250)
//   4. acima disso: km rodoviário estimado × `perKmCents`  (km reta × `roadFactor`), nunca menos que a faixa 3
//
// Coordenadas do CEP: AwesomeAPI (coordenada por CEP) → BrasilAPI v2 → OpenStreetMap (cidade). Resultado em cache.
import { db } from "./db.js";
import { fail } from "./http.js";

export const DEFAULT_SHIPPING = {
  originLat: -23.6155, originLng: -46.6014,          // Rod. Anchieta, 1138 — Vila Moinho Velho (SP)
  near: { km: 7, cents: 5000 },
  abc: { cents: 10000, cities: ["Santo André", "São Bernardo do Campo", "São Caetano do Sul", "Diadema", "Mauá", "Ribeirão Pires", "Rio Grande da Serra"] },
  region: { km: 110, cents: 25000 },
  perKmCents: 175,
  roadFactor: 1.3,
};

export const shippingSettings = settings => {
  const s = settings?.shipping || {};
  return {
    ...DEFAULT_SHIPPING, ...s,
    near: { ...DEFAULT_SHIPPING.near, ...(s.near || {}) },
    abc: { ...DEFAULT_SHIPPING.abc, ...(s.abc || {}) },
    region: { ...DEFAULT_SHIPPING.region, ...(s.region || {}) },
  };
};

const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function getJson(url, headers = {}) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Busca dados e coordenadas do CEP (com cache no banco).
export async function lookupCep(cep) {
  const q = await db();
  const [cached] = await q.query("SELECT * FROM cep_cache WHERE cep = $1", [cep]);
  if (cached && cached.lat != null) return cached;

  let r = null;
  const a = await getJson(`https://cep.awesomeapi.com.br/json/${cep}`);
  if (a && a.lat && a.lng && a.city) r = { lat: +a.lat, lng: +a.lng, city: a.city, uf: a.state, street: a.address || null, district: a.district || null, source: "awesomeapi" };
  if (!r) {
    const b = await getJson(`https://brasilapi.com.br/api/cep/v2/${cep}`);
    if (b && b.city) {
      const c = b.location?.coordinates || {};
      r = { lat: c.latitude ? +c.latitude : null, lng: c.longitude ? +c.longitude : null, city: b.city, uf: b.state, street: b.street || null, district: b.neighborhood || null, source: "brasilapi" };
      if (r.lat == null) {
        const n = await getJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&city=${encodeURIComponent(b.city)}&state=${encodeURIComponent(b.state)}`,
          { "User-Agent": "rsc-equipamentos-frete/1.0" });
        if (n?.[0]) { r.lat = +n[0].lat; r.lng = +n[0].lon; r.source = "brasilapi+osm-cidade"; }
      }
    }
  }
  if (!r || r.lat == null) return null;
  await q.query(
    `INSERT INTO cep_cache (cep, lat, lng, city, uf, street, district, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (cep) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, city = EXCLUDED.city, uf = EXCLUDED.uf,
       street = EXCLUDED.street, district = EXCLUDED.district, source = EXCLUDED.source, created_at = now()`,
    [cep, r.lat, r.lng, r.city, r.uf, r.street, r.district, r.source]);
  return { cep, ...r };
}

// Calcula o frete a partir de um local já resolvido (puro — usado também nos testes).
export function priceFor(loc, cfg) {
  const km = haversineKm(cfg.originLat, cfg.originLng, loc.lat, loc.lng);
  const isAbc = cfg.abc.cities.some(c => norm(c) === norm(loc.city)) && norm(loc.uf) === "sp";
  let zone, cents;
  if (km <= cfg.near.km) { zone = "raio_proximo"; cents = cfg.near.cents; }
  else if (isAbc) { zone = "abc"; cents = cfg.abc.cents; }
  else if (km <= cfg.region.km) { zone = "regiao"; cents = cfg.region.cents; }
  else { zone = "por_km"; cents = Math.max(cfg.region.cents, Math.round(km * cfg.roadFactor * cfg.perKmCents / 100) * 100); }
  const labels = { raio_proximo: `Até ${cfg.near.km} km da loja`, abc: "Região do ABC", regiao: `Até ${cfg.region.km} km da loja`, por_km: `Por distância (~${Math.round(km * cfg.roadFactor)} km rodoviários)` };
  return { cents, zone, label: labels[zone], distanceKm: Math.round(km * 10) / 10, city: loc.city, uf: loc.uf };
}

export async function quoteShipping(storeSettings, rawCep) {
  const cep = String(rawCep || "").replace(/\D/g, "");
  if (cep.length !== 8) fail(422, "Informe um CEP válido com 8 dígitos.");
  const loc = await lookupCep(cep);
  if (!loc) fail(422, "Não encontramos este CEP. Confira o número ou escolha retirar na loja.", { code: "CEP_NOT_FOUND" });
  return { cep, ...priceFor(loc, shippingSettings(storeSettings)), street: loc.street, district: loc.district };
}
