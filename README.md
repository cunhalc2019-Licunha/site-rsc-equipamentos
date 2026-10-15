# Loja RSC Equipamentos

Site de vendas (setores, produto, carrinho, pedido com reserva) + **painel administrativo** completo:
produtos e fotos, estoque (físico / reservado / disponível / vendido), entrada de mercadoria, venda física,
reservas de 24 h, pedidos online, histórico de movimentações, usuários por convite e auditoria.

Documentação técnica completa: **[docs/ARQUITETURA.md](docs/ARQUITETURA.md)**.

## Estrutura

| Pasta / arquivo | Função |
|---|---|
| `index.html`, `css/`, `js/`, `img/` | Site da loja |
| `img/produtos/` | Fotos dos produtos (fundo branco) |
| `data/products.json` | Catálogo inicial (223 produtos / 20 setores) — usado na importação do primeiro acesso e como reserva antes dele |
| `admin/` | Painel (`/admin/login`, `/admin/dashboard` …) |
| `api/router.js` | Única função da API (todas as rotas `/api/*`) |
| `api/_routes/` | Rotas: `public.js`, `auth.js`, `admin.js` |
| `api/_lib/` | Regras: estoque, pedidos/reservas, pagamentos (estrutura), autenticação, e-mail, validação |
| `api/_lib/migrations/` | Estrutura do banco versionada (`001_base.sql`, `002_fase2.sql`) |
| `tests/` | Testes automatizados (`npm test`) |
| `scripts/dev.js` | Servidor local |

## Rodar no computador

Requer Node.js 20+.

```bash
npm install
cp .env.example .env        # defina ADMIN_SETUP_TOKEN e AUTH_SECRET
npm run dev                 # site: http://localhost:3000   painel: http://localhost:3000/admin/
npm test                    # roda os testes automatizados
```

Localmente não é preciso nenhuma conta: o banco é um PostgreSQL embutido (pasta `.data/`), as fotos vão para `uploads/`
e os **códigos de e-mail aparecem no terminal** do `npm run dev`.

## Publicar (Vercel)

1. Suba o projeto para o GitHub **mantendo as pastas** (arraste as pastas, não só os arquivos).
2. Na Vercel: *Add New Project* → importe o repositório.
3. *Storage* → **Neon (Postgres)** → cria `DATABASE_URL`. *Storage* → **Blob** → cria `BLOB_READ_WRITE_TOKEN`.
4. Crie uma conta no **Resend** (resend.com), verifique o domínio da loja e gere uma API key.
5. *Settings → Environment Variables*:
   - `ADMIN_SETUP_TOKEN` — código secreto do primeiro acesso
   - `AUTH_SECRET` — texto aleatório longo (32+ caracteres)
   - `CRON_SECRET` — texto aleatório longo
   - `RESEND_API_KEY` e `EMAIL_FROM` (ex.: `RSC Equipamentos <nao-responda@seudominio.com.br>`)
6. *Redeploy*. Acesse `/admin/` → **Primeiro acesso** → confirme o e-mail com o código recebido.
7. Convide a equipe em **Usuários e permissões**.

## Enviar para o GitHub (manual)

Não envie: `node_modules/`, `.data/`, `uploads/`, `.env`, `.claude/`. O upload pelo site do GitHub **não respeita** o `.gitignore`.

## Pagamento online

Etapa 3 (Mercado Pago). A estrutura está pronta (`api/_lib/payments.js`); hoje o pedido é criado com reserva e a equipe
combina o pagamento pelo WhatsApp. **Nenhuma tela permite marcar um pagamento online como aprovado.**
