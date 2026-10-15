// Migração: um banco criado na fase 1 (com dados) passa para a fase 2 sem perder informações.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../api/_lib/db.js";

test("banco da fase 1 é migrado preservando produtos, preços e movimentações", async () => {
  const pg = new PGlite();
  const wrap = q => ({ query: async (s, p = []) => (await q.query(s, p)).rows, exec: s => q.exec(s) });
  const driver = { ...wrap(pg), tx: fn => pg.transaction(t => fn(wrap(t))) };

  // estrutura exatamente como na fase 1 (antes de existir o controle de migrations)
  await pg.exec(readFileSync("api/_lib/migrations/001_base.sql", "utf8"));
  const [s] = (await pg.query("INSERT INTO stores (name, slug) VALUES ('RSC', 'rsc') RETURNING id")).rows;
  const [c] = (await pg.query("INSERT INTO categories (store_id, name, slug) VALUES ($1, 'Geral', 'geral') RETURNING id", [s.id])).rows;
  const ins = async (name, status, price, old) => (await pg.query(
    `INSERT INTO products (store_id, category_id, sku, slug, name, condition, stock_type, price_cents, old_price_cents, status)
     VALUES ($1,$2,$3,$3,$4,'seminovo','unico',$5,$6,$7) RETURNING id`, [s.id, c.id, name.toLowerCase(), name, price, old, status])).rows[0].id;
  const pub = await ins("Publicado", "publicado", 290000, 540000);
  const draft = await ins("Rascunho", "rascunho", 100000, null);
  const arch = await ins("Arquivado", "arquivado", 50000, null);
  for (const id of [pub, draft, arch]) await pg.query("INSERT INTO inventory (product_id, store_id, on_hand) VALUES ($1,$2,0)", [id, s.id]);
  await pg.query(`INSERT INTO stock_movements (store_id, product_id, type, quantity, reason, balance_after) VALUES
    ($1,$2,'entrada',1,'compra',1), ($1,$2,'saida',-1,'venda_loja',0)`, [s.id, pub]);

  await migrate(driver);
  await migrate(driver); // rodar de novo não faz nada

  const rows = Object.fromEntries((await pg.query("SELECT name, state, published, price_cents, promo_price_cents FROM products")).rows.map(r => [r.name, r]));
  assert.deepEqual(rows.Publicado, { name: "Publicado", state: "ativo", published: true, price_cents: 540000, promo_price_cents: 290000 }, "preço 'De' vira preço normal e o antigo preço vira promocional");
  assert.equal(rows.Rascunho.published, false);
  assert.equal(rows.Arquivado.state, "arquivado");
  const movs = (await pg.query("SELECT type, quantity, physical_delta, physical_before, physical_after FROM stock_movements ORDER BY physical_after DESC")).rows;
  assert.deepEqual(movs, [
    { type: "entrada", quantity: 1, physical_delta: 1, physical_before: 0, physical_after: 1 },
    { type: "venda_fisica", quantity: 1, physical_delta: -1, physical_before: 1, physical_after: 0 },
  ]);
  const versions = (await pg.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map(r => r.version);
  assert.deepEqual(versions, ["001_base", "002_fase2"]);
});
