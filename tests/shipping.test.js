// Frete com entrega própria: faixas por distância/ABC/por km, cálculo no servidor e soma ao total do pedido.
import { test } from "node:test";
import assert from "node:assert/strict";
import { call, setupOwner, makeProduct, customer, db } from "./helpers.js";
import { priceFor, DEFAULT_SHIPPING } from "../api/_lib/shipping.js";

const cfg = DEFAULT_SHIPPING;
// coordenadas reais (AwesomeAPI) de CEPs de cada região
const LOC = {
  saoCaetano:  { lat: -23.6191912, lng: -46.5526981, city: "São Caetano do Sul", uf: "SP" },   // ~5 km da loja
  ipiranga:    { lat: -23.5846441, lng: -46.6055727, city: "São Paulo", uf: "SP" },             // ~3,5 km
  santoAndre:  { lat: -23.6565824, lng: -46.5271332, city: "Santo André", uf: "SP" },           // ~9 km, ABC
  maua:        { lat: -23.6660105, lng: -46.4544843, city: "Mauá", uf: "SP" },                  // ~16 km, ABC
  zonaNorte:   { lat: -23.4700000, lng: -46.6300000, city: "São Paulo", uf: "SP" },             // ~16 km, não ABC
  campinas:    { lat: -22.9064459, lng: -47.056164,  city: "Campinas", uf: "SP" },              // ~90 km
  rio:         { lat: -22.9064200, lng: -43.1822300, city: "Rio de Janeiro", uf: "RJ" },        // ~360 km
};

test("faixas: até 7 km R$ 50 · ABC R$ 100 · até 110 km R$ 250 · demais por km", () => {
  assert.equal(priceFor(LOC.ipiranga, cfg).cents, 5000);
  assert.equal(priceFor(LOC.saoCaetano, cfg).cents, 5000, "ABC dentro do raio de 7 km paga o menor valor");
  assert.equal(priceFor(LOC.santoAndre, cfg).zone, "abc");
  assert.equal(priceFor(LOC.santoAndre, cfg).cents, 10000);
  assert.equal(priceFor(LOC.maua, cfg).cents, 10000);
  assert.equal(priceFor(LOC.zonaNorte, cfg).cents, 25000, "São Paulo fora do raio de 7 km = faixa regional");
  assert.equal(priceFor(LOC.campinas, cfg).cents, 25000);
  const rio = priceFor(LOC.rio, cfg);
  assert.equal(rio.zone, "por_km");
  const esperado = Math.round(rio.distanceKm * cfg.roadFactor * cfg.perKmCents / 100) * 100;
  assert.ok(Math.abs(rio.cents - esperado) <= 100, `Rio: ${rio.cents} ≈ ${esperado}`);
  assert.ok(rio.cents > 25000, "longa distância nunca é mais barata que a faixa regional");
});

test("pedido com entrega: frete calculado no servidor e somado ao total; valor enviado pelo navegador é ignorado", async () => {
  const { jar } = await setupOwner();
  const q = await db();
  // CEPs em cache (sem acesso à internet nos testes)
  await q.query(`INSERT INTO cep_cache (cep, lat, lng, city, uf, source) VALUES
    ('09010000', -23.6565824, -46.5271332, 'Santo André', 'SP', 'teste'),
    ('20040002', -22.90642, -43.18223, 'Rio de Janeiro', 'RJ', 'teste')`);
  const quote = await call("GET", "/api/shipping/quote?cep=09010-000");
  assert.equal(quote.status, 200);
  assert.equal(quote.body.quote.cents, 10000);

  const p = await makeProduct(jar, { priceCents: 300000 }, 5);
  const address = { cep: "09010-000", street: "Rua Coronel Oliveira Lima", number: "100", district: "Centro", city: "Santo André", uf: "SP" };
  const o = await call("POST", "/api/orders", { ip: "40.0.0.1", body: {
    items: [{ id: p.id, quantity: 1 }], customer, method: "boleto", delivery: "entrega", address,
    shipping: { cents: 1 }, shippingCents: 1, totalCents: 1 } });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(o.body.order.shippingCents, 10000, "frete do ABC");
  assert.equal(o.body.order.totalCents, 300000 + 10000, "equipamento + frete");
  const pub = (await call("GET", `/api/orders/${o.body.order.token}`)).body.order;
  assert.equal(pub.shipping_cents, 10000);

  const retirada = await call("POST", "/api/orders", { ip: "40.0.0.2", body: { items: [{ id: p.id, quantity: 1 }], customer, method: "boleto", delivery: "retirada" } });
  assert.equal(retirada.body.order.shippingCents, 0, "retirada na loja não cobra frete");

  const semCep = await call("GET", "/api/shipping/quote?cep=123");
  assert.equal(semCep.status, 422);
});

test("valores do frete editáveis em Configurações (e preservados ao salvar)", async () => {
  const jar = {};
  await call("POST", "/api/auth/login", { body: { email: "dono@rsc.test", password: "senha-segura-123" }, jar, ip: "41.0.0.1" });
  const put = await call("PUT", "/api/admin/settings", { jar, body: { name: "RSC", reservationHours: 24, lowStockThreshold: 2, whatsapp: "11999999999",
    shipping: { nearKm: 7, nearCents: 6000, abcCents: 12000, regionKm: 110, regionCents: 30000, perKmCents: 200, roadFactor: 1.3 } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const quote = await call("GET", "/api/shipping/quote?cep=09010000");
  assert.equal(quote.body.quote.cents, 12000, "novo valor do ABC aplicado");
  const s = (await call("GET", "/api/admin/settings", { jar })).body.settings.shipping;
  assert.equal(s.abc.cities.length, 7, "lista do ABC preservada");
});
