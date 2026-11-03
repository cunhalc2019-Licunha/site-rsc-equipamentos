-- Migration 004 — frete com entrega própria, calculado pelo CEP no servidor.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_cents integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_info jsonb;
ALTER TABLE orders ADD CONSTRAINT orders_shipping_chk CHECK (shipping_cents >= 0);

-- Cache de CEPs consultados (evita chamar as APIs externas a cada cálculo).
CREATE TABLE IF NOT EXISTS cep_cache (
  cep         text PRIMARY KEY,
  lat         double precision,
  lng         double precision,
  city        text,
  uf          text,
  street      text,
  district    text,
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
