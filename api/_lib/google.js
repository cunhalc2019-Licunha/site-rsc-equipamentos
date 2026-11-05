// "Entrar com Google": confere no Google o token (ID token) que o botão devolve ao navegador.
// Só é aceito se foi emitido para o NOSSO GOOGLE_CLIENT_ID, não expirou e o e-mail é verificado pelo Google.
import { fail } from "./http.js";

export const googleClientId = () => (process.env.GOOGLE_CLIENT_ID || "").trim();

export async function verifyGoogleCredential(credential) {
  const clientId = googleClientId();
  if (!clientId) fail(503, "Login com Google não configurado no servidor (GOOGLE_CLIENT_ID).");
  const token = String(credential || "");
  if (!token || token.length > 4096) fail(422, "Login com Google inválido. Tente novamente.");

  let info;
  if (process.env.NODE_ENV === "test" && globalThis.__googleTokenInfo) info = await globalThis.__googleTokenInfo(token);
  else {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`).catch(() => null);
    if (!r) fail(502, "Não foi possível falar com o Google agora. Tente novamente.");
    if (!r.ok) fail(401, "Login com Google inválido ou expirado. Tente novamente.");
    info = await r.json();
  }
  const okIss = info.iss === "accounts.google.com" || info.iss === "https://accounts.google.com";
  if (info.aud !== clientId || !okIss || Number(info.exp) * 1000 < Date.now())
    fail(401, "Login com Google inválido ou expirado. Tente novamente.");
  if (String(info.email_verified) !== "true") fail(403, "Este e-mail do Google não está verificado.");
  return { email: String(info.email).toLowerCase(), name: info.name || "" };
}
