// Envio de e-mails transacionais (códigos e convites).
// Produção: Resend (RESEND_API_KEY + EMAIL_FROM com domínio verificado no Resend).
// Desenvolvimento: sem Resend configurado, o e-mail é mostrado no terminal do servidor.
// Testes: EMAIL_TRANSPORT=memory guarda as mensagens em globalThis.__outbox.
import { fail, isProduction } from "./http.js";

export async function sendEmail({ to, subject, text }) {
  if (process.env.EMAIL_TRANSPORT === "memory") {
    (globalThis.__outbox ??= []).push({ to, subject, text });
    return;
  }
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (key && from) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!r.ok) {
      console.error("Falha no envio de e-mail (Resend):", r.status);
      fail(502, "Não foi possível enviar o e-mail agora. Tente novamente em instantes.");
    }
    return;
  }
  if (isProduction()) fail(503, "Envio de e-mail não configurado no servidor (RESEND_API_KEY / EMAIL_FROM).");
  console.log(`\n===== E-MAIL (modo desenvolvimento) =====\nPara: ${to}\nAssunto: ${subject}\n\n${text}\n=========================================\n`);
}
