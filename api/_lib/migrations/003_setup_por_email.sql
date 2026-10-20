-- Migration 003 — primeiro acesso validado por código enviado ao e-mail do dono (OWNER_EMAIL).
-- A conta do dono só é criada depois que o código é confirmado.
CREATE TABLE IF NOT EXISTS setup_codes (
  id           bigserial PRIMARY KEY,
  email        text NOT NULL,
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS setup_codes_email ON setup_codes (email, created_at DESC);
