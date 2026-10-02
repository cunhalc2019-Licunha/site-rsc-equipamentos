// POST /api/admin/upload  { data: "<base64>" }  → { url }
// A foto já chega redimensionada pelo navegador (máx. 1600px). Aqui o tipo é conferido pelo CONTEÚDO do arquivo.
// Produção: Vercel Blob (BLOB_READ_WRITE_TOKEN). Desenvolvimento local: pasta /uploads.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { route, body, fail } from "../_lib/http.js";
import { requireUser, audit } from "../_lib/auth.js";

const MAX_BYTES = 3 * 1024 * 1024;

function detectType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", type: "image/png" };
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return { ext: "webp", type: "image/webp" };
  return null;
}

export default route({
  async POST(req, res) {
    const ctx = await requireUser(req, res, ["owner", "admin", "estoque"]);
    const b64 = String(body(req).data || "");
    if (!b64) fail(422, "Nenhuma imagem enviada.");
    const buf = Buffer.from(b64, "base64");
    if (buf.length > MAX_BYTES) fail(413, "Imagem muito grande (máx. 3 MB).");
    const kind = detectType(buf);
    if (!kind) fail(415, "Formato não suportado. Envie JPG, PNG ou WEBP.");

    const name = `produtos/${randomUUID()}.${kind.ext}`;
    let url;
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const { put } = await import("@vercel/blob");
      url = (await put(name, buf, { access: "public", contentType: kind.type, addRandomSuffix: false })).url;
    } else if (process.env.VERCEL) {
      fail(503, "Armazenamento de imagens não configurado (BLOB_READ_WRITE_TOKEN).");
    } else {
      const file = path.join(process.cwd(), "uploads", name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, buf);
      url = `/uploads/${name}`;
    }
    await audit(ctx, "image.upload", "image", null, { url, bytes: buf.length }, req);
    return { url };
  },
});
