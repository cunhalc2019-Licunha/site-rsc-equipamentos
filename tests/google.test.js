// "Entrar com Google": primeiro acesso sem código por e-mail e login de usuários existentes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { call } from "./helpers.js";

process.env.GOOGLE_CLIENT_ID = "cliente-rsc.apps.googleusercontent.com";
const future = () => String(Math.floor(Date.now() / 1000) + 600);
// Simula a resposta do Google para cada "token" usado nos testes.
const TOKENS = {
  dono: { aud: process.env.GOOGLE_CLIENT_ID, iss: "https://accounts.google.com", email: "dono@rsc.test", email_verified: "true", name: "Dono" },
  estranho: { aud: process.env.GOOGLE_CLIENT_ID, iss: "accounts.google.com", email: "outra@gmail.com", email_verified: "true" },
  outroApp: { aud: "outro-app.apps.googleusercontent.com", iss: "accounts.google.com", email: "dono@rsc.test", email_verified: "true" },
  naoVerificado: { aud: process.env.GOOGLE_CLIENT_ID, iss: "accounts.google.com", email: "dono@rsc.test", email_verified: "false" },
};
globalThis.__googleTokenInfo = async t => ({ ...TOKENS[t], exp: TOKENS[t] ? future() : "0" });

const setup = (googleCredential, extra = {}) => call("POST", "/api/auth/setup", { jar: extra.jar, ip: extra.ip, body: {
  googleCredential, storeName: "RSC", name: "Dono", importCatalog: false, ...extra.body } });

test("primeiro acesso com Google: só a conta do OWNER_EMAIL, emitida para o nosso app e verificada", async () => {
  const cfg = await call("GET", "/api/auth/config");
  assert.equal(cfg.body.googleClientId, process.env.GOOGLE_CLIENT_ID);

  assert.equal((await setup("estranho")).status, 403, "outra conta Google não vira dona");
  assert.equal((await setup("outroApp")).status, 401, "token de outro aplicativo é recusado");
  assert.equal((await setup("naoVerificado")).status, 403);
  assert.equal((await setup("lixo")).status, 401, "token inválido/expirado");
  assert.equal((await call("GET", "/api/auth/setup-status")).body.needsSetup, true, "nada foi criado");

  const jar = {};
  const ok = await setup("dono", { jar });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const me = await call("GET", "/api/auth/me", { jar });
  assert.equal(me.body.user.email, "dono@rsc.test");
  assert.equal(me.body.user.role, "owner");
  assert.equal((await setup("dono")).status, 409, "primeiro acesso só funciona uma vez");
});

test("login com Google: entra quem tem conta ativa; os outros são recusados", async () => {
  const jar = {};
  const r = await call("POST", "/api/auth/google", { jar, body: { credential: "dono" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call("GET", "/api/auth/me", { jar })).status, 200);

  const x = await call("POST", "/api/auth/google", { body: { credential: "estranho" } });
  assert.equal(x.status, 403);
  assert.match(x.body.error, /não tem acesso/);
  assert.equal((await call("POST", "/api/auth/google", { body: { credential: "outroApp" } })).status, 401);

  // sem senha definida no primeiro acesso, o login por senha não funciona com nenhuma senha "padrão"
  const pw = await call("POST", "/api/auth/login", { body: { email: "dono@rsc.test", password: "senha-segura-123" }, ip: "50.0.0.1" });
  assert.equal(pw.status, 401);
});
