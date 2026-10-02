// Autenticação do painel: senha com scrypt (nativo do Node), sessão em cookie HttpOnly
// e no banco somente o hash do token.
import { scrypt, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db.js";
import { cookies, fail, clientIp } from "./http.js";

const scryptAsync = promisify(scrypt);
const COOKIE = "rsc_admin";
const SESSION_HOURS = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

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
}

const sha256 = s => createHash("sha256").update(s).digest("hex");
const isSecure = req => (req.headers["x-forwarded-proto"] || "").includes("https") || process.env.VERCEL === "1";

function setCookie(req, res, value, maxAge) {
  res.setHeader("Set-Cookie",
    `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecure(req) ? "; Secure" : ""}`);
}

export async function createSession(req, res, userId) {
  const token = randomBytes(32).toString("base64url");
  const q = await db();
  await q.query(
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

// Retorna { user, store } ou lança 401. Renova a sessão quando faltar menos da metade do tempo.
export async function requireUser(req, res, roles = null) {
  const token = cookies(req)[COOKIE];
  if (!token) fail(401, "Faça login para continuar.");
  const q = await db();
  const [row] = await q.query(
    `SELECT u.id, u.name, u.email, u.role, u.store_id, s.name AS store_name, se.expires_at
       FROM sessions se JOIN users u ON u.id = se.user_id JOIN stores s ON s.id = u.store_id
      WHERE se.token_hash = $1 AND se.expires_at > now() AND u.active`, [sha256(token)]);
  if (!row) { setCookie(req, res, "", 0); fail(401, "Sessão expirada. Faça login novamente."); }
  if (roles && !roles.includes(row.role)) fail(403, "Você não tem permissão para esta ação.");
  if (new Date(row.expires_at) - Date.now() < SESSION_HOURS * 1800 * 1000) {
    await q.query("UPDATE sessions SET expires_at = now() + make_interval(hours => $2) WHERE token_hash = $1",
      [sha256(token), SESSION_HOURS]);
    setCookie(req, res, token, SESSION_HOURS * 3600);
  }
  return { user: { id: row.id, name: row.name, email: row.email, role: row.role }, storeId: row.store_id, storeName: row.store_name };
}

// Limite de tentativas: 5 falhas em 15 minutos por e-mail ou por IP.
export async function assertNotLocked(email, ip) {
  const [{ n }] = await (await db()).query(
    `SELECT count(*)::int AS n FROM login_attempts
      WHERE NOT success AND created_at > now() - interval '15 minutes' AND (email = $1 OR ip = $2)`, [email, ip]);
  if (n >= 5) fail(429, "Muitas tentativas. Aguarde 15 minutos e tente novamente.");
}

export async function audit(ctx, action, entity, entityId, data, req) {
  await (await db()).query(
    "INSERT INTO audit_logs (store_id, user_id, action, entity, entity_id, data, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [ctx?.storeId || null, ctx?.user?.id || null, action, entity, entityId ? String(entityId) : null,
     data ? JSON.stringify(data) : null, req ? clientIp(req) : null]);
}
