-- Esquema do banco (PostgreSQL). Idempotente: pode rodar várias vezes.
-- Valores em CENTAVOS (integer). Todas as tabelas de negócio têm store_id (preparado para multi-loja).

CREATE TABLE IF NOT EXISTS stores (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES stores(id),
  name           text NOT NULL,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin','estoque','vendedor')),
  active         boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id          bigserial PRIMARY KEY,
  email       text,
  ip          text,
  success     boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_recent ON login_attempts (created_at);

CREATE TABLE IF NOT EXISTS categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     uuid NOT NULL REFERENCES stores(id),
  name         text NOT NULL,
  slug         text NOT NULL,
  description  text,
  cover_url    text,
  position     integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, slug)
);

CREATE SEQUENCE IF NOT EXISTS product_sku_seq START 1001;

CREATE TABLE IF NOT EXISTS products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           uuid NOT NULL REFERENCES stores(id),
  category_id        uuid REFERENCES categories(id),
  sku                text NOT NULL,
  slug               text NOT NULL,
  name               text NOT NULL,
  brand              text,
  description        text,
  specs              jsonb NOT NULL DEFAULT '[]',
  condition          text NOT NULL CHECK (condition IN ('novo','seminovo','usado_revisado')),
  stock_type         text NOT NULL CHECK (stock_type IN ('unico','quantidade')),
  price_cents        integer CHECK (price_cents IS NULL OR price_cents > 0),
  old_price_cents    integer CHECK (old_price_cents IS NULL OR old_price_cents > 0),
  discount_pix_pct   numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pix_pct BETWEEN 0 AND 90),
  discount_card_pct  numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_card_pct BETWEEN 0 AND 90),
  payment_methods    text[] NOT NULL DEFAULT '{pix,card,boleto}',
  badge              text,
  sell_online        boolean NOT NULL DEFAULT true,
  status             text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','publicado','arquivado')),
  internal_notes     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, sku),
  UNIQUE (store_id, slug)
);
CREATE INDEX IF NOT EXISTS products_store_status ON products (store_id, status);

CREATE TABLE IF NOT EXISTS product_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url         text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_images_product ON product_images (product_id, position);

-- Saldo atual. Disponível = on_hand - reserved. As CHECKs impedem estoque negativo.
CREATE TABLE IF NOT EXISTS inventory (
  product_id  uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  store_id    uuid NOT NULL REFERENCES stores(id),
  on_hand     integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved    integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved <= on_hand)
);

-- Livro-razão de estoque: nunca é alterado nem apagado.
CREATE TABLE IF NOT EXISTS stock_movements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          uuid NOT NULL REFERENCES stores(id),
  product_id        uuid NOT NULL REFERENCES products(id),
  type              text NOT NULL CHECK (type IN ('entrada','saida','ajuste')),
  quantity          integer NOT NULL CHECK (quantity <> 0),
  reason            text NOT NULL,
  unit_cost_cents   integer CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  supplier          text,
  document          text,
  note              text,
  balance_after     integer NOT NULL,
  user_id           uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'entrada' AND quantity > 0) OR (type = 'saida' AND quantity < 0) OR type = 'ajuste')
);
CREATE INDEX IF NOT EXISTS stock_movements_product ON stock_movements (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_store ON stock_movements (store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          bigserial PRIMARY KEY,
  store_id    uuid,
  user_id     uuid,
  action      text NOT NULL,
  entity      text,
  entity_id   text,
  data        jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_store ON audit_logs (store_id, created_at DESC);
