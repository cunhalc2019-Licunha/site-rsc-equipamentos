# Loja RSC Equipamentos

Site de vendas (setores, produto, carrinho, checkout) + **painel administrativo** com ficha de entrada de produtos e controle de estoque.

## Estrutura

| Pasta / arquivo | Função |
|---|---|
| `index.html`, `css/`, `js/`, `img/` | Site da loja (front-end) |
| `data/products.json` | Catálogo de reserva (usado antes do primeiro acesso ao painel e na importação inicial) |
| `api/catalog.js` | Catálogo público do site, lido do banco |
| `admin/` | **Painel administrativo** (`/admin`) — login, produtos, ficha de entrada, estoque, categorias |
| `api/admin/*.js` | API do painel (funções serverless da Vercel) |
| `api/_lib/` | Regras compartilhadas: banco, autenticação, validação, estoque, produtos, `schema.sql` |
| `api/checkout.js`, `api/webhook.js` | Protótipo do pagamento Mercado Pago (ainda não ativado) |
| `scripts/dev.js` | Servidor para rodar tudo no seu computador |
| `.env.example` | Modelo das variáveis de ambiente |

## Painel administrativo

Acesso: `https://SEU-SITE/admin/` (também há o link **"Área do administrador"** no rodapé do site).

- **Login seguro**: senha com hash (scrypt), sessão em cookie `HttpOnly`/`SameSite=Strict`, bloqueio após 5 tentativas erradas em 15 min.
- **Ficha de entrada de produto**: identificação, condição (novo / seminovo / usado revisado), tipo de estoque
  (**item único** ou **várias unidades**), fotos (até 10, reduzidas automaticamente), preço e descontos por forma de pagamento,
  descrição, especificações e a **entrada no estoque** (quantidade, origem, fornecedor, custo, documento).
- **Estoque**: entradas, saídas (ex.: venda na loja física) e ajustes, com **histórico** (quem, quando, quanto, saldo).
  O banco impede estoque negativo e item único com mais de 1 unidade.
- **Categorias** (setores do site) e **auditoria** de todas as ações.

> **O site mostra os produtos cadastrados no painel** (rota `/api/catalog`): só aparecem os produtos
> com status **Publicado** e com pelo menos uma foto. Preço e estoque vêm do banco; quando o estoque zera,
> o site mostra **"Vendido"**. Antes do primeiro acesso ao painel, o site usa o `data/products.json` como reserva.

## Publicar (Vercel + banco + fotos)

1. Suba esta pasta para o GitHub (veja "Enviar para o GitHub" abaixo).
2. Em **vercel.com** → *Add New Project* → importe o repositório → *Deploy*.
3. **Banco de dados**: no projeto da Vercel → *Storage* → *Create* → **Neon (Postgres)**.
   Isso cria a variável `DATABASE_URL` automaticamente. (Supabase ou outro Postgres também funcionam — basta colar a URL.)
4. **Fotos**: *Storage* → *Create* → **Blob**. Isso cria `BLOB_READ_WRITE_TOKEN` automaticamente.
5. Em *Settings → Environment Variables*, crie `ADMIN_SETUP_TOKEN` com um código longo e secreto (só você deve saber).
6. Faça *Redeploy* para as variáveis valerem.
7. Acesse `/admin/` → tela de **Primeiro acesso** → informe o `ADMIN_SETUP_TOKEN`, crie seu usuário e (opcional) importe os 7 produtos atuais.
   Essa tela só funciona uma vez; depois disso o painel exige login.

As tabelas do banco são criadas automaticamente no primeiro acesso (arquivo `api/_lib/schema.sql`).

## Rodar no seu computador (opcional)

Requer Node.js 20+.

```bash
npm install
cp .env.example .env      # edite e defina ADMIN_SETUP_TOKEN
npm run dev               # http://localhost:3000  e  http://localhost:3000/admin/
```

Localmente o banco é um Postgres embutido (pasta `.data/`) e as fotos vão para `uploads/` — nada disso vai para o GitHub.

## Enviar para o GitHub (manual)

Envie **todos os arquivos desta pasta**, exceto: `node_modules/`, `.data/`, `uploads/`, `.env` e `.claude/`
(se você rodou o projeto localmente). O upload pelo site do GitHub **não respeita** o `.gitignore`.

## Segurança — nunca coloque no código

`DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `ADMIN_SETUP_TOKEN`, `MP_ACCESS_TOKEN` ficam **somente** nas variáveis de ambiente da Vercel.

## Pagamento online (Mercado Pago) — fase futura

O checkout hoje funciona em **modo demonstração** (pedido enviado ao WhatsApp). Os arquivos `api/checkout.js` e
`api/webhook.js` são um protótipo e serão refeitos sobre o banco (pedidos, reserva de estoque, baixa automática).
