// Única função serverless da API (o plano gratuito da Vercel limita o número de funções).
// O vercel.json reescreve /api/* para cá; as rotas ficam em api/_routes/*.js.
import { checkOrigin, toHttpError } from "./_lib/http.js";
import authRoutes from "./_routes/auth.js";
import publicRoutes from "./_routes/public.js";
import adminRoutes from "./_routes/admin.js";

const ROUTES = [...authRoutes, ...publicRoutes, ...adminRoutes].map(([method, pattern, handler, opts = {}]) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  return { method, re, keys, handler, opts };
});

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    const url = new URL(req.url, "http://x");
    const raw = req.query?.__path ?? url.searchParams.get("__path") ?? url.pathname.replace(/^\/api\/?/, "");
    const path = "/" + String(Array.isArray(raw) ? raw.join("/") : raw).replace(/^\/+|\/+$/g, "");
    const query = Object.fromEntries([...url.searchParams].filter(([k]) => k !== "__path"));

    const matches = ROUTES.filter(r => r.re.test(path));
    if (!matches.length) return res.status(404).json({ error: "Rota não encontrada" });
    const route = matches.find(r => r.method === req.method);
    if (!route) return res.status(405).json({ error: "Método não permitido" });

    if (!route.opts.skipOrigin) checkOrigin(req);
    const m = path.match(route.re);
    req.params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    req.query = query;
    const out = await route.handler(req, res);
    if (!res.writableEnded) res.status(200).json(out ?? { ok: true });
  } catch (err) {
    const e = toHttpError(err);
    if (e.status >= 500) console.error("[api]", err?.message || err);
    if (!res.writableEnded) res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
  }
}
