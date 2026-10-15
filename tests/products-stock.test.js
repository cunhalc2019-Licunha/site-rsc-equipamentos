// Testes 2–9, 14, 15, 21, 22: produtos, imagens, SKU, entrada, venda física, catálogo e histórico.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { call, setupOwner, makeProduct, firstCategory, order, inv, db } from "./helpers.js";

const { jar } = await setupOwner();

test("cadastro e edição de produto, com preço promocional e histórico de alterações", async () => {
  const p = await makeProduct(jar, { name: "Freezer Metalfrio 500L", sku: "FZ-0048", condition: "usado_revisado" }, 1);
  assert.equal(p.sku, "FZ-0048");
  assert.equal(p.on_hand, 1);
  assert.equal(p.movements[0].type, "entrada");

  const edit = await call("PUT", `/api/admin/products/${p.id}`, { jar, body: {
    name: "Freezer Metalfrio 500L revisado", sku: "FZ-0048", categoryId: p.category_id, condition: "usado_revisado", stockType: "unico",
    priceCents: 350000, promoPriceCents: 320000, images: ["/img/logo.png", "/img/produtos/x.jpg"], published: true, state: "ativo" } });
  assert.equal(edit.status, 200);
  const after = (await call("GET", `/api/admin/products/${p.id}`, { jar })).body.product;
  assert.equal(after.promo_price_cents, 320000);
  assert.deepEqual(after.images, ["/img/logo.png", "/img/produtos/x.jpg"], "ordem das fotos preservada (1ª = principal)");
  const [log] = await (await db()).query("SELECT data FROM audit_logs WHERE action = 'product.update' ORDER BY id DESC LIMIT 1");
  assert.ok(log.data.changes.price, "alteração de preço registrada na auditoria");

  const badPromo = await call("PUT", `/api/admin/products/${p.id}`, { jar, body: { ...edit, name: "X", categoryId: p.category_id, condition: "novo", stockType: "unico", priceCents: 1000, promoPriceCents: 2000 } });
  assert.equal(badPromo.status, 422, "promocional maior que o preço é recusado");
});

test("SKU duplicado na mesma loja é recusado", async () => {
  await makeProduct(jar, { sku: "PR-001" }, 20);
  const dup = await call("POST", "/api/admin/products", { jar, body: { name: "Outro", sku: "PR-001", categoryId: await firstCategory(jar), condition: "novo", stockType: "quantidade" } });
  assert.equal(dup.status, 409);
});

test("upload de imagem: aceita JPG real, recusa arquivo que não é imagem", async () => {
  const jpg = readFileSync("img/produtos/rsc-produto-001.jpg").toString("base64");
  const ok = await call("POST", "/api/admin/uploads", { jar, body: { data: jpg } });
  assert.equal(ok.status, 200);
  assert.match(ok.body.url, /^\/uploads\/produtos\/[\w-]+\.jpg$/);
  const fake = await call("POST", "/api/admin/uploads", { jar, body: { data: Buffer.from("<script>alert(1)</script>").toString("base64") } });
  assert.equal(fake.status, 415);
});

test("publicação: só aparece no catálogo se ativo + publicado + com estoque disponível", async () => {
  const p = await makeProduct(jar, { name: "Mesa Inox Catálogo" }, 1);
  let cat = (await call("GET", "/api/catalog")).body;
  assert.ok(cat.products.some(x => x.uid === p.id), "publicado aparece");
  await call("POST", `/api/admin/products/${p.id}/state`, { jar, body: { published: false } });
  cat = (await call("GET", "/api/catalog")).body;
  assert.ok(!cat.products.some(x => x.uid === p.id), "despublicado some");
  await call("POST", `/api/admin/products/${p.id}/state`, { jar, body: { published: true } });
  const noPhoto = await makeProduct(jar, { images: [], published: false }, 1);
  const pub = await call("POST", `/api/admin/products/${noPhoto.id}/state`, { jar, body: { published: true } });
  assert.equal(pub.status, 422, "sem foto não publica");
});

test("entrada de mercadoria: transacional e registrada no histórico", async () => {
  const p = await makeProduct(jar, { stockType: "quantidade" }, 0);
  assert.equal((await inv(p.id)).on_hand, 0);
  const r = await call("POST", "/api/admin/stock/entries", { jar, body: { productId: p.id, quantity: 3, origin: "fornecedor", date: "2026-10-01", unitCostCents: 5000, note: "NF 123" } });
  assert.equal(r.status, 200);
  assert.equal((await inv(p.id)).on_hand, 3);
  const [m] = await (await db()).query("SELECT * FROM stock_movements WHERE product_id = $1 AND type = 'entrada' ORDER BY created_at DESC LIMIT 1", [p.id]);
  assert.equal(m.physical_before, 0); assert.equal(m.physical_after, 3); assert.ok(m.user_id);
  const unico = await makeProduct(jar, {}, 1);
  const over = await call("POST", "/api/admin/stock/entries", { jar, body: { productId: unico.id, quantity: 1, origin: "compra" } });
  assert.equal(over.status, 422, "produto único não passa de 1");
});

test("venda física de produto único: 1 → 0 e sai do catálogo", async () => {
  const p = await makeProduct(jar, { name: "Balcão Único" }, 1);
  const r = await call("POST", "/api/admin/sales", { jar, body: { items: [{ productId: p.id, quantity: 1 }], paymentMethod: "pix" } });
  assert.equal(r.status, 200);
  assert.deepEqual(await inv(p.id), { on_hand: 0, reserved: 0, sold: 1 });
  const cat = (await call("GET", "/api/catalog")).body;
  assert.ok(!cat.products.some(x => x.uid === p.id));
  const [m] = await (await db()).query("SELECT type, user_id FROM stock_movements WHERE product_id = $1 ORDER BY created_at DESC LIMIT 1", [p.id]);
  assert.equal(m.type, "venda_fisica"); assert.ok(m.user_id);
  const again = await call("POST", "/api/admin/sales", { jar, body: { items: [{ productId: p.id, quantity: 1 }] } });
  assert.equal(again.status, 422);
});

test("venda física com várias unidades baixa só a quantidade vendida", async () => {
  const p = await makeProduct(jar, {}, 20);
  await call("POST", "/api/admin/sales", { jar, body: { items: [{ productId: p.id, quantity: 2 }] } });
  assert.deepEqual(await inv(p.id), { on_hand: 18, reserved: 0, sold: 2 });
  const cat = (await call("GET", "/api/catalog")).body;
  assert.equal(cat.products.find(x => x.uid === p.id).stock, 18, "site mostra a disponibilidade atualizada");
});

test("venda física de item reservado é bloqueada; exceção exige motivo e é auditada", async () => {
  const p = await makeProduct(jar, { name: "Geladeira Reservada" }, 1);
  const o = await order([{ id: p.id, quantity: 1 }]);
  assert.equal(o.status, 200);
  const blocked = await call("POST", "/api/admin/sales", { jar, body: { items: [{ productId: p.id, quantity: 1 }] } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "RESERVED");
  const noReason = await call("POST", "/api/admin/sales", { jar, body: { items: [{ productId: p.id, quantity: 1 }], override: {} } });
  assert.equal(noReason.status, 422);
  const ok = await call("POST", "/api/admin/sales", { jar, body: { items: [{ productId: p.id, quantity: 1 }], override: { reason: "Cliente pagou no balcão" } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await inv(p.id), { on_hand: 0, reserved: 0, sold: 1 });
  const [ord] = await (await db()).query("SELECT status FROM orders WHERE number = $1 AND channel = 'online'", [o.body.order.number]);
  assert.equal(ord.status, "cancelado", "pedido online cancelado explicitamente");
  const [iss] = await (await db()).query("SELECT type FROM order_issues WHERE type = 'reserva_cancelada_venda_fisica'");
  assert.ok(iss, "ocorrência registrada");
  const [a] = await (await db()).query("SELECT 1 FROM audit_logs WHERE action = 'sale.physical.override'");
  assert.ok(a);
});

test("navegador não define preço nem estoque", async () => {
  const p = await makeProduct(jar, { priceCents: 500000 }, 5);
  const o = await order([{ id: p.id, quantity: 1, price: 1, unit_price_cents: 1 }], { total: 1, totalCents: 1 });
  assert.equal(o.status, 200);
  assert.equal(o.body.order.totalCents, 500000, "total calculado pelo banco");
  const tamper = await call("PUT", `/api/admin/products/${p.id}`, { body: { priceCents: 1 } });
  assert.equal(tamper.status, 401, "sem login não altera preço");
  const tamperStock = await call("POST", "/api/admin/stock/entries", { body: { productId: p.id, quantity: 999 } });
  assert.equal(tamperStock.status, 401);
});

test("histórico preservado: editar o produto não altera pedidos antigos", async () => {
  const p = await makeProduct(jar, { name: "Nome Original", priceCents: 200000 }, 3);
  const o = await order([{ id: p.id, quantity: 1 }]);
  await call("PUT", `/api/admin/products/${p.id}`, { jar, body: { name: "Nome Novo", categoryId: p.category_id, condition: "novo", stockType: "quantidade", priceCents: 999900, images: ["/img/logo.png"], published: true } });
  const [item] = await (await db()).query("SELECT oi.name, oi.unit_price_cents FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.number = $1", [o.body.order.number]);
  assert.equal(item.name, "Nome Original");
  assert.equal(item.unit_price_cents, 200000);
});

test("ajuste exige motivo e justificativa; nenhuma alteração de saldo sem movimentação", async () => {
  const p = await makeProduct(jar, {}, 5);
  const noNote = await call("POST", "/api/admin/stock/adjustments", { jar, body: { productId: p.id, delta: -1, reason: "perda" } });
  assert.equal(noNote.status, 422);
  const ok = await call("POST", "/api/admin/stock/adjustments", { jar, body: { productId: p.id, delta: -1, reason: "perda", note: "Avaria no transporte" } });
  assert.equal(ok.status, 200);
  const [{ sum }] = await (await db()).query("SELECT sum(physical_delta)::int AS sum FROM stock_movements WHERE product_id = $1", [p.id]);
  assert.equal(sum, (await inv(p.id)).on_hand, "saldo físico = soma das movimentações");
});
