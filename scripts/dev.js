// Servidor local de desenvolvimento: serve o site e executa as funções de /api como a Vercel faria.
// Uso: npm run dev  →  http://localhost:3000  (painel: http://localhost:3000/admin/)
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 3000;

// Carrega variáveis do arquivo .env (não vai para o GitHub)
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function helpers(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); return res; };
  res.send = data => { res.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data)); return res; };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] || "").includes("application/json") && raw) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let p = decodeURIComponent(url.pathname);
  try {
    // Igual ao vercel.json: /api/* → api/router.js  e  /admin/* (sem extensão) → admin/index.html
    if (p.startsWith("/api/")) {
      helpers(res);
      url.searchParams.set("__path", p.slice(5));
      req.url = `/api/router?${url.searchParams}`;
      req.query = Object.fromEntries(url.searchParams);
      req.body = await readBody(req);
      const mod = await import(pathToFileURL(path.join(ROOT, "api", "router.js")).href);
      return await mod.default(req, res);
    }
    if (p.startsWith("/admin/") && !path.extname(p)) p = "/admin/index.html";
    if (p.startsWith("/uploads/") && process.env.UPLOAD_DIR) {
      const file = path.join(process.env.UPLOAD_DIR, p.slice("/uploads/".length));
      const s = await stat(file).catch(() => null);
      if (s?.isFile()) { res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] || "application/octet-stream"); return res.end(await readFile(file)); }
    }
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || /[\\/](\.|node_modules|api|scripts)/.test(file.slice(ROOT.length))) { res.statusCode = 404; return res.end("Not found"); }
    const s = await stat(file).catch(() => null);
    if (!s?.isFile()) { res.statusCode = 404; return res.end("Not found"); }
    res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
    res.end(await readFile(file));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) { res.statusCode = 500; res.end("Erro interno"); }
  }
}).listen(PORT, () => console.log(`RSC rodando em http://localhost:${PORT}  (painel: /admin/)`));
