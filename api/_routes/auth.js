// Rotas de autenticação: primeiro acesso, login, verificação de e-mail, convites, recuperação de senha.
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { db } from "../_lib/db.js";
import { body, fail, clientIp, origin } from "../_lib/http.js";
import {
  hashPassword, verifyPassword, validatePassword, createSession, destroySession, requireUser,
  assertNotLocked, issueCode, consumeCode, audit, sha256, can, PERMISSIONS,
} from "../_lib/auth.js";
import { rateLimit } from "../_lib/rate.js";
import { text, email as parseEmail, slugify } from "../_lib/validate.js";
import { createProduct } from "../_lib/products.js";
import { sendEmail } from "../_lib/email.js";
import { ENTRY_ORIGINS, ADJUST_REASONS } from "../_lib/stock.js";
import { settingsOf, getStore } from "../_lib/store.js";

const sameSecret = (a, b) => {
  const h = s => createHash("sha256").update(String(s)).digest();
  return timingSafeEqual(h(a), h(b));
};
// Resposta igual tenha ou não o e-mail cadastrado (não revela contas existentes).
const DUMMY = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");
const userByEmail = async email => (await (await db()).query(
  "SELECT id, store_id, name, email, password_hash, active, email_verified_at FROM users WHERE email = $1 ORDER BY created_at LIMIT 1", [email]))[0];

async function importCatalog(t, ctx) {
  const data = JSON.parse(readFileSync(path.join(process.cwd(), "data", "products.json"), "utf8"));
  const catIds = {};
  for (const [i, s] of data.sectors.entries()) {
    const [c] = await t.query(
      "INSERT INTO categories (store_id, name, slug, description, cover_url, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [ctx.storeId, s.name, s.slug, s.desc, "/" + s.cover, i]);
    catIds[s.slug] = c.id;
  }
  for (const p of data.products) {
    const condition = /semi/i.test(p.condition) ? "seminovo" : /usad/i.test(p.condition) ? "usado_revisado" : "novo";
    const regular = p.oldPrice || p.price;
    await createProduct(t, ctx, {
      name: p.name, brand: p.brand, categoryId: catIds[p.sector], sku: null, condition,
      stockType: (p.stock || 1) > 1 ? "quantidade" : "unico",
      priceCents: regular ? Math.round(regular * 100) : null,
      promoPriceCents: p.oldPrice && p.price ? Math.round(p.price * 100) : null,
      discountPixPct: p.discounts?.pix || 0, discountCardPct: p.discounts?.card || 0,
      paymentMethods: p.methods || ["pix", "card", "boleto"], badge: p.badge || null,
      description: p.note ? `${p.desc}\n\n${p.note}` : p.desc, internalNotes: null,
      sellOnline: p.online !== false, state: "ativo", published: true,
      specs: Object.entries(p.specs || {}).map(([k, v]) => ({ k, v })),
      images: p.images.map(u => "/" + u),
    }, { quantity: p.stock || 1, origin: "estoque_inicial", note: "Importado do catálogo inicial" });
  }
}

export default [
  ["GET", "/auth/setup-status", async () => {
    const [{ n }] = await (await db()).query("SELECT count(*)::int AS n FROM users");
    return { needsSetup: n === 0 };
  }],

  // Primeiro acesso: só funciona sem nenhum usuário e com o código ADMIN_SETUP_TOKEN do servidor.
  ["POST", "/auth/setup", async req => {
    const b = body(req);
    await rateLimit(`setup:${clientIp(req)}`, 10, 3600);
    const expected = process.env.ADMIN_SETUP_TOKEN;
    if (!expected) fail(503, "Configure a variável ADMIN_SETUP_TOKEN no servidor antes do primeiro acesso.");
    if (!sameSecret(b.setupToken || "", expected)) fail(403, "Código de configuração incorreto.");
    const storeName = text(b.storeName, "Nome da loja", { required: true, max: 80 });
    const name = text(b.name, "Seu nome", { required: true, max: 80 });
    const mail = parseEmail(b.email);
    validatePassword(b.password);
    const passwordHash = await hashPassword(b.password);

    const ctx = await (await db()).tx(async t => {
      await t.query("LOCK TABLE users IN EXCLUSIVE MODE");
      const [{ n }] = await t.query("SELECT count(*)::int AS n FROM users");
      if (n > 0) fail(409, "O painel já foi configurado. Faça login.");
      const [store] = await t.query("INSERT INTO stores (name, slug) VALUES ($1, $2) RETURNING id", [storeName, slugify(storeName)]);
      const [user] = await t.query(
        "INSERT INTO users (store_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'owner') RETURNING id",
        [store.id, name, mail, passwordHash]);
      const c = { storeId: store.id, user: { id: user.id } };
      if (b.importCatalog) await importCatalog(t, c);
      else await t.query("INSERT INTO categories (store_id, name, slug, position) VALUES ($1,'Geral','geral',0)", [store.id]);
      return c;
    });
    await audit(ctx, "setup", "store", ctx.storeId, { importCatalog: !!b.importCatalog }, req);
    await issueCode({ id: ctx.user.id, email: mail }, "verify_email", req);
    return { ok: true, next: "verify-email", email: mail };
  }],

  ["POST", "/auth/login", async (req, res) => {
    const b = body(req);
    const email = String(b.email || "").trim().toLowerCase().slice(0, 160);
    const password = String(b.password || "").slice(0, 200);
    if (!email || !password) fail(422, "Informe e-mail e senha.");
    const ip = clientIp(req);
    await assertNotLocked(email, ip);
    const user = await userByEmail(email);
    const ok = await verifyPassword(password, user?.password_hash || DUMMY) && user?.active;
    await (await db()).query("INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)", [email, ip, !!ok]);
    if (!ok) fail(401, "E-mail ou senha incorretos.");
    if (!user.email_verified_at) {
      try { await issueCode(user, "verify_email", req); } catch (e) { if (e.status !== 429) throw e; }
      fail(403, "Confirme seu e-mail para entrar. Enviamos um código.", { code: "EMAIL_NOT_VERIFIED", email });
    }
    await (await db()).query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    await createSession(req, res, user.id);
    await audit({ storeId: user.store_id, user: { id: user.id } }, "login", "user", user.id, null, req);
    return { ok: true };
  }],

  ["POST", "/auth/logout", async (req, res) => { await destroySession(req, res); return { ok: true }; }],

  ["GET", "/auth/me", async (req, res) => {
    const ctx = await requireUser(req, res);
    const store = await getStore(ctx.storeId);
    const perms = Object.keys(PERMISSIONS).filter(p => can(ctx.user.role, p));
    return { user: ctx.user, store: { name: ctx.storeName, settings: settingsOf(store) }, permissions: perms,
      entryOrigins: ENTRY_ORIGINS, adjustReasons: ADJUST_REASONS };
  }],

  // Confirma o e-mail com o código de 6 dígitos e já inicia a sessão.
  ["POST", "/auth/verify-email", async (req, res) => {
    const b = body(req);
    await rateLimit(`verify-ip:${clientIp(req)}`, 30, 900);
    const user = await userByEmail(String(b.email || "").trim().toLowerCase());
    if (!user || !user.active) fail(400, "Nenhum código válido. Peça um novo código.", { code: "NO_CODE" });
    if (user.email_verified_at) fail(409, "Este e-mail já foi confirmado. Faça login.", { code: "ALREADY_VERIFIED" });
    await consumeCode(user.id, "verify_email", String(b.code || "").trim());
    await (await db()).query("UPDATE users SET email_verified_at = now(), last_login_at = now() WHERE id = $1", [user.id]);
    await createSession(req, res, user.id);
    await audit({ storeId: user.store_id, user: { id: user.id } }, "email.verified", "user", user.id, null, req);
    return { ok: true };
  }],

  ["POST", "/auth/resend-code", async req => {
    const b = body(req);
    const purpose = b.purpose === "reset_password" ? "reset_password" : "verify_email";
    await rateLimit(`resend-ip:${clientIp(req)}`, 15, 3600);
    const user = await userByEmail(String(b.email || "").trim().toLowerCase());
    // Resposta neutra quando não há conta (ou já verificada), para não revelar e-mails cadastrados.
    if (user && user.active && (purpose === "reset_password" ? !!user.email_verified_at : !user.email_verified_at))
      await issueCode(user, purpose, req);
    return { ok: true, message: "Se houver uma conta para este e-mail, enviamos um novo código." };
  }],

  ["POST", "/auth/forgot-password", async req => {
    const b = body(req);
    await rateLimit(`forgot-ip:${clientIp(req)}`, 10, 3600);
    const user = await userByEmail(String(b.email || "").trim().toLowerCase());
    if (user && user.active && user.email_verified_at) {
      try { await issueCode(user, "reset_password", req); } catch (e) { if (e.status !== 429) throw e; }
    }
    return { ok: true, message: "Se houver uma conta para este e-mail, enviamos um código para redefinir a senha." };
  }],

  ["POST", "/auth/reset-password", async req => {
    const b = body(req);
    await rateLimit(`reset-ip:${clientIp(req)}`, 30, 900);
    validatePassword(b.password);
    const user = await userByEmail(String(b.email || "").trim().toLowerCase());
    if (!user || !user.active || !user.email_verified_at) fail(400, "Nenhum código válido. Peça um novo código.", { code: "NO_CODE" });
    await consumeCode(user.id, "reset_password", String(b.code || "").trim());
    const hash = await hashPassword(b.password);
    const q = await db();
    await q.query("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, hash]);
    await q.query("DELETE FROM sessions WHERE user_id = $1", [user.id]); // encerra todas as sessões
    await audit({ storeId: user.store_id, user: { id: user.id } }, "password.reset", "user", user.id, null, req);
    return { ok: true };
  }],

  // Convite: valida o link antes de mostrar o formulário de cadastro.
  ["GET", "/auth/invite/:token", async req => {
    const [inv] = await (await db()).query(
      `SELECT i.email, i.role, s.name AS store FROM invites i JOIN stores s ON s.id = i.store_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`, [sha256(req.params.token)]);
    if (!inv) fail(404, "Convite inválido, expirado ou já utilizado.");
    return { invite: inv };
  }],

  // Cadastro: SOMENTE com convite válido. Ninguém ganha acesso à loja apenas se cadastrando.
  ["POST", "/auth/register", async req => {
    const b = body(req);
    await rateLimit(`register-ip:${clientIp(req)}`, 10, 3600);
    if (!b.invite) fail(403, "O cadastro no painel é feito somente por convite do proprietário da loja.");
    const name = text(b.name, "Seu nome", { required: true, max: 80 });
    validatePassword(b.password);
    const hash = await hashPassword(b.password);
    const result = await (await db()).tx(async t => {
      const [inv] = await t.query(
        `SELECT * FROM invites WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
        [sha256(String(b.invite))]);
      if (!inv) fail(404, "Convite inválido, expirado ou já utilizado.");
      const [exists] = await t.query("SELECT 1 FROM users WHERE email = $1", [inv.email]);
      if (exists) fail(409, "Já existe uma conta com este e-mail. Faça login.");
      const [u] = await t.query(
        "INSERT INTO users (store_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [inv.store_id, name, inv.email, hash, inv.role]);
      await t.query("UPDATE invites SET accepted_at = now() WHERE id = $1", [inv.id]);
      return { userId: u.id, storeId: inv.store_id, email: inv.email };
    });
    await audit({ storeId: result.storeId, user: { id: result.userId } }, "user.register_invite", "user", result.userId, null, req);
    await issueCode({ id: result.userId, email: result.email }, "verify_email", req);
    return { ok: true, next: "verify-email", email: result.email };
  }],
];

// Usado pela rota de convites do painel.
export async function sendInvite(req, ctx, email, role) {
  const token = randomBytes(32).toString("base64url");
  const q = await db();
  const [exists] = await q.query("SELECT 1 FROM users WHERE email = $1", [email]);
  if (exists) fail(409, "Já existe um usuário com este e-mail.");
  await q.query("UPDATE invites SET revoked_at = now() WHERE store_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL", [ctx.storeId, email]);
  const [inv] = await q.query(
    `INSERT INTO invites (store_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + interval '7 days') RETURNING id, expires_at`, [ctx.storeId, email, role, sha256(token), ctx.user.id]);
  const link = `${origin(req)}/admin/register?invite=${token}`;
  await sendEmail({ to: email, subject: `Convite para o painel da ${ctx.storeName}`,
    text: `${ctx.user.name} convidou você para acessar o painel administrativo da ${ctx.storeName}.\n\nCrie sua senha neste link (válido por 7 dias):\n${link}\n\nSe você não esperava este convite, ignore este e-mail.` });
  return inv;
}
