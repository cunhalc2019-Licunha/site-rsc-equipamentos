# Arquitetura — Loja RSC Equipamentos (fase 2)

## 1. Visão geral

```
Navegador ── site (index.html + js/app.js)          ── painel (/admin/*, admin/admin.js)
      │  HTTPS / JSON (cookie de sessão só no painel)
      ▼
API: UMA função serverless  api/router.js   (vercel.json reescreve /api/* para ela)
      ├─ api/_routes/public.js   catálogo, pedidos com reserva, acompanhamento, cron, webhook (reservado)
      ├─ api/_routes/auth.js     primeiro acesso, login, código por e-mail, convites, recuperação de senha
      └─ api/_routes/admin.js    painel (exige sessão + e-mail confirmado + permissão)
      ▼
Regras (api/_lib):  auth · stock (serviço central de estoque) · orders (reservas/expiração/venda física)
                    payments (estrutura p/ Mercado Pago) · products · store · rate · email · validate
      ▼
PostgreSQL  ← fonte de verdade (migrations versionadas em api/_lib/migrations)
Vercel Blob ← fotos dos produtos        Resend ← e-mails (códigos e convites)
```

**Por que esta stack:** o projeto já rodava em Vercel com funções Node.js e PostgreSQL (Neon) na fase 1. Mantê-la evita
reescrever o que já estava testado. A autenticação é própria (sem dependências): senha com scrypt, sessão em cookie
`HttpOnly; SameSite=Strict`, códigos por e-mail com HMAC. Supabase seria aceitável, mas exigiria reescrever autenticação e
acesso a dados. **Uma única função** é usada porque o plano gratuito da Vercel limita o número de funções por deploy.

O navegador **nunca** define preço, total, estoque, status de pagamento, loja ou permissões: envia só ids e quantidades.

## 2. Banco de dados

Migrations: `001_base.sql` (fase 1) e `002_fase2.sql`. Aplicadas automaticamente no primeiro acesso ao banco, em ordem,
dentro de transação com `pg_advisory_xact_lock` (duas instâncias não aplicam a mesma migration). Tabela `schema_migrations`.

| Tabela | Conteúdo |
|---|---|
| `stores` | loja (`domain`, `settings`: prazo da reserva, estoque baixo, WhatsApp) |
| `users` | usuários por loja, `role` (owner/admin/estoque/vendedor), `email_verified_at`, `active` |
| `sessions` | hash SHA-256 do token de sessão, expiração (8h, renovada com uso) |
| `auth_codes` | códigos de 6 dígitos (HMAC), finalidade, validade (10 min), tentativas (máx. 5), uso único |
| `invites` | convites por e-mail (hash do token, função, 7 dias, uso único) |
| `login_attempts`, `rate_events` | limitação de abuso (login, códigos, checkout) |
| `categories` | setores do site |
| `products` | ficha; `state` (ativo/inativo/arquivado) + `published` (separados); `price_cents` + `promo_price_cents`; SKU único por loja |
| `product_images` | URLs e ordem (a 1ª é a principal) — arquivos ficam no Blob, não no banco |
| `inventory` | **físico** (`on_hand`), **reservado** (`reserved`), **vendido** (`sold`). Disponível = físico − reservado. CHECKs: ≥0 e reservado ≤ físico |
| `stock_movements` | livro-razão imutável: tipo, quantidade, Δ físico, Δ reservado, antes/depois, usuário, pedido, reserva, origem, observação |
| `customers` | clientes do site |
| `orders` | pedido (`channel` online/loja), `status` do pedido ≠ `payment_status`, totais, `reserved_until`, `public_token` |
| `order_items` | **cópia** de SKU, nome, condição e preço no momento da compra |
| `reservations` | reserva por item: ativa/convertida/expirada/cancelada, `expires_at`, `released_at`, `release_reason` |
| `payments`, `payment_events` | estrutura para a etapa 3 (único por provedor+id externo / por evento → idempotência) |
| `order_issues` | ocorrências que exigem intervenção (ex.: pagamento após expiração sem estoque) |
| `audit_logs` | auditoria: login, produtos (preço/estado), estoque, vendas, exceções, usuários, configurações |
| `store_counters` | numeração sequencial de pedidos por loja |

Todas as tabelas de negócio têm `store_id`. Nas rotas do painel a loja vem **da sessão**; nas públicas, do domínio
(`stores.domain`) ou da única loja existente.

## 3. Estados (independentes)

- **Produto:** `ativo` | `inativo` | `arquivado` — e, à parte, `published` (sim/não).
- **Reserva:** `ativa` | `convertida` | `expirada` | `cancelada`.
- **Pedido:** `aguardando_pagamento` | `pago` | `em_processamento` | `concluido` | `cancelado` | `expirado` | `estornado`.
- **Pagamento:** `pendente` | `aprovado` | `recusado` | `cancelado` | `estornado` | `desconhecido`.

Um produto aparece **à venda** no site somente se: ativo + publicado + com foto + disponível > 0 (+ "permitir compra online" para o botão Comprar).

## 4. Transições de estoque (api/_lib/stock.js)

| Evento | Físico | Reservado | Vendido | Movimento |
|---|---|---|---|---|
| Entrada de mercadoria | +q | 0 | 0 | `entrada` |
| Venda física | −q | 0 | +q | `venda_fisica` (só usa o **disponível**) |
| Pedido online criado | 0 | +q | 0 | `reserva_criada` |
| Reserva expirada/cancelada | 0 | −q | 0 | `reserva_liberada` |
| Pagamento aprovado (reserva ativa) | −q | −q | +q | `venda_online` — a baixa acontece **uma vez** |
| Pagamento tardio sem reserva, com disponível | −q | 0 | +q | `venda_online` + ocorrência |
| Pagamento tardio sem disponível | 0 | 0 | 0 | nenhuma venda; ocorrência p/ reembolso |
| Ajuste (motivo + justificativa) | ±q | 0 | 0 | `ajuste` |
| Estorno antes da entrega | +q | 0 | −q | `estorno` |

Exemplo: físico 5, reservado 2 → disponível 3. Pago → físico 3, reservado 0, vendido 2 (não subtrai duas vezes).
Toda alteração trava a linha do saldo (`SELECT … FOR UPDATE`, sempre na mesma ordem para evitar deadlock), valida e grava o movimento na mesma transação.

**Produto único:** físico máximo 1 (validação + reserva só se disponível ≥ 1). Duas compras simultâneas: a primeira trava a linha e reserva;
a segunda espera, vê disponível 0 e recebe "acabou de ser reservado" (HTTP 409).

**Venda física de item reservado:** bloqueada (409, mostra o pedido). Exceção só para proprietário/administrador, com motivo
obrigatório: cancela explicitamente a reserva e o pedido online, cria ocorrência para avisar o cliente e registra auditoria.
Pedido com pagamento aprovado nunca pode ser "atropelado".

## 5. Reserva de 24 horas e expiração

- O carrinho **não** reserva. A reserva nasce em `POST /api/orders`, com prazo `settings.reservationHours` (padrão 24) calculado no servidor.
- Expiração (`expireReservations`): idempotente — trava o pedido, ignora reservas já processadas, **nunca** libera pedido com pagamento aprovado.
- Executada por: (1) **Vercel Cron** `GET /api/cron/expire-reservations` (protegido por `CRON_SECRET`); (2) verificação oportunista a cada
  leitura do catálogo, checkout e telas do painel. Assim, mesmo se o cron atrasar, nenhuma reserva vencida segura estoque.
- O plano Hobby da Vercel só permite cron **diário**; a verificação oportunista cobre o intervalo. Para precisão de minutos, use Vercel Pro
  (`*/10 * * * *`) ou um agendador externo (ex.: cron-job.org) chamando a rota com `Authorization: Bearer <CRON_SECRET>`.

## 6. Rotas da API

Públicas: `GET /api/catalog` · `POST /api/orders` · `GET /api/orders/:token` · `GET /api/cron/expire-reservations` · `POST /api/webhooks/mercadopago` (501 até a etapa 3)

Autenticação: `GET /api/auth/setup-status` · `POST /api/auth/setup` · `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` ·
`POST /api/auth/verify-email` · `POST /api/auth/resend-code` · `POST /api/auth/forgot-password` · `POST /api/auth/reset-password` ·
`GET /api/auth/invite/:token` · `POST /api/auth/register` (somente com convite)

Painel (permissão entre parênteses):
`GET /api/admin/dashboard` (catalog.read) ·
`GET|POST /api/admin/products`, `GET|PUT /api/admin/products/:id` (products.write) · `POST /api/admin/products/:id/state` (publicar/despublicar/inativar; arquivar = products.archive) ·
`POST /api/admin/uploads` · `GET|POST /api/admin/categories`, `PUT /api/admin/categories/:id` ·
`POST /api/admin/stock/entries` (stock.entry) · `POST /api/admin/stock/adjustments` (stock.adjust) · `POST /api/admin/sales` (sales.physical; exceção = sales.override) ·
`GET /api/admin/movements` · `GET /api/admin/reservations` · `GET /api/admin/orders`, `GET /api/admin/orders/:id` ·
`POST /api/admin/orders/:id/advance` (pago→em processamento→concluído) · `POST /api/admin/orders/:id/cancel` · `GET /api/admin/tracking` ·
`POST /api/admin/issues/:id/resolve` · `GET|PUT /api/admin/settings` · `GET /api/admin/users`, `POST /api/admin/invites`, `POST /api/admin/invites/:id/revoke`, `PUT /api/admin/users/:id` · `GET /api/admin/audit`

Permissões por função: ver `PERMISSIONS` em `api/_lib/auth.js` (proprietário: tudo; administrador: tudo exceto alterar o proprietário/administradores;
estoque: produtos, fotos e entradas; vendedor: venda física e pedidos).

## 7. Autenticação e segurança

- Primeiro acesso: `/admin/setup`, só sem nenhum usuário e com `ADMIN_SETUP_TOKEN`. Nenhuma senha padrão no código.
- Cadastro: **somente por convite** (`/admin/register?invite=…`). Ninguém ganha acesso à loja apenas se cadastrando.
- E-mail confirmado por código de 6 dígitos: 10 min de validade, 5 tentativas, uso único, reenvio após 60 s, máx. 5 por hora; códigos guardados como HMAC.
- Login: 5 falhas em 15 min bloqueiam (por e-mail ou IP); mensagens neutras (não revelam e-mails cadastrados).
- Recuperação de senha por código; ao trocar a senha todas as sessões são encerradas.
- CSRF: cookie `SameSite=Strict` + verificação do cabeçalho `Origin` em toda requisição que altera dados.
- SQL injection: somente consultas parametrizadas. XSS: todo texto é escapado antes de virar HTML (site e painel).
- Uploads: tipo verificado pelo conteúdo (JPG/PNG/WEBP), máx. 3 MB, nome aleatório; armazenados no Blob.
- Logs sem segredos; erros internos retornam mensagem genérica.
- Cabeçalhos: `X-Content-Type-Options`, `HSTS`, `X-Frame-Options: DENY` e `noindex` no painel.

## 7.1 Preparação para o Mercado Pago (etapa 3)

`api/_lib/payments.js → applyPaymentStatus` já implementa: conversão reserva→venda, pagamento tardio (com e sem estoque),
estorno com reposição, eventos duplicados (`payment_events`) e registro de ocorrências. Falta na etapa 3: criar a cobrança,
validar a assinatura do webhook e **consultar o pagamento na API do Mercado Pago** antes de chamar `applyPaymentStatus`.
Nenhuma rota permite aprovar pagamento manualmente; o provedor `teste` só é aceito com `NODE_ENV=test`.

## 8. Variáveis de ambiente

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DATABASE_URL` | sim | PostgreSQL (Neon/Supabase/outro). Local: `pglite:./.data/db` |
| `ADMIN_SETUP_TOKEN` | sim (1º acesso) | código para criar o proprietário |
| `AUTH_SECRET` | sim em produção | segredo (≥16 caracteres) para os códigos por e-mail |
| `RESEND_API_KEY`, `EMAIL_FROM` | sim em produção | envio de e-mails (domínio verificado no Resend) |
| `BLOB_READ_WRITE_TOKEN` | sim em produção | fotos (Vercel Blob) |
| `CRON_SECRET` | sim | protege a rota de expiração (a Vercel envia automaticamente no cron) |

## 9. Testes

`npm test` (Node test runner, banco PostgreSQL em memória via PGlite, e-mails capturados em memória). 27 testes:
autenticação e código por e-mail · convites · recuperação de senha · acesso não autorizado/CSRF · cadastro/edição · SKU duplicado ·
upload · publicação no catálogo · entrada · venda física (única e múltipla) · item reservado + exceção · reserva de 24h ·
expiração automática e idempotência · concorrência no produto único · pedido pendente · pagamento confirmado (teste controlado) ·
pagamento tardio (com e sem estoque) · isolamento entre lojas · adulteração de preço/estoque pelo navegador · histórico preservado ·
dashboard · migração de banco da fase 1.

**Limitação conhecida dos testes:** o PGlite executa transações em série; o teste de concorrência valida a regra (uma reserva, um 409),
mas não exercita paralelismo real de conexões. Em produção a proteção vem do `SELECT … FOR UPDATE` + CHECKs do PostgreSQL.
