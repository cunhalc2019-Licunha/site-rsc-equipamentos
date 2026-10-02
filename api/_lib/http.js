// Utilidades HTTP compartilhadas pelas rotas da API.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const fail = (status, message) => { throw new HttpError(status, message); };

export function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
}

export function body(req) {
  const b = req.body;
  if (b == null || b === "") return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch { fail(400, "JSON inválido"); } }
  return b;
}

export function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map(c => c.trim()).filter(Boolean)
    .map(c => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
}

// Bloqueia requisições de outros sites (CSRF) em métodos que alteram dados.
function checkOrigin(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const origin = req.headers.origin;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!origin || new URL(origin).host !== host) fail(403, "Origem não permitida");
}

// Envolve uma rota: métodos permitidos, verificação de origem, cabeçalhos de segurança e erros padronizados.
export function route(handlers) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const h = handlers[req.method];
      if (!h) fail(405, "Método não permitido");
      checkOrigin(req);
      const out = await h(req, res);
      if (!res.writableEnded) res.status(200).json(out ?? { ok: true });
    } catch (err) {
      const status = err.status || (err.code === "23505" ? 409 : err.code === "23514" ? 422 : 500);
      if (status === 500) console.error(err);
      const message = err.status ? err.message
        : err.code === "23505" ? "Já existe um registro com esses dados (SKU ou nome repetido)."
        : err.code === "23514" ? "Operação recusada: o estoque não pode ficar negativo nem abaixo do reservado."
        : "Erro interno";
      if (!res.writableEnded) res.status(status).json({ error: message });
    }
  };
}
