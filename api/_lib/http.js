// Utilidades HTTP compartilhadas pelas rotas da API.

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

export function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
}

export function body(req) {
  const b = req.body;
  if (b == null || b === "") return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch { fail(400, "JSON inválido"); } }
  if (Buffer.isBuffer(b)) { try { return JSON.parse(b.toString("utf8")); } catch { fail(400, "JSON inválido"); } }
  return b;
}

export function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map(c => c.trim()).filter(Boolean)
    .map(c => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
}

export const isProduction = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
export const isSecure = req => String(req.headers["x-forwarded-proto"] || "").includes("https") || process.env.VERCEL === "1";

export function origin(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${isSecure(req) ? "https" : "http"}://${host}`;
}

// Bloqueia requisições de outros sites (CSRF) em métodos que alteram dados.
export function checkOrigin(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const o = req.headers.origin;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  let ok = false;
  try { ok = !!o && new URL(o).host === host; } catch {}
  if (!ok) fail(403, "Origem não permitida");
}

// Converte erros do Postgres em mensagens úteis, sem vazar detalhes internos.
export function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err?.code === "23505") {
    const msg = /sku/.test(err.constraint || err.detail || "") ? "Já existe um produto com este SKU nesta loja."
      : "Já existe um registro com esses dados.";
    return new HttpError(409, msg);
  }
  if (err?.code === "23514") return new HttpError(422, "Operação recusada pelas regras de integridade (estoque, reserva ou preço inválidos).");
  if (err?.code === "40P01" || err?.code === "40001") return new HttpError(409, "Operação concorrente detectada. Tente novamente.");
  return new HttpError(500, "Erro interno");
}
