// Acesso ao banco. Produção: PostgreSQL via DATABASE_URL (Neon, Supabase ou qualquer Postgres).
// Desenvolvimento local sem banco instalado: DATABASE_URL=pglite:./.data/db (Postgres embutido).
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

let driverPromise;
let schemaReady;

async function createDriver() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não configurada");

  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = url.slice("pglite:".length);
    mkdirSync(dir, { recursive: true });
    const pg = new PGlite(dir);
    const wrap = q => ({ query: async (sql, params = []) => (await q.query(sql, params)).rows });
    return {
      ...wrap(pg),
      exec: sql => pg.exec(sql),
      tx: fn => pg.transaction(t => fn(wrap(t))),
    };
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
        const result = await fn({ query: async (sql, params = []) => (await client.query(sql, params)).rows });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

export async function db() {
  driverPromise ??= createDriver().catch(err => { driverPromise = null; throw err; });
  const driver = await driverPromise;
  schemaReady ??= driver.exec(readFileSync(path.join(process.cwd(), "api", "_lib", "schema.sql"), "utf8"))
    .catch(err => { schemaReady = null; throw err; });
  await schemaReady;
  return driver;
}
