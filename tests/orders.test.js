// Testes 10–13, 16–18 e 20: reservas, expiração, concorrência, pagamento (controlado) e isolamento.
import { test } from "node:test";
import assert from "node:assert/strict";
import { call, setupOwner, makeProduct, order, inv, db } from "./helpers.js";
import { applyPaymentStatus } from "../api/_lib/payments.js";
import { expireReservations } from "../api/_lib/orders.js";
import { hashPassword } from "../api/_lib/auth.js";

const { jar } = await setupOwner();
const orderId = async number => (await (await db()).query("SELECT id FROM orders WHERE number = $1 AND channel = 'online'", [number]))[0].id;
// Pagamento em TESTE CONTROLADO (provedor "teste" só é aceito com NODE_ENV=test).
async function payment(number, status, ext = "pg-" + number + "-" + status) {
  const id = await orderId(number);
  return (await db()).tx(t => applyPaymentStatus(t, { orderId: id, provider: "teste", externalId: ext, status }));
}

test("adicionar ao carrinho não reserva; o pedido reserva por 24h sem mexer no estoque físico", async () => {
  const p = await makeProduct(jar, {}, 5);
  // carrinho é só local (localStorage) — nenhum endpoint reserva antes do pedido
  assert.deepEqual(await inv(p.id), { on_hand: 5, reserved: 0, sold: 0 });
  const o = await order([{ id: p.id, quantity: 2 }]);
  assert.equal(o.status, 200);
  assert.deepEqual(await inv(p.id), { on_hand: 5, reserved: 2, sold: 0 }, "físico 5, reservado 2, disponível 3");
  const hours = (new Date(o.body.order.reservedUntil) - Date.now()) / 3600000;
  assert.ok(hours > 23.9 && hours <= 24, `prazo calculado pelo backend (${hours.toFixed(2)}h)`);
  const cat = (await call("GET", "/api/catalog")).body.products.find(x => x.uid === p.id);
  assert.equal(cat.stock, 3);
  const pub = await call("GET", `/api/orders/${o.body.order.token}`);
  assert.equal(pub.body.order.status, "aguardando_pagamento");
  assert.equal(pub.body.order.payment_status, "pendente", "pedido pendente: pagamento NÃO é presumido");
});

test("produto único: duas compras simultâneas — só uma consegue reservar", async () => {
  const p = await makeProduct(jar, { name: "Freezer Disputado" }, 1);
  const [a, b] = await Promise.all([order([{ id: p.id, quantity: 1 }], { ip: "20.0.0.1" }), order([{ id: p.id, quantity: 1 }], { ip: "20.0.0.2" })]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.deepEqual(await inv(p.id), { on_hand: 1, reserved: 1, sold: 0 });
  const [{ n }] = await (await db()).query("SELECT count(*)::int AS n FROM reservations WHERE product_id = $1 AND status = 'ativa'", [p.id]);
  assert.equal(n, 1, "apenas uma reserva ativa");
});

test("expiração automática libera a reserva; processar duas vezes não duplica", async () => {
  const p = await makeProduct(jar, {}, 1);
  const o = await order([{ id: p.id, quantity: 1 }]);
  await (await db()).query("UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE order_id = $1", [await orderId(o.body.order.number)]);
  const first = await call("GET", "/api/cron/expire-reservations", { headers: { authorization: "Bearer cron-teste" } });
  assert.equal(first.status, 200);
  assert.ok(first.body.released >= 1);
  assert.deepEqual(await inv(p.id), { on_hand: 1, reserved: 0, sold: 0 });
  const second = await expireReservations(await db());
  const third = await expireReservations(await db());
  assert.equal(second + third, 0, "idempotente");
  assert.deepEqual(await inv(p.id), { on_hand: 1, reserved: 0, sold: 0 }, "estoque não duplicou");
  const [ord] = await (await db()).query("SELECT status FROM orders WHERE number = $1", [o.body.order.number]);
  assert.equal(ord.status, "expirado");
  const [{ n }] = await (await db()).query("SELECT count(*)::int AS n FROM stock_movements WHERE product_id = $1 AND type = 'reserva_liberada'", [p.id]);
  assert.equal(n, 1);
  const noAuth = await call("GET", "/api/cron/expire-reservations");
  assert.equal(noAuth.status, 401, "cron protegido por segredo");
});

test("pagamento confirmado (teste controlado) converte a reserva sem baixar duas vezes", async () => {
  const p = await makeProduct(jar, {}, 5);
  const o = await order([{ id: p.id, quantity: 2 }]);
  await payment(o.body.order.number, "pendente");
  assert.deepEqual(await inv(p.id), { on_hand: 5, reserved: 2, sold: 0 }, "pendente não altera estoque");
  const r = await payment(o.body.order.number, "aprovado");
  assert.equal(r.result, "aprovado");
  assert.deepEqual(await inv(p.id), { on_hand: 3, reserved: 0, sold: 2 }, "5 físico − 2 = 3; reserva consumida, não subtraída de novo");
  const again = await payment(o.body.order.number, "aprovado", "outro-evento");
  assert.equal(again.result, "ja_aprovado");
  assert.deepEqual(await inv(p.id), { on_hand: 3, reserved: 0, sold: 2 }, "evento repetido não baixa de novo");
  // reserva já paga não é liberada pela expiração
  await expireReservations(await db());
  assert.deepEqual(await inv(p.id), { on_hand: 3, reserved: 0, sold: 2 });
});

test("pagamento tardio após expiração: vende se houver estoque; senão registra ocorrência sem estoque negativo", async () => {
  const p = await makeProduct(jar, { name: "Coifa Tardia" }, 1);
  const o1 = await order([{ id: p.id, quantity: 1 }]);
  await (await db()).query("UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE status = 'ativa'");
  await expireReservations(await db());
  // outra pessoa compra a mesma unidade no balcão
  await call("POST", "/api/admin/sales", { jar, body: { items: [{ productId: p.id, quantity: 1 }] } });
  const late = await payment(o1.body.order.number, "aprovado");
  assert.equal(late.result, "conflito_sem_estoque");
  assert.deepEqual(await inv(p.id), { on_hand: 0, reserved: 0, sold: 1 }, "sem estoque negativo e sem 2ª venda");
  const [iss] = await (await db()).query("SELECT type FROM order_issues WHERE order_id = $1", [await orderId(o1.body.order.number)]);
  assert.equal(iss.type, "pagamento_apos_expiracao_sem_estoque");

  const q2 = await makeProduct(jar, { name: "Estante Tardia" }, 1);
  const o2 = await order([{ id: q2.id, quantity: 1 }]);
  await (await db()).query("UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE status = 'ativa'");
  await expireReservations(await db());
  const ok = await payment(o2.body.order.number, "aprovado");
  assert.equal(ok.result, "aprovado_tardio");
  assert.deepEqual(await inv(q2.id), { on_hand: 0, reserved: 0, sold: 1 });
});

test("painel não tem rota para aprovar pagamento online", async () => {
  const p = await makeProduct(jar, {}, 2);
  const o = await order([{ id: p.id, quantity: 1 }]);
  const id = await orderId(o.body.order.number);
  const tryPaid = await call("POST", `/api/admin/orders/${id}/advance`, { jar, body: { status: "pago" } });
  assert.equal(tryPaid.status, 422);
  const webhook = await call("POST", "/api/webhooks/mercadopago", { body: { type: "payment" } });
  assert.equal(webhook.status, 501, "webhook reservado para a etapa 3");
  const cancel = await call("POST", `/api/admin/orders/${id}/cancel`, { jar, body: { reason: "Cliente desistiu" } });
  assert.equal(cancel.status, 200);
  assert.deepEqual(await inv(p.id), { on_hand: 2, reserved: 0, sold: 0 }, "cancelamento libera a reserva");
});

test("isolamento entre lojas: um lojista nunca acessa dados de outra loja", async () => {
  const q = await db();
  const [s2] = await q.query("INSERT INTO stores (name, slug) VALUES ('Outra Loja', 'outra') RETURNING id");
  const hash = await hashPassword("senha-outra-loja-1");
  await q.query("INSERT INTO users (store_id, name, email, password_hash, role, email_verified_at) VALUES ($1,'Outro dono','outro@loja.test',$2,'owner',now())", [s2.id, hash]);
  await q.query("INSERT INTO categories (store_id, name, slug) VALUES ($1, 'Geral', 'geral')", [s2.id]);
  const other = {};
  assert.equal((await call("POST", "/api/auth/login", { body: { email: "outro@loja.test", password: "senha-outra-loja-1" }, jar: other, ip: "30.0.0.1" })).status, 200);

  const mine = await makeProduct(jar, { name: "Produto da RSC" }, 1);
  assert.equal((await call("GET", `/api/admin/products/${mine.id}`, { jar: other })).status, 404);
  assert.equal((await call("PUT", `/api/admin/products/${mine.id}`, { jar: other, body: { name: "hack", categoryId: mine.category_id, condition: "novo", stockType: "unico" } })).status, 404);
  assert.equal((await call("POST", "/api/admin/stock/entries", { jar: other, body: { productId: mine.id, quantity: 1, origin: "compra" } })).status, 404);
  assert.equal((await call("POST", "/api/admin/sales", { jar: other, body: { items: [{ productId: mine.id, quantity: 1 }] } })).status, 404);
  const list = (await call("GET", "/api/admin/products", { jar: other })).body.products;
  assert.equal(list.length, 0);
  const orders = (await call("GET", "/api/admin/orders?channel=todos", { jar: other })).body.orders;
  assert.equal(orders.length, 0);
  // store_id enviado pelo navegador é ignorado
  const sneaky = await call("POST", "/api/admin/products", { jar: other, body: { storeId: "qualquer", name: "X", categoryId: mine.category_id, condition: "novo", stockType: "unico" } });
  assert.equal(sneaky.status, 422, "categoria de outra loja é recusada");
});

test("dashboard calcula indicadores a partir do banco", async () => {
  const d = (await call("GET", "/api/admin/dashboard", { jar })).body;
  const [{ awaiting }] = await (await db()).query(
    "SELECT count(*)::int AS awaiting FROM orders WHERE channel = 'online' AND status = 'aguardando_pagamento' AND store_id = (SELECT store_id FROM users WHERE email = 'dono@rsc.test')");
  assert.equal(d.orders.awaiting, awaiting);
  assert.ok(d.products.active > 0);
  assert.ok(Array.isArray(d.movements) && d.movements.length > 0);
});
