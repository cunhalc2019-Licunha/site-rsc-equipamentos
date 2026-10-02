import { db } from "../_lib/db.js";
import { route, body, fail, clientIp } from "../_lib/http.js";
import { verifyPassword, createSession, assertNotLocked, audit } from "../_lib/auth.js";

// Hash fixo usado quando o e-mail não existe, para o tempo de resposta ser igual (não revela quais e-mails existem).
const DUMMY = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

export default route({
  async POST(req, res) {
    const b = body(req);
    const email = String(b.email || "").trim().toLowerCase().slice(0, 160);
    const password = String(b.password || "").slice(0, 200);
    if (!email || !password) fail(422, "Informe e-mail e senha.");
    const ip = clientIp(req);
    await assertNotLocked(email, ip);

    const q = await db();
    const [user] = await q.query("SELECT id, store_id, password_hash, active FROM users WHERE email = $1", [email]);
    const ok = await verifyPassword(password, user?.password_hash || DUMMY) && user?.active;
    await q.query("INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)", [email, ip, !!ok]);
    if (!ok) fail(401, "E-mail ou senha incorretos.");

    await q.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    await createSession(req, res, user.id);
    await audit({ storeId: user.store_id, user: { id: user.id } }, "login", "user", user.id, null, req);
    return { ok: true };
  },
});
