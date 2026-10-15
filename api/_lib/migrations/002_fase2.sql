-- Migration 002 — fase 2: verificação de e-mail, convites, estados do produto, reservas,
-- pedidos, pagamentos (estrutura), ocorrências e histórico de estoque detalhado.

-- ---------- Lojas e usuários ----------
ALTER TABLE stores ADD COLUMN IF NOT EXISTS domain text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS stores_domain_uq ON stores (domain) WHERE domain IS NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- Códigos temporários de uso único (verificação de e-mail e recuperação de senha). Só o hash é guardado.
CREATE TABLE IF NOT EXISTS auth_codes (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_codes_user ON auth_codes (user_id, purpose, created_at DESC);

-- Convites: único caminho para um novo usuário entrar numa loja (além do dono, criado no setup).
CREATE TABLE IF NOT EXISTS invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     uuid NOT NULL REFERENCES stores(id),
  email        text NOT NULL,
  role         text NOT NULL CHECK (role IN ('admin','estoque','vendedor')),
  token_hash   text NOT NULL UNIQUE,
  invited_by   uuid REFERENCES users(id),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_store ON invites (store_id, created_at DESC);

-- Limite genérico de abuso (envio de códigos, tentativas, checkout).
CREATE TABLE IF NOT EXISTS rate_events (
  id          bigserial PRIMARY KEY,
  key         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_events_key ON rate_events (key, created_at);

-- ---------- Produtos: estado (ativo/inativo/arquivado) separado da publicação ----------
ALTER TABLE products ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ativo';
ALTER TABLE products ADD COLUMN IF NOT EXISTS published boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS promo_price_cents integer;

-- Converte o modelo antigo: status (rascunho/publicado/arquivado) e preço "De" (old_price).
UPDATE products SET
  state = CASE WHEN status = 'arquivado' THEN 'arquivado' ELSE 'ativo' END,
  published = (status = 'publicado');
UPDATE products SET promo_price_cents = price_cents, price_cents = old_price_cents WHERE old_price_cents IS NOT NULL;
ALTER TABLE products DROP COLUMN IF EXISTS status;
ALTER TABLE products DROP COLUMN IF EXISTS old_price_cents;

ALTER TABLE products ADD CONSTRAINT products_state_chk CHECK (state IN ('ativo','inativo','arquivado'));
ALTER TABLE products ADD CONSTRAINT products_promo_chk CHECK (
  promo_price_cents IS NULL OR (promo_price_cents > 0 AND (price_cents IS NULL OR promo_price_cents < price_cents)));
ALTER TABLE products ADD CONSTRAINT products_published_chk CHECK (NOT published OR state = 'ativo');
CREATE INDEX IF NOT EXISTS products_store_state ON products (store_id, state, published);

-- ---------- Estoque: físico, reservado e vendido ----------
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS sold integer NOT NULL DEFAULT 0;
ALTER TABLE inventory ADD CONSTRAINT inventory_sold_chk CHECK (sold >= 0);

-- ---------- Clientes, pedidos, reservas, pagamentos ----------
CREATE TABLE IF NOT EXISTS customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores(id),
  name        text NOT NULL,
  email       text,
  phone       text,
  document    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_store_email ON customers (store_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS store_counters (
  store_id  uuid NOT NULL REFERENCES stores(id),
  name      text NOT NULL,
  value     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, name)
);

CREATE TABLE IF NOT EXISTS orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES stores(id),
  number           integer NOT NULL,
  channel          text NOT NULL CHECK (channel IN ('online','loja')),
  customer_id      uuid REFERENCES customers(id),
  status           text NOT NULL CHECK (status IN ('aguardando_pagamento','pago','em_processamento','concluido','cancelado','expirado','estornado')),
  payment_status   text NOT NULL CHECK (payment_status IN ('pendente','aprovado','recusado','cancelado','estornado','desconhecido')),
  payment_method   text,
  delivery         text,
  address          jsonb,
  subtotal_cents   integer NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents   integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents      integer NOT NULL CHECK (total_cents >= 0),
  reserved_until   timestamptz,
  public_token     text NOT NULL UNIQUE,
  note             text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, number)
);
CREATE INDEX IF NOT EXISTS orders_store_status ON orders (store_id, status, created_at DESC);

-- Cópia dos dados comerciais no momento da compra (não muda se o produto for editado depois).
CREATE TABLE IF NOT EXISTS order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id),
  sku               text NOT NULL,
  name              text NOT NULL,
  condition         text,
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity          integer NOT NULL CHECK (quantity > 0),
  total_cents       integer NOT NULL CHECK (total_cents >= 0)
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items (order_id);

CREATE TABLE IF NOT EXISTS reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES stores(id),
  order_id        uuid NOT NULL REFERENCES orders(id),
  order_item_id   uuid NOT NULL REFERENCES order_items(id),
  product_id      uuid NOT NULL REFERENCES products(id),
  quantity        integer NOT NULL CHECK (quantity > 0),
  status          text NOT NULL CHECK (status IN ('ativa','convertida','expirada','cancelada')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  release_reason  text
);
CREATE INDEX IF NOT EXISTS reservations_active ON reservations (store_id, expires_at) WHERE status = 'ativa';
CREATE INDEX IF NOT EXISTS reservations_product ON reservations (product_id, status);

-- Estrutura para a etapa 3 (Mercado Pago). Nenhuma confirmação é criada pelo painel.
CREATE TABLE IF NOT EXISTS payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES stores(id),
  order_id      uuid NOT NULL REFERENCES orders(id),
  provider      text NOT NULL,
  external_id   text,
  status        text NOT NULL CHECK (status IN ('pendente','aprovado','recusado','cancelado','estornado','desconhecido')),
  method        text,
  amount_cents  integer,
  raw           jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);
CREATE INDEX IF NOT EXISTS payments_order ON payments (order_id);

-- Eventos recebidos do provedor (idempotência: o mesmo evento nunca é processado duas vezes).
CREATE TABLE IF NOT EXISTS payment_events (
  id            bigserial PRIMARY KEY,
  provider      text NOT NULL,
  event_id      text NOT NULL,
  payload       jsonb,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  error         text,
  UNIQUE (provider, event_id)
);

-- Situações que exigem intervenção do lojista (ex.: pagamento aprovado após a reserva expirar).
CREATE TABLE IF NOT EXISTS order_issues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     uuid NOT NULL REFERENCES stores(id),
  order_id     uuid REFERENCES orders(id),
  type         text NOT NULL,
  description  text NOT NULL,
  status       text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','resolvida')),
  resolution   text,
  resolved_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX IF NOT EXISTS order_issues_store ON order_issues (store_id, status, created_at DESC);

-- ---------- Histórico de movimentações: físico x reserva ----------
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_type_check;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_check;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_quantity_check;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS physical_delta integer NOT NULL DEFAULT 0;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reserved_delta integer NOT NULL DEFAULT 0;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS physical_before integer;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reserved_before integer;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reserved_after integer;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES orders(id);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reservation_id uuid REFERENCES reservations(id);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'painel';
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS movement_date date;
ALTER TABLE stock_movements RENAME COLUMN balance_after TO physical_after;

-- Converte registros da fase 1
UPDATE stock_movements SET
  physical_delta = quantity,
  physical_before = physical_after - quantity,
  reserved_before = 0, reserved_after = 0,
  type = CASE WHEN type = 'saida' AND reason = 'venda_loja' THEN 'venda_fisica' WHEN type = 'saida' THEN 'ajuste' ELSE type END,
  quantity = abs(quantity);

ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_type_chk CHECK (type IN
  ('entrada','venda_fisica','venda_online','reserva_criada','reserva_liberada','ajuste','cancelamento','estorno'));
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_qty_chk CHECK (quantity > 0);
CREATE INDEX IF NOT EXISTS stock_movements_order ON stock_movements (order_id);
