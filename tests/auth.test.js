// Testes 1 (login e verificação de e-mail) e 19 (acesso não autorizado) + convites e recuperação de senha.
import { test } from "node:test";
import assert from "node:assert/strict";
import { call, setupOwner, lastCode, db, outbox } from "./helpers.js";

test("primeiro acesso: só o e-mail do proprietário recebe código; conta criada só após confirmar; uma vez só", async () => {
  const intruso = await call("POST", "/api/auth/setup/send-code", { body: { email: "intruso@x.test" } });
  assert.equal(intruso.status, 403, "e-mail diferente de OWNER_EMAIL não recebe código");
  const semCodigo = await call("POST", "/api/auth/setup", { body: { email: "dono@rsc.test", code: "123456", storeName: "X", name: "X", password: "senha-segura-123" } });
  assert.equal(semCodigo.status, 400, "sem código enviado, nada é criado");
  const [{ n }] = await (await db()).query("SELECT count(*)::int AS n FROM users");
  assert.equal(n, 0, "nenhuma conta criada antes da confirmação");
  const { jar } = await setupOwner();
  assert.ok(jar.cookie, "sessão criada após confirmar o código");
  const [u] = await (await db()).query("SELECT role, email_verified_at FROM users WHERE email = 'dono@rsc.test'");
  assert.equal(u.role, "owner"); assert.ok(u.email_verified_at, "e-mail já confirmado pelo código");
  const again = await call("POST", "/api/auth/setup/send-code", { body: { email: "dono@rsc.test" } });
  assert.equal(again.status, 409);
  const status = await call("GET", "/api/auth/setup-status");
  assert.equal(status.body.needsSetup, false);
});

test("senha nunca fica em texto puro", async () => {
  const [u] = await (await db()).query("SELECT password_hash FROM users WHERE email = 'dono@rsc.test'");
  assert.match(u.password_hash, /^scrypt\$/);
  assert.ok(!u.password_hash.includes("senha-segura-123"));
});

test("login: senha errada, bloqueio após 5 falhas, sucesso e logout", async () => {
  const jar = {};
  const wrong = await call("POST", "/api/auth/login", { body: { email: "dono@rsc.test", password: "errada-errada" }, ip: "1.1.1.1" });
  assert.equal(wrong.status, 401);
  const ok = await call("POST", "/api/auth/login", { body: { email: "dono@rsc.test", password: "senha-segura-123" }, jar, ip: "2.2.2.2" });
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers["set-cookie"]), /HttpOnly; SameSite=Strict/);
  assert.equal((await call("GET", "/api/auth/me", { jar })).status, 200);
  await call("POST", "/api/auth/logout", { jar });
  assert.equal((await call("GET", "/api/auth/me", { jar })).status, 401);
  for (let i = 0; i < 5; i++) await call("POST", "/api/auth/login", { body: { email: "alvo@rsc.test", password: "x" }, ip: "3.3.3.3" });
  const locked = await call("POST", "/api/auth/login", { body: { email: "alvo@rsc.test", password: "x" }, ip: "3.3.3.3" });
  assert.equal(locked.status, 429);
});

test("rotas do painel exigem login (acesso não autorizado)", async () => {
  for (const [m, u] of [["GET", "/api/admin/dashboard"], ["GET", "/api/admin/products"], ["POST", "/api/admin/products"], ["POST", "/api/admin/sales"], ["GET", "/api/admin/users"]]) {
    const r = await call(m, u, { body: {} });
    assert.equal(r.status, 401, `${m} ${u}`);
  }
  // CSRF: POST sem cabeçalho Origin do próprio site é recusado
  const csrf = await call("POST", "/api/auth/login", { body: { email: "a", password: "b" }, origin: false });
  assert.equal(csrf.status, 403);
});

test("cadastro só com convite + verificação por código (uso único, tentativas, reenvio)", async () => {
  const noInvite = await call("POST", "/api/auth/register", { body: { name: "Intruso", password: "senha-segura-123" } });
  assert.equal(noInvite.status, 403, "ninguém entra na loja só se cadastrando");

  const owner = {};
  await call("POST", "/api/auth/login", { body: { email: "dono@rsc.test", password: "senha-segura-123" }, jar: owner, ip: "4.4.4.4" });
  const inv = await call("POST", "/api/admin/invites", { jar: owner, body: { email: "vendedor@rsc.test", role: "vendedor" } });
  assert.equal(inv.status, 200);
  const mail = outbox().find(m => m.to === "vendedor@rsc.test");
  const token = mail.text.match(/invite=([\w-]+)/)[1];
  assert.equal((await call("GET", `/api/auth/invite/${token}`)).status, 200);

  const reg = await call("POST", "/api/auth/register", { body: { invite: token, name: "Vendedor", password: "senha-vendedor-1" } });
  assert.equal(reg.status, 200);
  const reuse = await call("POST", "/api/auth/register", { body: { invite: token, name: "Outro", password: "senha-vendedor-1" } });
  assert.equal(reuse.status, 404, "convite é de uso único");

  // login antes de verificar: bloqueado e pede código
  const pre = await call("POST", "/api/auth/login", { body: { email: "vendedor@rsc.test", password: "senha-vendedor-1" }, ip: "5.5.5.5" });
  assert.equal(pre.status, 403);
  assert.equal(pre.body.code, "EMAIL_NOT_VERIFIED");

  // reenvio respeita o intervalo mínimo
  const resend = await call("POST", "/api/auth/resend-code", { body: { email: "vendedor@rsc.test" } });
  assert.equal(resend.status, 429);

  // código errado conta tentativa; 5 erros bloqueiam o código
  const code = lastCode("vendedor@rsc.test");
  const wrongCode = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) {
    const w = await call("POST", "/api/auth/verify-email", { body: { email: "vendedor@rsc.test", code: wrongCode }, ip: "6.6.6.6" });
    assert.equal(w.status, 400);
  }
  const locked = await call("POST", "/api/auth/verify-email", { body: { email: "vendedor@rsc.test", code }, ip: "6.6.6.6" });
  assert.equal(locked.status, 429, "limite de tentativas");

  // novo código (após o intervalo) funciona e o anterior deixa de valer
  await (await db()).query("UPDATE auth_codes SET created_at = now() - interval '2 minutes' WHERE user_id = (SELECT id FROM users WHERE email = 'vendedor@rsc.test')");
  assert.equal((await call("POST", "/api/auth/resend-code", { body: { email: "vendedor@rsc.test" } })).status, 200);
  const fresh = lastCode("vendedor@rsc.test");
  const jar = {};
  const ok = await call("POST", "/api/auth/verify-email", { body: { email: "vendedor@rsc.test", code: fresh }, jar, ip: "7.7.7.7" });
  assert.equal(ok.status, 200);
  const twice = await call("POST", "/api/auth/verify-email", { body: { email: "vendedor@rsc.test", code: fresh }, ip: "7.7.7.7" });
  assert.equal(twice.status, 409, "código de uso único / e-mail já confirmado");

  // permissões: vendedor não cadastra produto nem convida
  assert.equal((await call("POST", "/api/admin/products", { jar, body: { name: "X" } })).status, 403);
  assert.equal((await call("POST", "/api/admin/invites", { jar, body: { email: "z@z.test", role: "admin" } })).status, 403);
});

test("código expirado é recusado", async () => {
  const owner = {};
  await call("POST", "/api/auth/login", { body: { email: "dono@rsc.test", password: "senha-segura-123" }, jar: owner, ip: "8.8.8.8" });
  await call("POST", "/api/admin/invites", { jar: owner, body: { email: "estoque@rsc.test", role: "estoque" } });
  const token = outbox().find(m => m.to === "estoque@rsc.test").text.match(/invite=([\w-]+)/)[1];
  await call("POST", "/api/auth/register", { body: { invite: token, name: "Estoquista", password: "senha-estoque-1" } });
  await (await db()).query("UPDATE auth_codes SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM users WHERE email = 'estoque@rsc.test')");
  const r = await call("POST", "/api/auth/verify-email", { body: { email: "estoque@rsc.test", code: lastCode("estoque@rsc.test") }, ip: "9.9.9.9" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "CODE_EXPIRED");
});

test("recuperação de senha: resposta neutra, código, troca e fim das sessões antigas", async () => {
  const unknown = await call("POST", "/api/auth/forgot-password", { body: { email: "naoexiste@rsc.test" } });
  assert.equal(unknown.status, 200, "não revela se o e-mail existe");
  const old = {};
  await call("POST", "/api/auth/login", { body: { email: "dono@rsc.test", password: "senha-segura-123" }, jar: old, ip: "10.1.1.1" });
  assert.equal((await call("POST", "/api/auth/forgot-password", { body: { email: "dono@rsc.test" } })).status, 200);
  const code = lastCode("dono@rsc.test");
  const r = await call("POST", "/api/auth/reset-password", { body: { email: "dono@rsc.test", code, password: "nova-senha-segura-9" } });
  assert.equal(r.status, 200);
  assert.equal((await call("GET", "/api/auth/me", { jar: old })).status, 401, "sessões anteriores encerradas");
  const jar = {};
  assert.equal((await call("POST", "/api/auth/login", { body: { email: "dono@rsc.test", password: "nova-senha-segura-9" }, jar, ip: "10.1.1.2" })).status, 200);
});
