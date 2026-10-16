// Acesso ao banco + migrations versionadas (api/_lib/migrations/NNN_nome.sql).
// Produção: PostgreSQL via DATABASE_URL (Neon, Supabase ou qualquer Postgres).
// Desenvolvimento/testes sem Postgres instalado: DATABASE_URL=pglite:./.data/db  ou  pglite:memory
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { HttpError } from "./http.js";

const MIGRATIONS_DIR = path.join(process.cwd(), "api", "_lib", "migrations");
let driverPromise;
let migrated;

async function createDriver() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new HttpError(503, "Banco de dados não configurado: crie o banco (Vercel → Storage → Neon) para gerar a variável DATABASE_URL e faça Redeploy.");

  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = url.slice("pglite:".length);
    let pg;
    if (dir === "memory") pg = new PGlite();
    else { mkdirSync(dir, { recursive: true }); pg = new PGlite(dir); }
    const wrap = q => ({ query: async (sql, params = []) => (await q.query(sql, params)).rows, exec: sql => q.exec(sql) });
    return { ...wrap(pg), tx: fn => pg.transaction(t => fn(wrap(t))) };
  }

  const { default: pgLib } = await import("pg");
  const pool = new pgLib.Pool({ connectionString: url, max: 3 });
  return {
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    exec: sql => pool.query(sql),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async (sql, params = []) => (await client.query(sql, params)).rows,
          exec: sql => client.query(sql),
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

// Aplica, em ordem, as migrations ainda não aplicadas. Cada uma roda numa transação com trava
// (pg_advisory_xact_lock), então duas instâncias iniciando juntas não aplicam a mesma migration duas vezes.
export async function migrate(driver) {
  await driver.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    await driver.tx(async t => {
      await t.query("SELECT pg_advisory_xact_lock(727272)");
      const done = await t.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (done.length) return;
      await t.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
      await t.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    });
  }
}

export async function db() {
  driverPromise ??= createDriver().catch(err => { driverPromise = null; throw err; });
  const driver = await driverPromise;
  migrated ??= migrate(driver).catch(err => { migrated = null; throw err; });
  await migrated;
  return driver;
}
