-- Etapa 3: link de pagamento do Mercado Pago guardado no pedido (para o cliente voltar e pagar depois).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_url text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_pref_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_checked_at timestamptz;
