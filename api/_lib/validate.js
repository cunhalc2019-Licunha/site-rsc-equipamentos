// Validação de entrada. Tudo que vem do navegador passa por aqui antes de chegar ao banco.
import { fail } from "./http.js";

export function text(v, label, { required = false, max = 200 } = {}) {
  if (v == null || String(v).trim() === "") {
    if (required) fail(422, `Preencha o campo "${label}".`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > max) fail(422, `"${label}" pode ter no máximo ${max} caracteres.`);
  return s;
}

export function int(v, label, { required = false, min = -Infinity, max = Infinity } = {}) {
  if (v == null || v === "") {
    if (required) fail(422, `Preencha o campo "${label}".`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(422, `"${label}" inválido.`);
  return n;
}

export function num(v, label, { min = 0, max = 100 } = {}) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(422, `"${label}" deve estar entre ${min} e ${max}.`);
  return Math.round(n * 100) / 100;
}

export function oneOf(v, label, options, { required = true } = {}) {
  if ((v == null || v === "") && !required) return null;
  if (!options.includes(v)) fail(422, `"${label}" inválido.`);
  return v;
}

export function bool(v) { return v === true || v === "true" || v === 1 || v === "1"; }

export function uuid(v, label, { required = true } = {}) {
  if ((v == null || v === "") && !required) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v))) fail(422, `"${label}" inválido.`);
  return String(v);
}

export function email(v) {
  const s = text(v, "E-mail", { required: true, max: 160 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(422, "E-mail inválido.");
  return s;
}

export function slugify(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";
}
