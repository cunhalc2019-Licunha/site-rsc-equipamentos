// Ambiente de teste: Postgres em memória (PGlite), e-mails capturados em memória,
// chamadas HTTP simuladas direto no roteador da API (sem servidor).
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "pglite:memory";
process.env.EMAIL_TRANSPORT = "memory";
process.env.AUTH_SECRET = "segredo-de-teste-com-mais-de-16";
process.env.OWNER_EMAIL = "dono@rsc.test";
process.env.CRON_SECRET = "cron-teste";
process.env.UPLOAD_DIR = path.join(os.tmpdir(), "rsc-test-uploads");

const { default: router } = await import("../api/router.js");
export const { db } = await import("../api/_lib/db.js");

const HOST = "loja.test";

// Simula uma requisição. opts: { body, jar (objeto que guarda o cookie), headers, origin:false }
export async function call(method, url, opts = {}) {
  const headers = { host: HOST, "content-type": "application/json", ...opts.headers };
  if (opts.origin !== false && method !== "GET") headers.origin = `http://${HOST}`;
  if (opts.jar?.cookie) headers.cookie = opts.jar.cookie;
  const req = { method, url, headers, body: opts.body ?? {}, socket: { remoteAddress: opts.ip || "10.0.0.1" } };
  const res = {
    statusCode: 200, headers: {}, data: undefined, writableEnded: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.data = o; this.writableEnded = true; return this; },
  };
  await router(req, res);
  const sc = res.headers["set-cookie"];
  if (opts.jar && sc) {
    const v = String(sc).split(";")[0];
    opts.jar.cookie = v.endsWith("=") ? "" : v;
  }
  return { status: res.statusCode, body: res.data, headers: res.headers };
}

export const outbox = () => (globalThis.__outbox ??= []);
export function lastCode(email) {
  const m = [...outbox()].reverse().find(x => x.to === email && /Código: \d{6}/.test(x.text));
  return m && m.text.match(/Código: (\d{6})/)[1];
}

// Cria a loja + dono (e-mail confirmado) e devolve o "jar" com a sessão.
export async function setupOwner({ importCatalog = false, email = "dono@rsc.test", password = "senha-segura-123" } = {}) {
  const s = await call("POST", "/api/auth/setup/send-code", { body: { email } });
  if (s.status !== 200) throw new Error("envio do código falhou: " + JSON.stringify(s.body));
  const jar = {};
  const r = await call("POST", "/api/auth/setup", { jar, body: { email, code: lastCode(email), storeName: "RSC Teste", name: "Dono", password, importCatalog } });
  if (r.status !== 200) throw new Error("setup falhou: " + JSON.stringify(r.body));
  return { jar, email, password };
}

export async function firstCategory(jar) {
  return (await call("GET", "/api/admin/categories", { jar })).body.categories[0].id;
}

export async function makeProduct(jar, over = {}, qty = 1) {
  const categoryId = over.categoryId || await firstCategory(jar);
  const r = await call("POST", "/api/admin/products", { jar, body: {
    name: "Produto " + Math.random().toString(36).slice(2, 7), categoryId, condition: "novo", stockType: qty > 1 ? "quantidade" : "unico",
    priceCents: 100000, images: ["/img/logo.png"], published: true, state: "ativo",
    initialEntry: { quantity: qty, origin: "compra" }, ...over } });
  if (r.status !== 200) throw new Error("produto falhou: " + JSON.stringify(r.body));
  const p = (await call("GET", `/api/admin/products/${r.body.id}`, { jar })).body.product;
  return p;
}

export const customer = { name: "Cliente Teste", email: "cliente@ex.test", phone: "11999998888", document: "123.456.789-09" };

export async function order(items, extra = {}) {
  return call("POST", "/api/orders", { body: { items, customer, method: "pix", delivery: "retirada", ...extra }, ip: extra.ip || "10.9.9." + Math.floor(Math.random() * 250) });
}

export async function inv(productId) {
  const [r] = await (await db()).query("SELECT on_hand, reserved, sold FROM inventory WHERE product_id = $1", [productId]);
  return r;
}
