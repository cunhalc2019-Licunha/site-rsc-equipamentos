// Envio de e-mails transacionais (códigos e convites).
// Opção 1 — Gmail da loja (recomendado sem domínio próprio): GMAIL_USER + GMAIL_APP_PASSWORD
//            ("senha de app" do Google). Envia para QUALQUER e-mail (dono, equipe, convites).
// Opção 2 — Resend: RESEND_API_KEY + EMAIL_FROM (sem domínio verificado, só entrega ao e-mail da conta Resend).
// Desenvolvimento: sem nenhuma configuração, o e-mail é mostrado no terminal do servidor.
// Testes: EMAIL_TRANSPORT=memory guarda as mensagens em globalThis.__outbox.
import { fail, isProduction } from "./http.js";

let gmail;
async function gmailTransport() {
  if (!gmail) {
    const { default: nodemailer } = await import("nodemailer");
    gmail = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true,
      auth: { user: process.env.GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, "") },
    });
  }
  return gmail;
}

export async function sendEmail({ to, subject, text }) {
  if (process.env.EMAIL_TRANSPORT === "memory") {
    (globalThis.__outbox ??= []).push({ to, subject, text });
    return;
  }

  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    try {
      const t = await gmailTransport();
      await t.sendMail({ from: `"RSC Equipamentos" <${process.env.GMAIL_USER}>`, to, subject, text });
    } catch (err) {
      console.error("Falha no envio de e-mail (Gmail):", err.code || err.responseCode || err.message);
      fail(502, err.code === "EAUTH"
        ? "O Gmail recusou o login de envio. Confira GMAIL_USER e a senha de app (GMAIL_APP_PASSWORD)."
        : "Não foi possível enviar o e-mail agora. Tente novamente em instantes.");
    }
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
  if (isProduction()) fail(503, "Envio de e-mail não configurado no servidor (GMAIL_USER e GMAIL_APP_PASSWORD).");
  console.log(`\n===== E-MAIL (modo desenvolvimento) =====\nPara: ${to}\nAssunto: ${subject}\n\n${text}\n=========================================\n`);
}
