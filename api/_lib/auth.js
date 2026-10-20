// Autenticação do painel: senha com scrypt (nativo do Node), sessão em cookie HttpOnly
// (no banco fica só o hash do token), códigos de e-mail de uso único e permissões por função.
import { scrypt, randomBytes, randomInt, timingSafeEqual, createHash, createHmac } from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db.js";
import { cookies, fail, clientIp, isSecure, isProduction } from "./http.js";
import { sendEmail } from "./email.js";
import { rateLimit } from "./rate.js";

const scryptAsync = promisify(scrypt);
const COOKIE = "rsc_admin";
const SESSION_HOURS = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const CODE_TTL_MIN = 10;          // validade do código
export const CODE_MAX_ATTEMPTS = 5;      // tentativas por código
export const CODE_RESEND_SEC = 60;       // intervalo mínimo entre envios
export const CODE_MAX_PER_HOUR = 5;      // envios por hora por usuário/finalidade

// ---------- Permissões por função ----------
export const PERMISSIONS = {
  "catalog.read":        ["owner", "admin", "estoque", "vendedor"],
  "products.write":      ["owner", "admin", "estoque"],
  "products.archive":    ["owner", "admin"],
  "categories.write":    ["owner", "admin"],
  "stock.entry":         ["owner", "admin", "estoque"],
  "stock.adjust":        ["owner", "admin"],
  "sales.physical":      ["owner", "admin", "vendedor"],
  "sales.override":      ["owner", "admin"],
  "orders.read":         ["owner", "admin", "vendedor", "estoque"],
  "orders.manage":       ["owner", "admin", "vendedor"],
  "issues.resolve":      ["owner", "admin"],
  "settings.write":      ["owner", "admin"],
  "users.manage":        ["owner", "admin"],
};
export const can = (role, perm) => (PERMISSIONS[perm] || []).includes(role);

// ---------- Senhas ----------
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length, SCRYPT);
  return timingSafeEqual(key, expected);
}

export function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 10) fail(422, "A senha precisa ter pelo menos 10 caracteres.");
  if (pw.length > 200) fail(422, "Senha muito longa.");
  if (/^(.)\1+$/.test(pw) || /^(0123456789|1234567890|abcdefghij)/i.test(pw)) fail(422, "Escolha uma senha menos previsível.");
}

// ---------- Sessões ----------
const sha256 = s => createHash("sha256").update(s).digest("hex");

function setCookie(req, res, value, maxAge) {
  res.setHeader("Set-Cookie",
    `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecure(req) ? "; Secure" : ""}`);
}

export async function createSession(req, res, userId) {
  const token = randomBytes(32).toString("base64url");
  await (await db()).query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [sha256(token), userId, SESSION_HOURS, clientIp(req), String(req.headers["user-agent"] || "").slice(0, 300)]);
  setCookie(req, res, token, SESSION_HOURS * 3600);
}

export async function destroySession(req, res) {
  const token = cookies(req)[COOKIE];
  if (token) await (await db()).query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  setCookie(req, res, "", 0);
}

// Retorna o contexto { user, storeId, storeName } ou lança 401/403.
// A loja vem SEMPRE da sessão do usuário — nunca de um store_id enviado pelo navegador.
export async function requireUser(req, res, permission = null) {
  const token = cookies(req)[COOKIE];
  if (!token) fail(401, "Faça login para continuar.");
  const q = await db();
  const [row] = await q.query(
    `SELECT u.id, u.name, u.email, u.role, u.store_id, u.email_verified_at, s.name AS store_name, se.expires_at
       FROM sessions se JOIN users u ON u.id = se.user_id JOIN stores s ON s.id = u.store_id
      WHERE se.token_hash = $1 AND se.expires_at > now() AND u.active`, [sha256(token)]);
  if (!row) { setCookie(req, res, "", 0); fail(401, "Sessão expirada. Faça login novamente."); }
  if (!row.email_verified_at) fail(403, "Confirme seu e-mail para continuar.", { code: "EMAIL_NOT_VERIFIED" });
  if (permission && !can(row.role, permission)) fail(403, "Você não tem permissão para esta ação.");
  if (new Date(row.expires_at) - Date.now() < SESSION_HOURS * 1800 * 1000) {
    await q.query("UPDATE sessions SET expires_at = now() + make_interval(hours => $2) WHERE token_hash = $1", [sha256(token), SESSION_HOURS]);
    setCookie(req, res, token, SESSION_HOURS * 3600);
  }
  return { user: { id: row.id, name: row.name, email: row.email, role: row.role }, storeId: row.store_id, storeName: row.store_name };
}

// Tentativas de login: 5 falhas em 15 minutos por e-mail ou por IP.
export async function assertNotLocked(email, ip) {
  const [{ n }] = await (await db()).query(
    `SELECT count(*)::int AS n FROM login_attempts
      WHERE NOT success AND created_at > now() - interval '15 minutes' AND (email = $1 OR ip = $2)`, [email, ip]);
  if (n >= 5) fail(429, "Muitas tentativas. Aguarde 15 minutos e tente novamente.");
}

// ---------- Códigos por e-mail (verificação e recuperação de senha) ----------
function codeSecret() {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 16) return s;
  if (isProduction()) fail(503, "AUTH_SECRET não configurado no servidor.");
  return "dev-only-auth-secret-nao-usar-em-producao";
}
const codeHash = (purpose, userId, code) => createHmac("sha256", codeSecret()).update(`${purpose}:${userId}:${code}`).digest("hex");

const SUBJECT = { verify_email: "Seu código de verificação — RSC Equipamentos", reset_password: "Código para redefinir sua senha — RSC Equipamentos" };
const INTRO = { verify_email: "Use o código abaixo para confirmar seu e-mail no painel da RSC Equipamentos.", reset_password: "Use o código abaixo para redefinir sua senha do painel da RSC Equipamentos." };

// Gera e envia um novo código. Respeita intervalo de reenvio e limite por hora.
// Códigos anteriores ainda não usados deixam de valer.
export async function issueCode(user, purpose, req) {
  const q = await db();
  const [last] = await q.query(
    "SELECT created_at FROM auth_codes WHERE user_id = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1", [user.id, purpose]);
  if (last && Date.now() - new Date(last.created_at) < CODE_RESEND_SEC * 1000)
    fail(429, `Aguarde ${CODE_RESEND_SEC} segundos para pedir um novo código.`, { code: "RESEND_COOLDOWN" });
  const [{ n }] = await q.query(
    "SELECT count(*)::int AS n FROM auth_codes WHERE user_id = $1 AND purpose = $2 AND created_at > now() - interval '1 hour'", [user.id, purpose]);
  if (n >= CODE_MAX_PER_HOUR) fail(429, "Limite de códigos atingido. Tente novamente em 1 hora.");
  if (req) await rateLimit(`code-ip:${clientIp(req)}`, 20, 3600);

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await q.query("UPDATE auth_codes SET consumed_at = now() WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL", [user.id, purpose]);
  await q.query(
    "INSERT INTO auth_codes (user_id, purpose, code_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))",
    [user.id, purpose, codeHash(purpose, user.id, code), CODE_TTL_MIN]);
  await sendEmail({
    to: user.email, subject: SUBJECT[purpose],
    text: `${INTRO[purpose]}\n\nCódigo: ${code}\n\nEle vale por ${CODE_TTL_MIN} minutos e só pode ser usado uma vez.\nSe você não pediu este código, ignore este e-mail.`,
  });
}

// Confere o código: uso único, com validade e limite de tentativas.
export async function consumeCode(userId, purpose, code) {
  if (!/^\d{6}$/.test(String(code || ""))) fail(422, "Informe o código de 6 dígitos.");
  // A transação devolve o resultado (em vez de lançar o erro lá dentro) para que o
  // incremento de tentativas seja gravado mesmo quando o código está errado.
  const r = await (await db()).tx(async t => {
    const [c] = await t.query(
      `SELECT id, code_hash, expires_at, attempts FROM auth_codes
        WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [userId, purpose]);
    if (!c) return [400, "Nenhum código válido. Peça um novo código.", "NO_CODE"];
    if (new Date(c.expires_at) < new Date()) return [400, "Código expirado. Peça um novo código.", "CODE_EXPIRED"];
    if (c.attempts >= CODE_MAX_ATTEMPTS) return [429, "Limite de tentativas atingido. Peça um novo código.", "CODE_LOCKED"];
    const ok = timingSafeEqual(Buffer.from(c.code_hash), Buffer.from(codeHash(purpose, userId, String(code))));
    if (!ok) {
      await t.query("UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1", [c.id]);
      const left = CODE_MAX_ATTEMPTS - c.attempts - 1;
      return [400, left > 0 ? `Código incorreto. Restam ${left} tentativa(s).` : "Código incorreto. Limite atingido — peça um novo código.", "CODE_INVALID"];
    }
    await t.query("UPDATE auth_codes SET consumed_at = now() WHERE id = $1", [c.id]);
    return null;
  });
  if (r) fail(r[0], r[1], { code: r[2] });
  return true;
}

// ---------- Primeiro acesso por e-mail (antes de existir qualquer usuário) ----------
// Só o e-mail definido em OWNER_EMAIL pode receber o código; a conta é criada após a confirmação.
export const ownerEmail = () => String(process.env.OWNER_EMAIL || "").trim().toLowerCase();

export async function issueSetupCode(email, req) {
  const q = await db();
  if (req) await rateLimit(`setup-code-ip:${clientIp(req)}`, 10, 3600);
  const [last] = await q.query("SELECT created_at FROM setup_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1", [email]);
  if (last && Date.now() - new Date(last.created_at) < CODE_RESEND_SEC * 1000)
    fail(429, `Aguarde ${CODE_RESEND_SEC} segundos para pedir um novo código.`, { code: "RESEND_COOLDOWN" });
  const [{ n }] = await q.query("SELECT count(*)::int AS n FROM setup_codes WHERE email = $1 AND created_at > now() - interval '1 hour'", [email]);
  if (n >= CODE_MAX_PER_HOUR) fail(429, "Limite de códigos atingido. Tente novamente em 1 hora.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await q.query("UPDATE setup_codes SET consumed_at = now() WHERE email = $1 AND consumed_at IS NULL", [email]);
  await q.query("INSERT INTO setup_codes (email, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))",
    [email, codeHash("setup", email, code), CODE_TTL_MIN]);
  await sendEmail({ to: email, subject: "Código do primeiro acesso — painel RSC Equipamentos",
    text: `Use o código abaixo para criar a conta de proprietário do painel da RSC Equipamentos.\n\nCódigo: ${code}\n\nEle vale por ${CODE_TTL_MIN} minutos e só pode ser usado uma vez.\nSe você não pediu este código, ignore este e-mail.` });
}

// Confere o código dentro da transação do primeiro acesso (t). Devolve null se ok ou [status, msg, code].
export async function checkSetupCode(t, email, code) {
  if (!/^\d{6}$/.test(String(code || ""))) return [422, "Informe o código de 6 dígitos.", "CODE_FORMAT"];
  const [c] = await t.query(
    "SELECT id, code_hash, expires_at, attempts FROM setup_codes WHERE email = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [email]);
  if (!c) return [400, "Nenhum código válido. Peça um novo código.", "NO_CODE"];
  if (new Date(c.expires_at) < new Date()) return [400, "Código expirado. Peça um novo código.", "CODE_EXPIRED"];
  if (c.attempts >= CODE_MAX_ATTEMPTS) return [429, "Limite de tentativas atingido. Peça um novo código.", "CODE_LOCKED"];
  if (!timingSafeEqual(Buffer.from(c.code_hash), Buffer.from(codeHash("setup", email, String(code))))) {
    await t.query("UPDATE setup_codes SET attempts = attempts + 1 WHERE id = $1", [c.id]);
    const left = CODE_MAX_ATTEMPTS - c.attempts - 1;
    return [400, left > 0 ? `Código incorreto. Restam ${left} tentativa(s).` : "Código incorreto. Limite atingido — peça um novo código.", "CODE_INVALID"];
  }
  await t.query("UPDATE setup_codes SET consumed_at = now() WHERE id = $1", [c.id]);
  return null;
}

// ---------- Auditoria ----------
export async function audit(ctx, action, entity, entityId, data, req, t = null) {
  const q = t || await db();
  await q.query(
    "INSERT INTO audit_logs (store_id, user_id, action, entity, entity_id, data, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [ctx?.storeId || null, ctx?.user?.id || null, action, entity, entityId ? String(entityId) : null,
     data ? JSON.stringify(data) : null, req ? clientIp(req) : null]);
}

export { sha256 };
