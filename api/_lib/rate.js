// Limite de uso por chave (ex.: "code:email@x", "checkout:ip"). Guarda eventos no banco
// para funcionar entre várias instâncias serverless.
import { db } from "./db.js";
import { fail } from "./http.js";

export async function rateLimit(key, max, windowSec, message = "Muitas tentativas. Aguarde alguns minutos e tente novamente.") {
  const q = await db();
  const [{ n }] = await q.query(
    "SELECT count(*)::int AS n FROM rate_events WHERE key = $1 AND created_at > now() - make_interval(secs => $2)",
    [key, windowSec]);
  if (n >= max) fail(429, message);
  await q.query("INSERT INTO rate_events (key) VALUES ($1)", [key]);
  // limpeza oportunista de eventos antigos
  if (Math.random() < 0.02) await q.query("DELETE FROM rate_events WHERE created_at < now() - interval '2 days'");
}
