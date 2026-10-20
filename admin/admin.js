(() => {
// =====================================================================================
// Painel administrativo — RSC Equipamentos
// Todas as regras (preço, estoque, reservas, permissões) ficam no backend; esta tela só exibe e envia.
// Todo texto vindo da API passa por esc() antes de virar HTML (proteção contra XSS).
// =====================================================================================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const root = $("#root");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const brl = cents => cents == null ? "—" : (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const moneyStr = cents => cents == null ? "" : (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
const moneyCents = v => { const d = String(v || "").replace(/\D/g, ""); return d ? parseInt(d, 10) : null; };
const dt = s => s ? new Date(s).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
function left(s) {
  const ms = new Date(s) - Date.now();
  if (ms <= 0) return `<span class="pill-bad">vencida</span>`;
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000);
  return `<span class="${h < 6 ? "pill-warn" : "muted-sm"}">${h}h ${m}min</span>`;
}

const CONDITION = { novo: "Novo", seminovo: "Seminovo", usado_revisado: "Usado revisado" };
const STATE = { ativo: "Ativo", inativo: "Inativo", arquivado: "Arquivado" };
const MOVE = { entrada: "Entrada", venda_fisica: "Venda física", venda_online: "Venda online", reserva_criada: "Reserva criada",
  reserva_liberada: "Reserva liberada", ajuste: "Ajuste", cancelamento: "Cancelamento", estorno: "Estorno" };
const ORDER = { aguardando_pagamento: "Aguardando pagamento", pago: "Pago", em_processamento: "Em processamento", concluido: "Concluído",
  cancelado: "Cancelado", expirado: "Expirado", estornado: "Estornado" };
const PAY = { pendente: "Pendente", aprovado: "Aprovado", recusado: "Recusado", cancelado: "Cancelado", estornado: "Estornado", desconhecido: "Desconhecido" };
const RES = { ativa: "Ativa", convertida: "Convertida em venda", expirada: "Expirada", cancelada: "Cancelada" };
const ROLE = { owner: "Proprietário", admin: "Administrador", estoque: "Estoque", vendedor: "Vendedor" };
const SALE_PAY = { dinheiro: "Dinheiro", pix: "PIX", cartao_credito: "Cartão de crédito", cartao_debito: "Cartão de débito", transferencia: "Transferência", outro: "Outro" };
const METHODS = { pix: "PIX", card: "Cartão", boleto: "Boleto" };

let ME = null, CATS = [], dirty = false, timers = [];
const can = p => ME?.permissions?.includes(p);

// ---------- API ----------
async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(`/api/${path}`, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401 && !path.startsWith("auth/")) { ME = null; go("/admin/login"); throw Object.assign(new Error(data.error || "Sessão expirada."), { status: 401 }); }
  if (!r.ok) throw Object.assign(new Error(data.error || `Erro ${r.status}`), { status: r.status, data });
  return data;
}

let toastTimer;
function toast(msg, ok = true) {
  const t = $("#toast");
  t.innerHTML = `<span style="color:${ok ? "var(--green)" : "#ff8a80"};font-weight:800">${ok ? "✓" : "!"}</span> <span>${esc(msg)}</span>`;
  t.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 4000);
}

// ---------- Navegação (endereços reais: /admin/login, /admin/dashboard …) ----------
function go(path, replace = false) {
  if (dirty && !confirm("Há alterações não salvas. Sair mesmo assim?")) return;
  dirty = false;
  history[replace ? "replaceState" : "pushState"](null, "", path);
  render();
}
document.addEventListener("click", e => {
  const a = e.target.closest("a[data-link]");
  if (a && !e.ctrlKey && !e.metaKey) { e.preventDefault(); go(a.getAttribute("href")); }
});
window.addEventListener("popstate", () => render());
window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
const poll = (fn, ms = 30000) => timers.push(setInterval(() => { if (document.visibilityState === "visible") fn(); }, ms));

const NAV = [
  ["/admin/dashboard", "Visão geral", "catalog.read"],
  ["/admin/products", "Produtos", "catalog.read"],
  ["/admin/products/new", "Cadastrar produto", "products.write"],
  ["/admin/stock", "Estoque", "catalog.read"],
  ["/admin/stock-in", "Entrada de mercadoria", "stock.entry"],
  ["/admin/sale", "Registrar venda física", "sales.physical"],
  ["/admin/reservations", "Reservas", "orders.read"],
  ["/admin/orders", "Pedidos online", "orders.read"],
  ["/admin/movements", "Histórico de movimentações", "catalog.read"],
  ["/admin/settings", "Configurações", "catalog.read"],
  ["/admin/users", "Usuários e permissões", "users.manage"],
];

function shell(active, html) {
  root.innerHTML = `
  <div class="mobilebar"><a href="/admin/dashboard" data-link class="brand"><img src="/img/logo.png" alt="" style="width:36px;height:36px"><div><b style="font-size:1.3rem">RSC</b></div></a>
    <button class="burger" id="mnav" style="display:grid" aria-label="Menu">☰</button></div>
  <div class="layout">
    <aside class="sidebar" id="sidebar">
      <a href="/admin/dashboard" data-link class="brand"><img src="/img/logo.png" alt=""><div><b>RSC</b><small>Equipamentos</small></div></a>
      <div class="tagline">Painel administrativo</div>
      <nav class="side-nav">
        ${NAV.filter(n => can(n[2])).map(([href, label]) => `<a href="${href}" data-link class="${active === href ? "on" : ""}">${label}</a>`).join("")}
        <div class="sep"></div>
        <a href="/" target="_blank" rel="noopener">Ver site ↗</a>
        <a href="#" id="logout">Sair</a>
      </nav>
      <div class="side-user"><b>${esc(ME.user.name)}</b><span>${esc(ROLE[ME.user.role])} · ${esc(ME.store.name)}</span></div>
    </aside>
    <main class="main">${html}</main>
  </div>`;
  $("#logout").onclick = async e => { e.preventDefault(); await api("auth/logout", { method: "POST" }).catch(() => {}); ME = null; go("/admin/login"); };
  $("#mnav").onclick = () => $("#sidebar").classList.toggle("open");
}
const head = (eyebrow, title, sub = "", actions = "") =>
  `<div class="topline"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div>${actions}</div>`;
const fail = (el, err) => { el.innerHTML = `<div class="alert">${esc(err.message)}</div>`; };

// =====================================================================================
// Autenticação
// =====================================================================================
function authBox(title, sub, form, links = "") {
  root.innerHTML = `<div class="auth"><div class="box">
    <div class="brand"><img src="/img/logo.png" alt="" style="width:56px;height:56px"><div><b>RSC</b><small>Equipamentos</small></div></div>
    <h1>${title}</h1><p class="sub">${sub}</p>${form}${links}</div></div>`;
}
const errBox = (msg) => { const e = $("#err"); e.textContent = msg; e.style.display = msg ? "flex" : "none"; };

function pageLogin() {
  authBox("Entrar", "Acesso restrito à equipe da loja.", `
    <form id="f" class="form" novalidate>
      <div class="f"><label>E-mail</label><input name="email" type="email" autocomplete="username" required></div>
      <div class="f"><label>Senha</label><input name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary btn-block" type="submit">Entrar</button>
      <div class="alert" id="err" style="display:none"></div>
    </form>`, `<div class="links"><a href="/admin/forgot-password" data-link>Esqueci minha senha</a><a href="/admin/register" data-link>Tenho um convite</a></div>`);
  $("#f").onsubmit = async e => {
    e.preventDefault(); const f = e.target, btn = $("button", f); btn.disabled = true; errBox("");
    try {
      await api("auth/login", { method: "POST", body: { email: f.email.value, password: f.password.value } });
      await loadMe(); go("/admin/dashboard", true);
    } catch (err) {
      if (err.data?.code === "EMAIL_NOT_VERIFIED") return go(`/admin/verify-email?email=${encodeURIComponent(f.email.value)}`);
      errBox(err.message); btn.disabled = false; f.password.value = "";
    }
  };
}

// Primeiro acesso em 2 passos: (1) e-mail do proprietário → código enviado; (2) código + dados → conta criada.
function pageSetup() {
  authBox("Primeiro acesso", "Crie a conta do proprietário da loja. Esta tela só funciona uma vez.", `
    <form id="f1" class="form" novalidate>
      <div class="f"><label>E-mail do proprietário</label><input name="email" type="email" autocomplete="username" required>
        <span class="help">Enviaremos um código de 6 dígitos para este e-mail.</span></div>
      <button class="btn btn-primary btn-block" type="submit">Enviar código</button>
    </form>
    <form id="f2" class="form" novalidate style="display:none">
      <p class="muted-sm" id="sentTo"></p>
      <div class="f"><label>Código recebido por e-mail</label><input name="code" class="codein" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></div>
      <div class="f"><label>Nome da loja</label><input name="storeName" value="RSC Equipamentos" required></div>
      <div class="f"><label>Seu nome</label><input name="name" autocomplete="name" required></div>
      <div class="f"><label>Crie uma senha para o painel (mínimo 10 caracteres)</label><input name="password" type="password" autocomplete="new-password" required></div>
      <div class="f"><label>Confirmar senha</label><input name="password2" type="password" autocomplete="new-password" required></div>
      <label class="check" style="color:var(--text)"><input type="checkbox" name="importCatalog" checked> Importar o catálogo atual do site (≈220 produtos, 20 setores)</label>
      <button class="btn btn-primary btn-block" type="submit">Criar conta e entrar</button>
      <button class="btn btn-ghost btn-block" type="button" id="resend">Reenviar código</button>
    </form>
    <div class="alert" id="err" style="display:none;margin-top:12px"></div>`);
  let email = "";
  const send = async () => {
    errBox("");
    try { const r = await api("auth/setup/send-code", { method: "POST", body: { email } }); toast(r.message);
      $("#f1").style.display = "none"; $("#f2").style.display = "grid"; $("#sentTo").textContent = `Código enviado para ${email}. Ele vale por 10 minutos.`; $("#f2").code.focus(); }
    catch (err) { errBox(err.message); }
  };
  $("#f1").onsubmit = e => { e.preventDefault(); email = e.target.email.value.trim().toLowerCase(); send(); };
  $("#resend").onclick = send;
  const f2 = $("#f2");
  f2.code.oninput = () => { f2.code.value = f2.code.value.replace(/\D/g, "").slice(0, 6); };
  f2.onsubmit = async e => {
    e.preventDefault(); errBox("");
    if (f2.password.value !== f2.password2.value) return errBox("As senhas não conferem.");
    const btn = $("button[type=submit]", f2); btn.disabled = true; btn.textContent = "Criando… (a importação pode levar alguns segundos)";
    try {
      await api("auth/setup", { method: "POST", body: { email, code: f2.code.value, storeName: f2.storeName.value,
        name: f2.name.value, password: f2.password.value, importCatalog: f2.importCatalog.checked } });
      await loadMe(); toast("Conta criada!"); go("/admin/dashboard", true);
    } catch (err) { errBox(err.message); btn.disabled = false; btn.textContent = "Criar conta e entrar"; }
  };
}

async function pageRegister() {
  const invite = new URLSearchParams(location.search).get("invite");
  if (!invite) {
    authBox("Cadastro por convite", "O acesso ao painel é concedido pelo proprietário da loja.", `
      <div class="alert" style="display:flex">Para criar sua conta, use o link de convite enviado para o seu e-mail. Se ainda não recebeu, peça ao proprietário da loja.</div>`,
      `<div class="links"><a href="/admin/login" data-link>Voltar ao login</a></div>`);
    return;
  }
  authBox("Criar conta", "Validando convite…", "");
  let inv;
  try { inv = (await api(`auth/invite/${encodeURIComponent(invite)}`)).invite; }
  catch (err) { authBox("Convite inválido", esc(err.message), "", `<div class="links"><a href="/admin/login" data-link>Ir para o login</a></div>`); return; }
  authBox("Criar conta", `Convite para <b>${esc(inv.store)}</b> como <b>${esc(ROLE[inv.role])}</b>.`, `
    <form id="f" class="form" novalidate>
      <div class="f"><label>E-mail</label><input value="${esc(inv.email)}" disabled></div>
      <div class="f"><label>Seu nome</label><input name="name" autocomplete="name" required></div>
      <div class="f"><label>Senha (mínimo 10 caracteres)</label><input name="password" type="password" autocomplete="new-password" required></div>
      <div class="f"><label>Confirmar senha</label><input name="password2" type="password" autocomplete="new-password" required></div>
      <button class="btn btn-primary btn-block" type="submit">Criar conta</button>
      <div class="alert" id="err" style="display:none"></div>
    </form>`);
  $("#f").onsubmit = async e => {
    e.preventDefault(); const f = e.target; errBox("");
    if (f.password.value !== f.password2.value) return errBox("As senhas não conferem.");
    try {
      const r = await api("auth/register", { method: "POST", body: { invite, name: f.name.value, password: f.password.value } });
      go(`/admin/verify-email?email=${encodeURIComponent(r.email)}`, true);
    } catch (err) { errBox(err.message); }
  };
}

function pageVerify() {
  const email = new URLSearchParams(location.search).get("email") || "";
  authBox("Confirme seu e-mail", `Enviamos um código de 6 dígitos para <b>${esc(email) || "seu e-mail"}</b>. Ele vale por 10 minutos.`, `
    <form id="f" class="form" novalidate>
      ${email ? "" : `<div class="f"><label>E-mail</label><input name="email" type="email" required></div>`}
      <div class="f"><label>Código</label><input name="code" class="codein" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></div>
      <button class="btn btn-primary btn-block" type="submit">Confirmar</button>
      <button class="btn btn-ghost btn-block" type="button" id="resend">Reenviar código</button>
      <div class="alert" id="err" style="display:none"></div>
    </form>`, `<div class="links"><a href="/admin/login" data-link>Voltar ao login</a></div>`);
  const f = $("#f");
  const mail = () => email || f.email.value;
  f.code.oninput = () => { f.code.value = f.code.value.replace(/\D/g, "").slice(0, 6); };
  f.code.focus();
  f.onsubmit = async e => {
    e.preventDefault(); errBox("");
    try { await api("auth/verify-email", { method: "POST", body: { email: mail(), code: f.code.value } }); await loadMe(); toast("E-mail confirmado!"); go("/admin/dashboard", true); }
    catch (err) { if (err.data?.code === "ALREADY_VERIFIED") return go("/admin/login", true); errBox(err.message); f.code.value = ""; }
  };
  $("#resend").onclick = async () => {
    errBox("");
    try { const r = await api("auth/resend-code", { method: "POST", body: { email: mail() } }); toast(r.message); }
    catch (err) { errBox(err.message); }
  };
}

function pageForgot() {
  authBox("Recuperar senha", "Informe seu e-mail. Enviaremos um código para criar uma nova senha.", `
    <form id="f1" class="form" novalidate>
      <div class="f"><label>E-mail</label><input name="email" type="email" autocomplete="username" required></div>
      <button class="btn btn-primary btn-block" type="submit">Enviar código</button>
    </form>
    <form id="f2" class="form" novalidate style="display:none">
      <div class="f"><label>Código recebido</label><input name="code" class="codein" inputmode="numeric" maxlength="6" required></div>
      <div class="f"><label>Nova senha (mínimo 10 caracteres)</label><input name="password" type="password" autocomplete="new-password" required></div>
      <div class="f"><label>Confirmar nova senha</label><input name="password2" type="password" autocomplete="new-password" required></div>
      <button class="btn btn-primary btn-block" type="submit">Salvar nova senha</button>
      <button class="btn btn-ghost btn-block" type="button" id="resend">Reenviar código</button>
    </form>
    <div class="alert" id="err" style="display:none;margin-top:12px"></div>`, `<div class="links"><a href="/admin/login" data-link>Voltar ao login</a></div>`);
  let email = "";
  $("#f1").onsubmit = async e => {
    e.preventDefault(); errBox(""); email = e.target.email.value.trim();
    try { const r = await api("auth/forgot-password", { method: "POST", body: { email } }); toast(r.message); $("#f1").style.display = "none"; $("#f2").style.display = "grid"; $("#f2").code.focus(); }
    catch (err) { errBox(err.message); }
  };
  $("#f2").onsubmit = async e => {
    e.preventDefault(); const f = e.target; errBox("");
    if (f.password.value !== f.password2.value) return errBox("As senhas não conferem.");
    try { await api("auth/reset-password", { method: "POST", body: { email, code: f.code.value, password: f.password.value } }); toast("Senha alterada. Faça login."); go("/admin/login", true); }
    catch (err) { errBox(err.message); }
  };
  $("#resend").onclick = async () => { try { const r = await api("auth/resend-code", { method: "POST", body: { email, purpose: "reset_password" } }); toast(r.message); } catch (err) { errBox(err.message); } };
}

// =====================================================================================
// Visão geral
// =====================================================================================
async function pageDashboard() {
  shell("/admin/dashboard", head("Painel", "Visão geral", "Indicadores calculados agora a partir do banco de dados.") + `<div id="dash"><div class="empty-state">Carregando…</div></div>`);
  const load = async () => {
    try {
      const d = await api("admin/dashboard");
      const k = d.products, o = d.orders;
      $("#dash").innerHTML = `
        <div class="kpis">
          <a class="kpi" href="/admin/stock?f=ativos" data-link><span>Produtos ativos</span><b>${k.active}</b></a>
          <a class="kpi ok" href="/admin/stock?f=disponiveis" data-link><span>Disponíveis no site</span><b>${k.available}</b></a>
          <a class="kpi warn" href="/admin/stock?f=reservados" data-link><span>Com reserva</span><b>${k.reserved}</b></a>
          <a class="kpi bad" href="/admin/stock?f=sem_estoque" data-link><span>Sem estoque</span><b>${k.out_of_stock}</b></a>
          <a class="kpi warn" href="/admin/orders?status=aguardando_pagamento" data-link><span>Aguardando pagamento</span><b>${o.awaiting}</b></a>
          <a class="kpi ok" href="/admin/orders?status=pago" data-link><span>Pedidos pagos</span><b>${o.paid}</b></a>
          <div class="kpi"><span>Vendas físicas (30 dias)</span><b>${o.physical_30d}</b><small>${brl(o.physical_30d_total)}</small></div>
          <div class="kpi"><span>Vendas online (30 dias)</span><b>${o.online_30d}</b><small>${brl(o.online_30d_total)}</small></div>
          <a class="kpi ${d.issues ? "bad" : ""}" href="/admin/orders?tab=tracking" data-link><span>Ocorrências abertas</span><b>${d.issues}</b></a>
        </div>
        <div class="grid2">
          <section class="panel"><h3>Reservas vencendo (6h)</h3>
            ${d.expiring.length ? `<table class="tbl" style="min-width:0"><tbody>${d.expiring.map(r => `<tr><td><b>${esc(r.name)}</b><small>${esc(r.sku)} · pedido <a href="/admin/orders/${r.order_id}" data-link>#${r.number}</a></small></td><td class="num">${r.quantity} un.</td><td>${left(r.expires_at)}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">Nenhuma reserva vencendo nas próximas 6 horas.</p>`}
          </section>
          <section class="panel"><h3>Últimas movimentações</h3>
            ${d.movements.length ? `<table class="tbl" style="min-width:0"><tbody>${d.movements.map(m => `<tr><td><b>${esc(m.product_name)}</b><small>${esc(MOVE[m.type])} · ${dt(m.created_at)}${m.user_name ? " · " + esc(m.user_name) : ""}</small></td><td class="num ${m.physical_delta > 0 ? "pos" : m.physical_delta < 0 ? "neg" : ""}">${m.physical_delta ? (m.physical_delta > 0 ? "+" : "") + m.physical_delta : `<span class="chip reserva">${m.reserved_delta > 0 ? "+" : ""}${m.reserved_delta} res.</span>`}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">Nenhuma movimentação ainda.</p>`}
            <a href="/admin/movements" data-link class="link-btn">Ver histórico completo →</a>
          </section>
        </div>`;
    } catch (err) { fail($("#dash"), err); }
  };
  await load(); poll(load);
}

// =====================================================================================
// Produtos (lista)
// =====================================================================================
async function pageProducts() {
  shell("/admin/products", head("Catálogo", "Produtos", "", can("products.write") ? `<a href="/admin/products/new" data-link class="btn btn-primary">+ Cadastrar produto</a>` : "") + `
    <div class="filters">
      <input id="q" type="search" placeholder="Pesquisar por nome ou SKU…">
      <select id="fs"><option value="">Ativos e inativos</option><option value="ativo">Ativos</option><option value="inativo">Inativos</option><option value="arquivado">Arquivados</option></select>
      <select id="fp"><option value="">Publicados e não publicados</option><option value="1">Publicados</option><option value="0">Não publicados</option></select>
      <select id="fc"><option value="">Todas as categorias</option>${CATS.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select>
    </div><div id="list"><div class="empty-state">Carregando…</div></div>`);
  let timer;
  const load = async () => {
    const qs = new URLSearchParams({ q: $("#q").value, state: $("#fs").value, published: $("#fp").value, categoryId: $("#fc").value });
    try {
      const { products } = await api(`admin/products?${qs}`);
      $("#list").innerHTML = products.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr><th></th><th>Produto</th><th>Categoria</th><th>Preço</th><th>Disponível</th><th>Situação</th><th></th></tr></thead>
        <tbody>${products.map(p => `<tr class="click" data-id="${esc(p.id)}">
          <td>${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="" style="object-fit:contain">` : `<div class="thumb none">sem foto</div>`}</td>
          <td><b>${esc(p.name)}</b><small>${esc(p.sku)} · ${esc(CONDITION[p.condition])}</small></td>
          <td>${esc(p.category || "—")}</td>
          <td class="num">${p.price_cents ? (p.promo_price_cents ? `<s class="muted-sm">${brl(p.price_cents)}</s><br>${brl(p.promo_price_cents)}` : brl(p.price_cents)) : `<span class="muted">Sob consulta</span>`}</td>
          <td><span class="chip ${p.available <= 0 ? "zero" : ""}">${p.available} disp.</span>${p.reserved ? `<small>${p.reserved} reservado(s)</small>` : ""}</td>
          <td><span class="chip ${p.state}">${STATE[p.state]}</span> ${p.published ? `<span class="chip publicado">Publicado</span>` : `<span class="chip rascunho">Não publicado</span>`}</td>
          <td>${can("products.write") && p.state === "ativo" ? `<button class="add-btn ghost" data-pub="${esc(p.id)}" data-v="${p.published ? 0 : 1}">${p.published ? "Despublicar" : "Publicar"}</button>` : ""}</td>
        </tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><b>Nenhum produto encontrado</b></div>`;
      $$("tr[data-id]").forEach(tr => tr.onclick = e => { if (!e.target.closest("button")) go(`/admin/products/${tr.dataset.id}`); });
      $$("[data-pub]").forEach(b => b.onclick = async () => {
        try { await api(`admin/products/${b.dataset.pub}/state`, { method: "POST", body: { published: b.dataset.v === "1" } }); toast(b.dataset.v === "1" ? "Produto publicado." : "Produto despublicado."); load(); }
        catch (err) { toast(err.message, false); }
      });
    } catch (err) { fail($("#list"), err); }
  };
  $("#q").oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
  ["#fs", "#fp", "#fc"].forEach(s => $(s).onchange = load);
  load();
}

// =====================================================================================
// Cadastro / edição de produto
// =====================================================================================
async function resizeToBase64(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1];
}
const seg = (name, options, value, attrs = "") => `<div class="seg">${Object.entries(options).map(([v, [label, sub]]) =>
  `<label class="${v === value ? "on" : ""}"><input type="radio" name="${name}" value="${v}" ${v === value ? "checked" : ""} ${attrs}><b>${label}</b>${sub ? `<small>${sub}</small>` : ""}</label>`).join("")}</div>`;

async function pageProduct(id) {
  const isNew = !id;
  shell(isNew ? "/admin/products/new" : "/admin/products", `<div class="empty-state">Carregando…</div>`);
  let p = { name: "", brand: "", category_id: CATS[0]?.id, sku: "", condition: "usado_revisado", stock_type: "unico", price_cents: null,
    promo_price_cents: null, discount_pix_pct: 0, discount_card_pct: 0, payment_methods: ["pix", "card", "boleto"], badge: "",
    description: "", internal_notes: "", sell_online: true, state: "ativo", published: false, specs: [], images: [] };
  if (!isNew) { try { p = (await api(`admin/products/${encodeURIComponent(id)}`)).product; } catch (err) { return fail($(".main"), err); } }
  const editable = can("products.write");
  let images = [...p.images];
  let specs = p.specs.length ? p.specs.map(s => ({ ...s })) : [{ k: "", v: "" }];

  $(".main").innerHTML = `
    ${head(isNew ? "Ficha de produto" : esc(p.sku), isNew ? "Cadastrar produto" : esc(p.name), isNew ? "Cadastre o equipamento e informe a quantidade inicial em um só passo." : `Atualizado em ${dt(p.updated_at)}`, `<a href="/admin/products" data-link class="btn btn-ghost">← Produtos</a>`)}
    <div class="sheet">
      <form id="sheet" novalidate style="display:grid;gap:20px">
        <fieldset ${editable ? "" : "disabled"} style="border:0;display:grid;gap:20px">
        <section class="panel"><h3>1. Identificação</h3><p class="hint">Campos com * são obrigatórios.</p>
          <div class="form">
            <div class="f s4"><label>Nome *</label><input name="name" maxlength="120" value="${esc(p.name)}" placeholder="Ex.: Freezer Metalfrio 500L"></div>
            <div class="f s2"><label>SKU (único na loja)</label><input name="sku" maxlength="40" value="${esc(p.sku)}" placeholder="Automático"></div>
            <div class="f s3"><label>Marca / modelo</label><input name="brand" maxlength="120" value="${esc(p.brand)}"></div>
            <div class="f s3"><label>Categoria *</label><select name="categoryId">${CATS.map(c => `<option value="${esc(c.id)}" ${c.id === p.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
            <div class="f"><label>Condição *</label>${seg("condition", { novo: ["Novo"], usado_revisado: ["Usado / revisado"], seminovo: ["Seminovo"] }, p.condition)}</div>
            <div class="f"><label>Tipo de estoque *</label>${seg("stockType", { unico: ["Produto único", "Uma unidade específica (ex.: usado)"], quantidade: ["Várias unidades", "Mesmo produto com quantidade"] }, p.stock_type)}</div>
          </div>
        </section>
        <section class="panel"><h3>2. Fotos</h3><p class="hint">A primeira é a imagem principal. Até 10 fotos, reduzidas automaticamente.</p>
          <label class="drop" id="drop"><input type="file" id="files" accept="image/jpeg,image/png,image/webp" multiple hidden><b>Clique para escolher</b> ou arraste as fotos aqui<br><small>JPG, PNG ou WEBP</small></label>
          <div class="pics" id="pics"></div>
        </section>
        <section class="panel"><h3>3. Preço</h3><p class="hint">Sem preço, o produto aparece como "Sob consulta".</p>
          <div class="form">
            <div class="f s3"><label>Preço</label><div class="prefix"><span>R$</span><input name="price" class="money" inputmode="numeric" value="${moneyStr(p.price_cents)}" placeholder="0,00"></div></div>
            <div class="f s3"><label>Preço promocional (opcional)</label><div class="prefix"><span>R$</span><input name="promo" class="money" inputmode="numeric" value="${moneyStr(p.promo_price_cents)}" placeholder="0,00"></div></div>
            <div class="f s3"><label>Desconto no PIX (%)</label><input name="discountPixPct" type="number" min="0" max="90" step="0.5" value="${Number(p.discount_pix_pct)}"></div>
            <div class="f s3"><label>Desconto no cartão (%)</label><input name="discountCardPct" type="number" min="0" max="90" step="0.5" value="${Number(p.discount_card_pct)}"></div>
            <div class="f"><label>Formas de pagamento aceitas</label><div class="checks">${Object.entries(METHODS).map(([k, l]) => `<label><input type="checkbox" name="pm" value="${k}" ${p.payment_methods.includes(k) ? "checked" : ""}> ${l}</label>`).join("")}</div></div>
          </div>
        </section>
        <section class="panel"><h3>4. Descrição</h3>
          <div class="form"><div class="f"><label>Descrição</label><textarea name="description" maxlength="6000">${esc(p.description)}</textarea></div></div>
          <label style="display:block;font-size:.82rem;font-weight:600;color:var(--muted);margin:16px 0 8px">Especificações</label>
          <div id="specs"></div><button type="button" class="link-btn" id="addSpec">+ Adicionar especificação</button>
        </section>
        ${isNew ? `<section class="panel"><h3>5. Quantidade inicial</h3><p class="hint">Gera uma movimentação de entrada no histórico.</p>
          <div class="form">
            <div class="f s2"><label>Quantidade *</label><input name="qty" type="number" min="0" step="1" value="1"></div>
            <div class="f s4"><label>Origem</label><select name="origin">${Object.entries(ME.entryOrigins).map(([k, l]) => `<option value="${k}" ${k === "compra" ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
            <div class="f s3"><label>Fornecedor / de quem foi comprado</label><input name="supplier" maxlength="120"></div>
            <div class="f s3"><label>Custo de aquisição (unit., interno)</label><div class="prefix"><span>R$</span><input name="unitCost" class="money" inputmode="numeric"></div></div>
          </div></section>` : ""}
        </fieldset>
      </form>
      <div class="side-col">
        <section class="panel" id="pubPanel"><h3>Publicação</h3>
          <div class="form" style="margin-top:12px">
            <div class="f"><label>Estado</label><select name="state" form="sheet" ${editable ? "" : "disabled"}>${Object.entries(STATE).filter(([k]) => k !== "arquivado" || p.state === "arquivado" || can("products.archive")).map(([k, l]) => `<option value="${k}" ${k === p.state ? "selected" : ""}>${l}</option>`).join("")}</select>
              <span class="help">Inativo e arquivado nunca aparecem no site. Arquivar preserva o histórico.</span></div>
            <label class="check" style="color:var(--text)"><input type="checkbox" name="published" form="sheet" ${p.published ? "checked" : ""} ${editable ? "" : "disabled"}> Publicado no site</label>
            <label class="check" style="color:var(--text)"><input type="checkbox" name="sellOnline" form="sheet" ${p.sell_online ? "checked" : ""} ${editable ? "" : "disabled"}> Permitir compra online</label>
            <div class="f"><label>Selo no card (opcional)</label><input name="badge" form="sheet" maxlength="30" value="${esc(p.badge)}" ${editable ? "" : "disabled"}></div>
            <div class="f"><label>Observações internas</label><textarea name="internalNotes" form="sheet" maxlength="2000" style="min-height:80px" ${editable ? "" : "disabled"}>${esc(p.internal_notes)}</textarea></div>
          </div>
          <p class="muted-sm" style="margin-top:10px">Aparece no site só se: ativo + publicado + com foto + com estoque disponível.</p>
        </section>
        ${isNew ? "" : `<section class="panel" id="stockPanel"></section>`}
      </div>
    </div>
    ${editable ? `<div class="savebar"><span class="msg" id="msg">${isNew ? "Preencha os campos com * e salve." : "Alterações de preço e estado ficam registradas na auditoria."}</span>
      <div style="display:flex;gap:10px">
        ${!isNew && p.state !== "arquivado" && can("products.archive") ? `<button type="button" class="btn btn-ghost" id="archive">Arquivar</button>` : ""}
        <button type="submit" form="sheet" class="btn btn-primary" id="save">${isNew ? "Cadastrar produto" : "Salvar alterações"}</button>
      </div></div>` : ""}`;

  const form = $("#sheet");
  dirty = false;
  form.addEventListener("input", () => { dirty = true; });
  $("#pubPanel").addEventListener("input", () => { dirty = true; });
  form.addEventListener("change", e => {
    if (e.target.type === "radio") $$(`input[name="${e.target.name}"]`, form).forEach(r => r.closest("label").classList.toggle("on", r.checked));
    if (e.target.name === "stockType" && form.qty) { const u = form.stockType.value === "unico"; if (u && +form.qty.value > 1) form.qty.value = 1; form.qty.max = u ? 1 : 100000; }
    dirty = true;
  });
  $$(".money", form).forEach(i => i.addEventListener("input", () => { const c = moneyCents(i.value); i.value = c == null ? "" : moneyStr(c); }));

  const renderSpecs = () => { $("#specs").innerHTML = specs.map((s, i) => `<div class="spec-row"><input data-k="${i}" maxlength="60" placeholder="Ex.: Tensão" value="${esc(s.k)}"><input data-v="${i}" maxlength="200" placeholder="Ex.: 220V" value="${esc(s.v)}"><button type="button" data-rm="${i}">✕</button></div>`).join(""); };
  renderSpecs();
  $("#specs").addEventListener("input", e => { if (e.target.dataset.k) specs[e.target.dataset.k].k = e.target.value; if (e.target.dataset.v) specs[e.target.dataset.v].v = e.target.value; });
  $("#specs").addEventListener("click", e => { const b = e.target.closest("[data-rm]"); if (b) { specs.splice(+b.dataset.rm, 1); renderSpecs(); dirty = true; } });
  $("#addSpec").onclick = () => { specs.push({ k: "", v: "" }); renderSpecs(); };

  let uploading = 0;
  const renderPics = () => {
    $("#pics").innerHTML = images.map((u, i) => `<div class="pic"><img src="${esc(u)}" alt="" style="object-fit:contain">
      ${i === 0 ? `<span class="cover">PRINCIPAL</span>` : `<button type="button" class="main-btn" data-main="${i}">Tornar principal</button>`}
      <div class="acts"><button type="button" data-left="${i}" title="Mover para a esquerda">‹</button><button type="button" data-del="${i}" title="Remover">✕</button><button type="button" data-right="${i}" title="Mover para a direita">›</button></div></div>`).join("")
      + Array.from({ length: uploading }, () => `<div class="pic loading">Enviando…</div>`).join("");
  };
  renderPics();
  $("#pics").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b || !editable) return;
    if (b.dataset.main) { const [x] = images.splice(+b.dataset.main, 1); images.unshift(x); }
    else if (b.dataset.del !== undefined) images.splice(+b.dataset.del, 1);
    else { const i = +(b.dataset.left ?? b.dataset.right), j = b.dataset.left !== undefined ? i - 1 : i + 1; if (j < 0 || j >= images.length) return; [images[i], images[j]] = [images[j], images[i]]; }
    dirty = true; renderPics();
  });
  const addFiles = async files => {
    const list = [...files].filter(f => /^image\//.test(f.type)).slice(0, 10 - images.length - uploading);
    if (!list.length) return toast("Limite de 10 fotos ou arquivo inválido.", false);
    uploading += list.length; renderPics();
    for (const file of list) {
      try { const { url } = await api("admin/uploads", { method: "POST", body: { data: await resizeToBase64(file) } }); images.push(url); dirty = true; }
      catch (err) { toast(`${file.name}: ${err.message}`, false); }
      uploading--; renderPics();
    }
  };
  $("#files").onchange = e => { addFiles(e.target.files); e.target.value = ""; };
  const drop = $("#drop");
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => editable && addFiles(e.dataTransfer.files));

  form.onsubmit = async e => {
    e.preventDefault();
    const msg = $("#msg");
    if (uploading) { msg.textContent = "Aguarde o envio das fotos."; msg.className = "msg err"; return; }
    const payload = {
      name: form.name.value, brand: form.brand.value, sku: form.sku.value, categoryId: form.categoryId.value,
      condition: form.condition.value, stockType: form.stockType.value,
      priceCents: moneyCents(form.price.value), promoPriceCents: moneyCents(form.promo.value),
      discountPixPct: form.discountPixPct.value, discountCardPct: form.discountCardPct.value,
      paymentMethods: $$("[name=pm]:checked", form).map(i => i.value),
      description: form.description.value, internalNotes: form.internalNotes.value, badge: form.badge.value,
      sellOnline: form.sellOnline.checked, state: form.state.value, published: form.published.checked,
      specs: specs.filter(s => s.k.trim() && s.v.trim()), images,
    };
    if (isNew) payload.initialEntry = { quantity: Number(form.qty.value) || 0, origin: form.origin.value, supplier: form.supplier.value, unitCostCents: moneyCents(form.unitCost.value) };
    const btn = $("#save"); btn.disabled = true;
    try {
      const r = await api(isNew ? "admin/products" : `admin/products/${id}`, { method: isNew ? "POST" : "PUT", body: payload });
      dirty = false; toast(isNew ? "Produto cadastrado." : "Alterações salvas.");
      go(`/admin/products/${r.id}`, true);
    } catch (err) { msg.textContent = err.message; msg.className = "msg err"; btn.disabled = false; }
  };
  if ($("#archive")) $("#archive").onclick = async () => {
    if (!confirm("Arquivar este produto? Ele sai do site e do catálogo, mas o histórico é mantido.")) return;
    try { await api(`admin/products/${id}/state`, { method: "POST", body: { state: "arquivado" } }); dirty = false; toast("Produto arquivado."); go("/admin/products"); }
    catch (err) { toast(err.message, false); }
  };
  if (!isNew) renderStockPanel(p);
}

function renderStockPanel(p) {
  $("#stockPanel").innerHTML = `<h3>Estoque</h3>
    <div class="stock-big" style="margin:12px 0 10px;grid-template-columns:repeat(4,1fr)">
      <div><b>${p.on_hand}</b><span>Físico</span></div><div><b>${p.reserved}</b><span>Reservado</span></div>
      <div><b class="${p.available > 0 ? "grad-text" : ""}">${p.available}</b><span>Disponível</span></div><div><b>${p.sold}</b><span>Vendido</span></div>
    </div>
    ${p.reservations.length ? `<div class="alert" style="margin-bottom:12px">Reservado por: ${p.reservations.map(r => `<a href="/admin/orders/${r.order_id}" data-link style="color:var(--orange)">pedido #${r.order_number}</a> (${r.quantity} un., vence ${dt(r.expires_at)})`).join(", ")}</div>` : ""}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      ${can("stock.entry") ? `<a class="add-btn ghost" href="/admin/stock-in?product=${p.id}" data-link>+ Entrada</a>` : ""}
      ${can("sales.physical") ? `<a class="add-btn ghost" href="/admin/sale?product=${p.id}" data-link>Venda física</a>` : ""}
      ${can("stock.adjust") ? `<button class="add-btn ghost" id="adjBtn" type="button">Ajuste</button>` : ""}
    </div>
    <form id="adj" class="form" novalidate style="display:none;margin-bottom:14px">
      <div class="f s2"><label>Qtd. (±)</label><input name="delta" type="number" step="1" placeholder="-1"></div>
      <div class="f s4"><label>Motivo</label><select name="reason">${Object.entries(ME.adjustReasons).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></div>
      <div class="f"><label>Justificativa (obrigatória)</label><input name="note" maxlength="500"></div>
      <button class="btn btn-primary btn-block" style="grid-column:span 6" type="submit">Registrar ajuste</button>
    </form>
    <h3 style="font-size:1.1rem;margin:10px 0">Histórico</h3>
    <div class="mini-hist">${p.movements.length ? p.movements.map(m => `<div>
      <span class="${m.physical_delta > 0 ? "pos" : m.physical_delta < 0 ? "neg" : ""} num">${m.physical_delta ? (m.physical_delta > 0 ? "+" : "") + m.physical_delta : `<span class="chip reserva">${m.reserved_delta > 0 ? "+" : ""}${m.reserved_delta}</span>`}</span>
      <span>${esc(MOVE[m.type])}${m.order_number ? ` · #${m.order_number}` : ""}<small>${dt(m.created_at)}${m.user_name ? " · " + esc(m.user_name) : ""}${m.note ? " · " + esc(m.note) : ""}</small></span>
      <span class="num muted-sm">${m.physical_before}→${m.physical_after}</span></div>`).join("") : `<span class="muted">Nenhuma movimentação.</span>`}</div>`;
  if ($("#adjBtn")) $("#adjBtn").onclick = () => { const f = $("#adj"); f.style.display = f.style.display === "none" ? "grid" : "none"; };
  if ($("#adj")) $("#adj").onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    try {
      await api("admin/stock/adjustments", { method: "POST", body: { productId: p.id, delta: Number(f.delta.value), reason: f.reason.value, note: f.note.value } });
      toast("Ajuste registrado."); renderStockPanel((await api(`admin/products/${p.id}`)).product);
    } catch (err) { toast(err.message, false); }
  };
}

// =====================================================================================
// Estoque
// =====================================================================================
async function pageStock() {
  const FILTERS = { "": "Todos", disponiveis: "Disponíveis", reservados: "Reservados", parcial: "Parcialmente reservados", vendidos: "Vendidos",
    sem_estoque: "Sem estoque", baixo: "Estoque baixo", novos: "Novos", usados: "Usados/revisados", ativos: "Ativos", inativos: "Inativos" };
  let f = new URLSearchParams(location.search).get("f") || "";
  shell("/admin/stock", head("Operação", "Estoque", "Físico, reservado e disponível. Atualiza sozinho a cada 30 segundos.") + `
    <div class="chips" id="chips">${Object.entries(FILTERS).map(([k, l]) => `<button data-f="${k}" class="${k === f ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="filters"><input id="q" type="search" placeholder="Pesquisar por nome ou SKU…"></div>
    <div id="alerts"></div><div id="list"><div class="empty-state">Carregando…</div></div>`);
  let timer;
  const load = async () => {
    const qs = new URLSearchParams({ q: $("#q").value });
    if (["disponiveis", "reservados", "parcial", "vendidos", "sem_estoque", "baixo"].includes(f)) qs.set("stock", f);
    if (f === "novos") qs.set("condition", "novo");
    if (f === "usados") qs.set("condition", "usado");
    if (f === "ativos") qs.set("state", "ativo");
    if (f === "inativos") qs.set("state", "inativo");
    try {
      const { products } = await api(`admin/products?${qs}`);
      const low = ME.store.settings.lowStockThreshold;
      const out = products.filter(p => p.state === "ativo" && p.on_hand === 0).length;
      const full = products.filter(p => p.reserved > 0 && p.reserved === p.on_hand).length;
      const lows = products.filter(p => p.stock_type === "quantidade" && p.available > 0 && p.available <= low).length;
      $("#alerts").innerHTML = (out || full || lows) ? `<div class="alert" style="margin-bottom:14px">${[out && `${out} sem estoque`, full && `${full} totalmente reservado(s)`, lows && `${lows} com estoque baixo (≤ ${low})`].filter(Boolean).join(" · ")}</div>` : "";
      $("#list").innerHTML = products.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr><th></th><th>Produto</th><th>Categoria</th><th>Condição</th><th>Preço</th><th>Físico</th><th>Reservado</th><th>Disponível</th><th>Status</th><th>Última mov.</th></tr></thead>
        <tbody>${products.map(p => {
          const status = p.state !== "ativo" ? STATE[p.state] : p.on_hand === 0 ? (p.sold > 0 ? "Vendido" : "Sem estoque") : p.available === 0 ? "Totalmente reservado" : p.reserved ? "Parcialmente reservado" : "Disponível";
          return `<tr class="click" data-id="${esc(p.id)}">
          <td>${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="" style="object-fit:contain">` : `<div class="thumb none">—</div>`}</td>
          <td><b>${esc(p.name)}</b><small>${esc(p.sku)}${p.published ? "" : " · não publicado"}</small></td>
          <td>${esc(p.category || "—")}</td><td>${esc(CONDITION[p.condition])}</td>
          <td class="num">${p.price_cents ? brl(p.promo_price_cents || p.price_cents) : "—"}</td>
          <td class="num">${p.on_hand}</td><td class="num">${p.reserved ? `<span class="chip reserva">${p.reserved}</span>` : "0"}</td>
          <td class="num"><b>${p.available}</b>${p.stock_type === "quantidade" && p.available > 0 && p.available <= low ? `<span class="pill-warn">baixo</span>` : ""}</td>
          <td><span class="chip ${p.available > 0 && p.state === "ativo" ? "publicado" : p.on_hand === 0 || p.state !== "ativo" ? "inativo" : "ativa"}">${status}</span></td>
          <td class="num muted-sm">${dt(p.last_movement_at)}</td></tr>`; }).join("")}</tbody></table></div>` : `<div class="empty-state"><b>Nenhum produto neste filtro</b></div>`;
      $$("tr[data-id]").forEach(tr => tr.onclick = () => go(`/admin/products/${tr.dataset.id}`));
    } catch (err) { fail($("#list"), err); }
  };
  $("#chips").onclick = e => { const b = e.target.closest("button"); if (!b) return; f = b.dataset.f; $$("#chips button").forEach(x => x.classList.toggle("on", x === b)); history.replaceState(null, "", `/admin/stock${f ? "?f=" + f : ""}`); load(); };
  $("#q").oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
  await load(); poll(load);
}

// Seletor de produto com busca por nome/SKU (usado na entrada e na venda física)
function productPicker(el, onPick, { includeArchived = false } = {}) {
  el.innerHTML = `<div class="picker"><input type="search" placeholder="Pesquisar produto por nome ou SKU…" autocomplete="off"><div class="results" style="display:none"></div></div>`;
  const input = $("input", el), box = $(".results", el);
  let timer, items = [];
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(async () => {
    if (input.value.trim().length < 2) { box.style.display = "none"; return; }
    try {
      items = (await api(`admin/products?${new URLSearchParams({ q: input.value.trim(), ...(includeArchived ? { includeArchived: 1 } : {}) })}`)).products.slice(0, 15);
      box.innerHTML = items.length ? items.map((p, i) => `<button type="button" data-i="${i}">${p.image ? `<img src="${esc(p.image)}" alt="">` : ""}<span><b>${esc(p.name)}</b><br><small class="muted">${esc(p.sku)} · físico ${p.on_hand} · reservado ${p.reserved} · disponível ${p.available}</small></span></button>`).join("") : `<div style="padding:12px" class="muted">Nenhum produto encontrado.</div>`;
      box.style.display = "block";
    } catch (err) { toast(err.message, false); }
  }, 250); };
  box.onclick = e => { const b = e.target.closest("button"); if (!b) return; box.style.display = "none"; input.value = ""; onPick(items[+b.dataset.i]); };
}
const productCard = p => `<div class="sel-product">${p.image ? `<img src="${esc(p.image)}" alt="">` : ""}<div style="flex:1"><b>${esc(p.name)}</b><br><small class="muted">${esc(p.sku)} · ${esc(CONDITION[p.condition])} · ${p.stock_type === "unico" ? "produto único" : "várias unidades"}</small><br>
  <small>Físico <b>${p.on_hand}</b> · Reservado <b>${p.reserved}</b> · Disponível <b>${p.available}</b></small></div></div>`;
async function productById(id) { const p = (await api(`admin/products/${encodeURIComponent(id)}`)).product; return { ...p, image: p.images[0] }; }

// =====================================================================================
// Entrada de mercadoria
// =====================================================================================
async function pageStockIn() {
  shell("/admin/stock-in", head("Estoque", "Entrada de mercadoria", "Registre a chegada de um equipamento. O site é atualizado na hora.", can("products.write") ? `<a href="/admin/products/new" data-link class="btn btn-ghost">+ Cadastrar produto novo</a>` : "") + `
    <div class="sheet"><section class="panel"><h3>Produto</h3><div id="pick" style="margin:12px 0"></div><div id="sel"></div>
      <form id="f" class="form" novalidate style="margin-top:18px;display:none">
        <div class="f s2"><label>Quantidade recebida *</label><input name="quantity" type="number" min="1" step="1" value="1"></div>
        <div class="f s2"><label>Data *</label><input name="date" type="date" value="${today()}" max="${today()}"></div>
        <div class="f s2"><label>Origem *</label><select name="origin">${Object.entries(ME.entryOrigins).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></div>
        <div class="f s3"><label>Fornecedor / de quem foi comprado</label><input name="supplier" maxlength="120"></div>
        <div class="f s3"><label>Custo de aquisição (unit., opcional)</label><div class="prefix"><span>R$</span><input name="unitCost" class="money" inputmode="numeric"></div></div>
        <div class="f s3"><label>Documento (NF, recibo)</label><input name="document" maxlength="60"></div>
        <div class="f s3"><label>Observação</label><input name="note" maxlength="500"></div>
        <button class="btn btn-primary btn-block" style="grid-column:span 6" type="submit">Confirmar entrada</button>
      </form><div id="result"></div></section>
      <div class="side-col"><section class="panel"><h3>Como funciona</h3><p class="muted" style="font-size:.88rem;margin-top:8px">A entrada soma ao estoque <b>físico</b>, fica registrada no histórico com seu usuário e libera o produto no site (se estiver ativo e publicado). Produto único aceita no máximo 1 unidade.</p></section></div></div>`);
  let sel = null;
  const f = $("#f");
  $$(".money", f).forEach(i => i.addEventListener("input", () => { const c = moneyCents(i.value); i.value = c == null ? "" : moneyStr(c); }));
  const pick = p => { sel = p; $("#sel").innerHTML = productCard(p); f.style.display = "grid"; $("#result").innerHTML = ""; f.quantity.max = p.stock_type === "unico" ? 1 : 100000; f.quantity.focus(); };
  productPicker($("#pick"), pick);
  const pre = new URLSearchParams(location.search).get("product");
  if (pre) { try { pick(await productById(pre)); } catch (err) { toast(err.message, false); } }
  f.onsubmit = async e => {
    e.preventDefault(); if (!sel) return;
    const btn = $("button[type=submit]", f); btn.disabled = true;
    try {
      const { movement } = await api("admin/stock/entries", { method: "POST", body: { productId: sel.id, quantity: Number(f.quantity.value), origin: f.origin.value,
        date: f.date.value, supplier: f.supplier.value, unitCostCents: moneyCents(f.unitCost.value), document: f.document.value, note: f.note.value } });
      $("#result").innerHTML = `<div class="alert" style="margin-top:14px;display:flex;color:var(--green);border-color:rgba(37,211,102,.4);background:rgba(37,211,102,.08)">✓ Entrada registrada: estoque físico ${movement.physical_before} → <b>${movement.physical_after}</b>. Disponível: ${movement.available}.</div>`;
      toast("Entrada registrada."); sel = await productById(sel.id); $("#sel").innerHTML = productCard(sel); f.reset(); f.date.value = today();
    } catch (err) { toast(err.message, false); }
    btn.disabled = false;
  };
}

// =====================================================================================
// Registrar venda física
// =====================================================================================
async function pageSale() {
  shell("/admin/sale", head("Balcão", "Registrar venda física", "Pesquise o produto, informe a quantidade, confira e confirme.") + `
    <div class="sheet"><section class="panel"><h3>1. Produtos</h3><div id="pick" style="margin:12px 0"></div><div id="lines"></div></section>
      <div class="side-col"><section class="panel"><h3>2. Conferir e confirmar</h3>
        <form id="f" class="form" novalidate style="margin-top:12px">
          <div class="f"><label>Forma de pagamento</label><select name="paymentMethod">${Object.entries(SALE_PAY).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></div>
          <div class="f"><label>Cliente (opcional)</label><input name="customerName" maxlength="120"></div>
          <div class="f"><label>Observação</label><input name="note" maxlength="500"></div>
          <div class="sum-row total" style="grid-column:span 6"><span>Total</span><b id="total">R$ 0,00</b></div>
          <button class="btn btn-primary btn-block" style="grid-column:span 6" type="submit" id="confirm" disabled>Confirmar venda</button>
        </form><div id="warn"></div></section></div></div>`);
  const lines = [];
  const render = () => {
    $("#lines").innerHTML = lines.length ? lines.map((l, i) => `<div class="sel-product" style="margin-bottom:10px">${l.p.image ? `<img src="${esc(l.p.image)}" alt="">` : ""}
      <div style="flex:1"><b>${esc(l.p.name)}</b><br><small class="muted">${esc(l.p.sku)} · disponível ${l.p.available}${l.p.reserved ? ` · <span class="pill-warn">${l.p.reserved} reservado(s)</span>` : ""}</small><br><small>${brl(l.p.promo_price_cents || l.p.price_cents || 0)} un.</small></div>
      <input type="number" min="1" max="${l.p.stock_type === "unico" ? 1 : l.p.on_hand}" value="${l.q}" data-q="${i}" style="width:80px;padding:10px;border-radius:10px;background:var(--bg-2);border:1.5px solid var(--line)">
      <button class="add-btn ghost" data-rm="${i}" type="button">✕</button></div>`).join("") : `<p class="muted">Nenhum produto selecionado.</p>`;
    $("#total").textContent = brl(lines.reduce((s, l) => s + (l.p.promo_price_cents || l.p.price_cents || 0) * l.q, 0));
    $("#confirm").disabled = !lines.length;
    $("#warn").innerHTML = "";
  };
  const add = p => {
    if (lines.some(l => l.p.id === p.id)) return toast("Produto já está na venda.", false);
    if (p.on_hand < 1) return toast("Sem estoque físico.", false);
    lines.push({ p, q: 1 }); render();
  };
  productPicker($("#pick"), add);
  const pre = new URLSearchParams(location.search).get("product");
  if (pre) { try { add(await productById(pre)); } catch {} }
  render();
  $("#lines").addEventListener("input", e => { if (e.target.dataset.q) { lines[+e.target.dataset.q].q = Math.max(1, parseInt(e.target.value) || 1); $("#total").textContent = brl(lines.reduce((s, l) => s + (l.p.promo_price_cents || l.p.price_cents || 0) * l.q, 0)); } });
  $("#lines").addEventListener("click", e => { const b = e.target.closest("[data-rm]"); if (b) { lines.splice(+b.dataset.rm, 1); render(); } });

  const submit = async (override = null) => {
    const f = $("#f"), btn = $("#confirm"); btn.disabled = true;
    try {
      const { sale } = await api("admin/sales", { method: "POST", body: { items: lines.map(l => ({ productId: l.p.id, quantity: l.q })),
        paymentMethod: f.paymentMethod.value, customerName: f.customerName.value, note: f.note.value, ...(override ? { override } : {}) } });
      toast(`Venda #${sale.number} registrada (${brl(sale.total_cents)}).`);
      $("#warn").innerHTML = `<div class="alert" style="margin-top:14px;display:flex;color:var(--green);border-color:rgba(37,211,102,.4);background:rgba(37,211,102,.08)">✓ Venda #${sale.number} registrada. Estoque e site atualizados.${sale.affectedOrders?.length ? ` Pedidos online cancelados: ${sale.affectedOrders.map(n => "#" + n).join(", ")} (ocorrência criada para avisar o cliente).` : ""}</div>`;
      lines.length = 0; $("#lines").innerHTML = `<p class="muted">Nenhum produto selecionado.</p>`; $("#total").textContent = "R$ 0,00"; f.reset();
    } catch (err) {
      btn.disabled = false;
      if (err.data?.code === "RESERVED") {
        $("#warn").innerHTML = `<div class="danger-box"><b>Atenção: existe reserva ativa.</b><p class="muted" style="margin:6px 0 10px;font-size:.88rem">${esc(err.message)}</p>
          ${can("sales.override") ? `<p style="font-size:.85rem;margin-bottom:8px">Para vender mesmo assim, informe o motivo. A reserva e o pedido online serão <b>cancelados</b>, com registro na auditoria e uma ocorrência para avisar o cliente.</p>
          <textarea id="ovReason" maxlength="300" placeholder="Motivo da exceção (obrigatório)" style="width:100%;min-height:70px;padding:10px;border-radius:10px;background:var(--bg-2);border:1.5px solid var(--line);color:inherit"></textarea>
          <button class="btn btn-ghost btn-block" id="ovBtn" style="margin-top:10px;border-color:#ff6b5e;color:#ff8a80">Vender mesmo assim (exceção autorizada)</button>` : `<p style="font-size:.85rem">Somente proprietário ou administrador pode autorizar esta exceção.</p>`}</div>`;
        if ($("#ovBtn")) $("#ovBtn").onclick = () => { const r = $("#ovReason").value.trim(); if (!r) return toast("Informe o motivo.", false); if (confirm("Confirmar a exceção? O pedido online será cancelado.")) submit({ reason: r }); };
      } else toast(err.message, false);
    }
  };
  $("#f").onsubmit = e => { e.preventDefault(); if (confirm(`Confirmar venda de ${lines.reduce((s, l) => s + l.q, 0)} item(ns) por ${$("#total").textContent}?`)) submit(); };
}

// =====================================================================================
// Reservas
// =====================================================================================
async function pageReservations() {
  let st = "ativa", expiring = false;
  shell("/admin/reservations", head("Loja digital", "Reservas", "Reservas criadas por pedidos online. O carrinho do cliente não reserva nada — só o pedido confirmado.") + `
    <div class="chips" id="chips"><button data-s="ativa" class="on">Ativas</button><button data-s="expiring">Vencendo (6h)</button><button data-s="convertida">Convertidas em venda</button><button data-s="expirada">Expiradas</button><button data-s="cancelada">Canceladas</button><button data-s="">Todas</button></div>
    <div id="list"><div class="empty-state">Carregando…</div></div>`);
  const load = async () => {
    const qs = new URLSearchParams(expiring ? { expiring: 1 } : { status: st });
    try {
      const { reservations } = await api(`admin/reservations?${qs}`);
      $("#list").innerHTML = reservations.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Produto</th><th>Qtd.</th><th>Pedido</th><th>Criada</th><th>Vence em</th><th>Reserva</th><th>Pedido / pagamento</th></tr></thead>
        <tbody>${reservations.map(r => `<tr class="click" data-o="${esc(r.order_id)}"><td><b>${esc(r.name)}</b><small>${esc(r.sku)}</small></td><td class="num">${r.quantity}</td><td>#${r.number}</td>
          <td class="num">${dt(r.created_at)}</td><td>${r.status === "ativa" ? `${dt(r.expires_at)}<br>${left(r.expires_at)}` : `<small class="muted">${dt(r.released_at)}<br>${esc(r.release_reason || "")}</small>`}</td>
          <td><span class="chip ${r.status}">${RES[r.status]}</span></td><td><span class="chip ${r.order_status}">${ORDER[r.order_status]}</span> <span class="chip ${r.payment_status}">${PAY[r.payment_status]}</span></td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty-state"><b>Nenhuma reserva neste filtro</b></div>`;
      $$("tr[data-o]").forEach(tr => tr.onclick = () => go(`/admin/orders/${tr.dataset.o}`));
    } catch (err) { fail($("#list"), err); }
  };
  $("#chips").onclick = e => { const b = e.target.closest("button"); if (!b) return; expiring = b.dataset.s === "expiring"; st = expiring ? "" : b.dataset.s; $$("#chips button").forEach(x => x.classList.toggle("on", x === b)); load(); };
  await load(); poll(load);
}

// =====================================================================================
// Pedidos online + acompanhamento da loja digital
// =====================================================================================
async function pageOrders() {
  const params = new URLSearchParams(location.search);
  let tab = params.get("tab") || "tracking", st = params.get("status") || "";
  if (params.get("status")) tab = "list";
  shell("/admin/orders", head("Loja digital", "Pedidos online") + `
    <div class="tabs"><button data-t="tracking">Acompanhamento</button><button data-t="list">Pedidos</button><button data-t="loja">Vendas físicas</button></div>
    <div id="body"><div class="empty-state">Carregando…</div></div>`);
  const tabsEl = $(".tabs");
  const setTab = t => { tab = t; $$("button", tabsEl).forEach(b => b.classList.toggle("on", b.dataset.t === t)); load(); };
  tabsEl.onclick = e => { const b = e.target.closest("button"); if (b) setTab(b.dataset.t); };

  const load = async () => {
    const body = $("#body");
    try {
      if (tab === "tracking") {
        const { rows, issues } = await api("admin/tracking");
        const group = (title, filter, hint) => { const r = rows.filter(filter); return `<section class="panel" style="margin-bottom:16px"><h3>${title} <span class="muted-sm">(${r.length})</span></h3>${hint ? `<p class="hint">${hint}</p>` : ""}
          ${r.length ? `<div class="tbl-wrap" style="border:0"><table class="tbl"><thead><tr><th>Produto</th><th>SKU</th><th>Qtd.</th><th>Pedido</th><th>Data</th><th>Status</th><th>Prazo da reserva</th></tr></thead><tbody>
          ${r.map(x => `<tr class="click" data-o="${esc(x.order_id)}"><td><b>${esc(x.name)}</b></td><td>${esc(x.sku)}</td><td class="num">${x.quantity}</td><td>#${x.number}</td><td class="num">${dt(x.created_at)}</td>
          <td><span class="chip ${x.status}">${ORDER[x.status]}</span> <span class="chip ${x.payment_status}">${PAY[x.payment_status]}</span></td>
          <td>${x.reservation_status === "ativa" ? `${dt(x.expires_at)} ${left(x.expires_at)}` : x.reservation_status ? `<span class="chip ${x.reservation_status}">${RES[x.reservation_status]}</span>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Nada aqui.</p>`}</section>`; };
        const soon = x => x.reservation_status === "ativa" && new Date(x.expires_at) - Date.now() < 6 * 3600000;
        body.innerHTML = `
          ${issues.length ? `<section class="panel" style="margin-bottom:16px;border-color:rgba(255,107,94,.5)"><h3>Ocorrências que precisam de intervenção (${issues.length})</h3>
            ${issues.map(i => `<div class="sel-product" style="margin-top:10px"><div style="flex:1"><b>${esc(i.type.replace(/_/g, " "))}</b>${i.number ? ` · <a href="/admin/orders/${i.order_id}" data-link style="color:var(--orange)">pedido #${i.number}</a>` : ""}<br><small class="muted">${dt(i.created_at)} · ${esc(i.description)}</small></div>
            ${can("issues.resolve") ? `<button class="add-btn ghost" data-resolve="${esc(i.id)}">Resolver</button>` : ""}</div>`).join("")}</section>` : ""}
          <p class="muted-sm" style="margin-bottom:12px">Produtos apenas no carrinho de um cliente <b>não</b> aparecem aqui — só itens de pedidos criados (com reserva).</p>
          ${group("Reservas vencendo (6h)", soon)}
          ${group("Aguardando pagamento (reservados)", x => x.status === "aguardando_pagamento" && !soon(x))}
          ${group("Pagos / em processamento", x => ["pago", "em_processamento"].includes(x.status))}
          ${group("Vendas concluídas (30 dias)", x => x.status === "concluido")}
          ${group("Reservas expiradas (30 dias)", x => x.status === "expirado")}
          ${group("Cancelados / estornados (30 dias)", x => ["cancelado", "estornado"].includes(x.status))}`;
        $$("[data-resolve]").forEach(b => b.onclick = async () => {
          const resolution = prompt("Como a ocorrência foi resolvida? (ex.: reembolso feito em 12/10)"); if (!resolution) return;
          try { await api(`admin/issues/${b.dataset.resolve}/resolve`, { method: "POST", body: { resolution } }); toast("Ocorrência resolvida."); load(); } catch (err) { toast(err.message, false); }
        });
      } else {
        const channel = tab === "loja" ? "loja" : "online";
        const STF = tab === "loja" ? {} : { "": "Todos", aguardando_pagamento: "Aguardando pagamento", pago: "Pagos", em_processamento: "Em processamento", concluido: "Concluídos", cancelado: "Cancelados", expirado: "Expirados", estornado: "Estornados" };
        const { orders } = await api(`admin/orders?${new URLSearchParams({ channel, status: tab === "loja" ? "" : st })}`);
        body.innerHTML = `${tab === "list" ? `<div class="chips" id="stc">${Object.entries(STF).map(([k, l]) => `<button data-s="${k}" class="${k === st ? "on" : ""}">${l}</button>`).join("")}</div>` : ""}
          ${orders.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Pedido</th><th>Data</th><th>Cliente</th><th>Itens</th><th>Total</th><th>Pedido</th><th>Pagamento</th><th>Reserva até</th></tr></thead>
          <tbody>${orders.map(o => `<tr class="click" data-o="${esc(o.id)}"><td><b>#${o.number}</b>${o.open_issues ? `<span class="pill-bad">ocorrência</span>` : ""}</td><td class="num">${dt(o.created_at)}</td><td>${esc(o.customer || (o.channel === "loja" ? "Balcão" : "—"))}</td>
            <td class="num">${o.items}</td><td class="num">${brl(o.total_cents)}</td><td><span class="chip ${o.status}">${ORDER[o.status]}</span></td><td><span class="chip ${o.payment_status}">${PAY[o.payment_status]}</span></td>
            <td>${o.status === "aguardando_pagamento" && o.reserved_until ? `${dt(o.reserved_until)} ${left(o.reserved_until)}` : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><b>Nenhum pedido</b></div>`}`;
        if ($("#stc")) $("#stc").onclick = e => { const b = e.target.closest("button"); if (!b) return; st = b.dataset.s; load(); };
      }
      $$("tr[data-o]").forEach(tr => tr.onclick = () => go(`/admin/orders/${tr.dataset.o}`));
    } catch (err) { fail(body, err); }
  };
  setTab(tab); poll(load);
}

async function pageOrder(id) {
  shell("/admin/orders", `<div class="empty-state">Carregando…</div>`);
  let o;
  try { o = (await api(`admin/orders/${encodeURIComponent(id)}`)).order; } catch (err) { return fail($(".main"), err); }
  $(".main").innerHTML = `${head(o.channel === "loja" ? "Venda física" : "Pedido online", `Pedido #${o.number}`, `Criado em ${dt(o.created_at)}${o.created_by_name ? " por " + esc(o.created_by_name) : ""}`, `<a href="/admin/orders" data-link class="btn btn-ghost">← Pedidos</a>`)}
    <div class="sheet"><div style="display:grid;gap:20px">
      <section class="panel"><h3>Itens (dados no momento da compra)</h3>
        <table class="tbl" style="min-width:0;margin-top:10px"><thead><tr><th>Produto</th><th>SKU</th><th>Qtd.</th><th>Unitário</th><th>Total</th></tr></thead>
        <tbody>${o.items.map(i => `<tr><td><a href="/admin/products/${i.product_id}" data-link>${esc(i.name)}</a></td><td>${esc(i.sku)}</td><td class="num">${i.quantity}</td><td class="num">${brl(i.unit_price_cents)}</td><td class="num">${brl(i.total_cents)}</td></tr>`).join("")}</tbody></table>
        <div class="sum-row" style="margin-top:10px"><span>Subtotal</span><span>${brl(o.subtotal_cents)}</span></div>
        ${o.discount_cents ? `<div class="sum-row"><span>Desconto (${esc(o.payment_method)})</span><span class="disc">− ${brl(o.discount_cents)}</span></div>` : ""}
        <div class="sum-row total"><span>Total</span><b>${brl(o.total_cents)}</b></div></section>
      ${o.reservations.length ? `<section class="panel"><h3>Reservas</h3><table class="tbl" style="min-width:0;margin-top:10px"><tbody>${o.reservations.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.quantity} un.</td><td><span class="chip ${r.status}">${RES[r.status]}</span></td><td>${r.status === "ativa" ? `vence ${dt(r.expires_at)} ${left(r.expires_at)}` : `<small class="muted">${dt(r.released_at)} · ${esc(r.release_reason || "")}</small>`}</td></tr>`).join("")}</tbody></table></section>` : ""}
      <section class="panel"><h3>Movimentações ligadas ao pedido</h3><table class="tbl" style="min-width:0;margin-top:10px"><tbody>${o.movements.map(m => `<tr><td>${dt(m.created_at)}</td><td>${esc(MOVE[m.type])}</td><td>${esc(m.product_name)}</td><td class="num">${m.physical_delta ? `físico ${m.physical_before}→${m.physical_after}` : `reservado ${m.reserved_before}→${m.reserved_after}`}</td></tr>`).join("") || `<tr><td class="muted">Nenhuma.</td></tr>`}</tbody></table></section>
    </div>
    <div class="side-col">
      <section class="panel"><h3>Situação</h3>
        <div class="sum-row"><span>Pedido</span><span class="chip ${o.status}">${ORDER[o.status]}</span></div>
        <div class="sum-row"><span>Pagamento</span><span class="chip ${o.payment_status}">${PAY[o.payment_status]}</span></div>
        ${o.reserved_until && o.status === "aguardando_pagamento" ? `<div class="sum-row"><span>Reserva até</span><span>${dt(o.reserved_until)}</span></div>` : ""}
        <div class="sum-row"><span>Entrega</span><span>${esc(o.delivery || "—")}</span></div>
        ${o.payments.length ? `<p class="muted-sm" style="margin-top:8px">${o.payments.map(p => `${esc(p.provider)}: ${esc(PAY[p.status])}${p.external_id ? ` (${esc(p.external_id)})` : ""}`).join("<br>")}</p>` : ""}
        <p class="muted-sm" style="margin-top:10px">${o.channel === "online" ? "O pagamento online só muda pela integração com o provedor (etapa 3) — não pode ser aprovado manualmente." : ""}</p>
        <div style="display:grid;gap:8px;margin-top:12px">
          ${can("orders.manage") && o.status === "pago" ? `<button class="btn btn-primary" data-adv="em_processamento">Marcar em processamento</button>` : ""}
          ${can("orders.manage") && ["pago", "em_processamento"].includes(o.status) ? `<button class="btn btn-ghost" data-adv="concluido">Marcar concluído (entregue/retirado)</button>` : ""}
          ${can("orders.manage") && o.status === "aguardando_pagamento" ? `<button class="btn btn-ghost" id="cancel" style="border-color:#ff6b5e;color:#ff8a80">Cancelar pedido e liberar reserva</button>` : ""}
        </div></section>
      ${o.customer_name ? `<section class="panel"><h3>Cliente</h3><p style="margin-top:8px">${esc(o.customer_name)}<br><span class="muted-sm">${esc(o.customer_email || "")}<br>${esc(o.customer_phone || "")}<br>${esc(o.customer_document || "")}</span></p>
        ${o.address ? `<p class="muted-sm" style="margin-top:8px">${esc(o.address.street)}, ${esc(o.address.number)} ${esc(o.address.comp || "")} — ${esc(o.address.district)}, ${esc(o.address.city)}/${esc(o.address.uf)} · ${esc(o.address.cep)}</p>` : ""}</section>` : ""}
      ${o.note ? `<section class="panel"><h3>Observações</h3><p class="muted-sm" style="white-space:pre-line;margin-top:8px">${esc(o.note)}</p></section>` : ""}
      ${o.issues.length ? `<section class="panel"><h3>Ocorrências</h3>${o.issues.map(i => `<p style="margin-top:8px"><span class="chip ${i.status === "aberta" ? "cancelado" : "concluido"}">${i.status}</span> <small>${esc(i.description)}${i.resolution ? `<br><b>Resolução:</b> ${esc(i.resolution)}` : ""}</small></p>`).join("")}</section>` : ""}
    </div></div>`;
  $$("[data-adv]").forEach(b => b.onclick = async () => { try { await api(`admin/orders/${id}/advance`, { method: "POST", body: { status: b.dataset.adv } }); toast("Pedido atualizado."); pageOrder(id); } catch (err) { toast(err.message, false); } });
  if ($("#cancel")) $("#cancel").onclick = async () => {
    const reason = prompt("Motivo do cancelamento (obrigatório):"); if (!reason) return;
    try { await api(`admin/orders/${id}/cancel`, { method: "POST", body: { reason } }); toast("Pedido cancelado e reserva liberada."); pageOrder(id); } catch (err) { toast(err.message, false); }
  };
}

// =====================================================================================
// Histórico de movimentações
// =====================================================================================
async function pageMovements() {
  shell("/admin/movements", head("Estoque", "Histórico de movimentações", "Nada é apagado: correções entram como novos movimentos com justificativa.") + `
    <div class="filters">
      <input id="q" type="search" placeholder="Produto ou SKU…">
      <select id="ft"><option value="">Todos os tipos</option>${Object.entries(MOVE).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <select id="fk"><option value="">Físico e reservas</option><option value="fisico">Só movimentos físicos</option><option value="reserva">Só eventos de reserva</option></select>
      <input id="from" type="date" title="De"><input id="to" type="date" title="Até">
    </div><div id="list"><div class="empty-state">Carregando…</div></div>`);
  let timer;
  const load = async () => {
    const qs = new URLSearchParams({ q: $("#q").value, type: $("#ft").value, kind: $("#fk").value, from: $("#from").value, to: $("#to").value });
    try {
      const { movements } = await api(`admin/movements?${qs}`);
      $("#list").innerHTML = movements.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Data e hora</th><th>Produto</th><th>Tipo</th><th>Qtd.</th><th>Físico antes → depois</th><th>Reservado</th><th>Usuário</th><th>Pedido</th><th>Origem</th><th>Observação</th></tr></thead>
        <tbody>${movements.map(m => `<tr><td class="num">${dt(m.created_at)}${m.movement_date ? `<small>ref. ${new Date(m.movement_date + "T12:00").toLocaleDateString("pt-BR")}</small>` : ""}</td>
          <td><a href="/admin/products/${m.product_id}" data-link><b>${esc(m.product_name)}</b></a><small>${esc(m.sku)}</small></td>
          <td>${m.physical_delta ? esc(MOVE[m.type]) : `<span class="chip reserva">${esc(MOVE[m.type])}</span>`}<small>${esc(m.reason)}</small></td>
          <td class="num ${m.physical_delta > 0 ? "pos" : m.physical_delta < 0 ? "neg" : ""}">${m.quantity}</td>
          <td class="num">${m.physical_before} → ${m.physical_after}</td><td class="num">${m.reserved_before ?? 0} → ${m.reserved_after ?? 0}</td>
          <td>${esc(m.user_name || "Sistema")}</td><td>${m.order_number ? `<a href="/admin/orders/${m.order_id}" data-link>#${m.order_number}</a>` : "—"}</td>
          <td>${esc(m.origin)}${m.supplier ? `<small>${esc(m.supplier)}</small>` : ""}</td>
          <td><small>${esc(m.note || "")}${m.document ? ` · ${esc(m.document)}` : ""}${m.unit_cost_cents != null ? ` · custo ${brl(m.unit_cost_cents)}` : ""}</small></td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty-state"><b>Nenhuma movimentação</b></div>`;
    } catch (err) { fail($("#list"), err); }
  };
  $("#q").oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
  ["#ft", "#fk", "#from", "#to"].forEach(s => $(s).onchange = load);
  load();
}

// =====================================================================================
// Configurações (loja + categorias)
// =====================================================================================
async function pageSettings() {
  const edit = can("settings.write"), catEdit = can("categories.write");
  shell("/admin/settings", head("Loja", "Configurações") + `<div class="grid2">
    <section class="panel"><h3>Loja e reservas</h3><form id="sf" class="form" novalidate style="margin-top:12px"><fieldset ${edit ? "" : "disabled"} style="border:0;display:contents">
      <div class="f"><label>Nome da loja</label><input name="name" maxlength="80"></div>
      <div class="f s3"><label>Prazo da reserva (horas)</label><input name="reservationHours" type="number" min="1" max="168"></div>
      <div class="f s3"><label>Aviso de estoque baixo (≤)</label><input name="lowStockThreshold" type="number" min="0" max="1000"></div>
      <div class="f"><label>WhatsApp da loja</label><input name="whatsapp" maxlength="20"></div>
      ${edit ? `<button class="btn btn-primary btn-block" style="grid-column:span 6" type="submit">Salvar</button>` : ""}</fieldset></form></section>
    <section class="panel"><h3>Categorias</h3><div id="cats" style="margin-top:10px"></div>
      ${catEdit ? `<form id="cf" class="form" novalidate style="margin-top:14px"><div class="f s4"><label id="cl">Nova categoria</label><input name="name" maxlength="60"></div><div class="f s2"><label>Ordem</label><input name="position" type="number" min="0" value="0"></div>
        <div class="f"><label>Descrição</label><input name="description" maxlength="300"></div><label class="check f s3" style="color:var(--text)"><input type="checkbox" name="active" checked> Ativa</label>
        <button class="btn btn-primary" style="grid-column:span 3" type="submit">Salvar categoria</button></form>` : ""}</section></div>`);
  try {
    const { store, settings } = await api("admin/settings");
    const f = $("#sf"); f.name.value = store.name; f.reservationHours.value = settings.reservationHours; f.lowStockThreshold.value = settings.lowStockThreshold; f.whatsapp.value = settings.whatsapp || "";
    f.onsubmit = async e => { e.preventDefault(); try { await api("admin/settings", { method: "PUT", body: { name: f.name.value, reservationHours: Number(f.reservationHours.value), lowStockThreshold: Number(f.lowStockThreshold.value), whatsapp: f.whatsapp.value } }); toast("Configurações salvas."); await loadMe(); } catch (err) { toast(err.message, false); } };
  } catch (err) { toast(err.message, false); }
  let editing = null;
  const loadCats = async () => {
    CATS = (await api("admin/categories")).categories;
    $("#cats").innerHTML = `<table class="tbl" style="min-width:0"><tbody>${CATS.map(c => `<tr class="${catEdit ? "click" : ""}" data-id="${esc(c.id)}"><td><b>${esc(c.name)}</b><small>${esc(c.description || "")}</small></td><td class="num">${c.products} prod.</td><td><span class="chip ${c.active ? "publicado" : "inativo"}">${c.active ? "Ativa" : "Inativa"}</span></td></tr>`).join("")}</tbody></table>`;
    if (catEdit) $$("#cats tr").forEach(tr => tr.onclick = () => { const c = CATS.find(x => x.id === tr.dataset.id); editing = c.id; const cf = $("#cf"); cf.name.value = c.name; cf.position.value = c.position; cf.description.value = c.description || ""; cf.active.checked = c.active; $("#cl").textContent = "Editar categoria"; });
  };
  await loadCats();
  if ($("#cf")) $("#cf").onsubmit = async e => {
    e.preventDefault(); const cf = e.target;
    try { await api(editing ? `admin/categories/${editing}` : "admin/categories", { method: editing ? "PUT" : "POST", body: { name: cf.name.value, position: cf.position.value, description: cf.description.value, active: cf.active.checked } });
      toast("Categoria salva."); editing = null; cf.reset(); $("#cl").textContent = "Nova categoria"; loadCats(); } catch (err) { toast(err.message, false); }
  };
}

// =====================================================================================
// Usuários e permissões
// =====================================================================================
async function pageUsers() {
  shell("/admin/users", head("Acesso", "Usuários e permissões", "Novos usuários entram somente por convite enviado por e-mail.") + `<div class="grid2">
    <section class="panel"><h3>Usuários</h3><div id="users" style="margin-top:10px"></div></section>
    <section class="panel"><h3>Convidar</h3><form id="inv" class="form" novalidate style="margin-top:12px">
      <div class="f s4"><label>E-mail</label><input name="email" type="email"></div>
      <div class="f s2"><label>Função</label><select name="role">${["vendedor", "estoque", ...(ME.user.role === "owner" ? ["admin"] : [])].map(r => `<option value="${r}">${ROLE[r]}</option>`).join("")}</select></div>
      <button class="btn btn-primary" style="grid-column:span 6" type="submit">Enviar convite</button></form>
      <p class="muted-sm" style="margin-top:10px"><b>Vendedor:</b> vendas físicas e pedidos. <b>Estoque:</b> produtos, fotos e entradas. <b>Administrador:</b> tudo, exceto alterar o proprietário.</p>
      <h3 style="font-size:1.1rem;margin-top:18px">Convites pendentes</h3><div id="invites"></div></section></div>`);
  const load = async () => {
    const { users, invites } = await api("admin/users");
    $("#users").innerHTML = `<table class="tbl" style="min-width:0"><tbody>${users.map(u => `<tr><td><b>${esc(u.name)}</b><small>${esc(u.email)} · ${u.verified ? "e-mail confirmado" : "e-mail não confirmado"} · último acesso ${dt(u.last_login_at)}</small></td>
      <td>${u.role === "owner" || u.id === ME.user.id ? `<span class="chip">${ROLE[u.role]}</span>` : `<select data-role="${esc(u.id)}">${["vendedor", "estoque", "admin"].map(r => `<option value="${r}" ${r === u.role ? "selected" : ""} ${r === "admin" && ME.user.role !== "owner" ? "disabled" : ""}>${ROLE[r]}</option>`).join("")}</select>`}</td>
      <td>${u.role === "owner" || u.id === ME.user.id ? "" : `<button class="add-btn ghost" data-active="${esc(u.id)}" data-v="${u.active ? 0 : 1}">${u.active ? "Desativar" : "Reativar"}</button>`}</td></tr>`).join("")}</tbody></table>`;
    $("#invites").innerHTML = invites.length ? invites.map(i => `<div class="sum-row"><span>${esc(i.email)} · ${ROLE[i.role]}<br><small class="muted">expira ${dt(i.expires_at)}</small></span><button class="add-btn ghost" data-revoke="${esc(i.id)}">Revogar</button></div>`).join("") : `<p class="muted">Nenhum convite pendente.</p>`;
    $$("[data-role]").forEach(s => s.onchange = async () => { try { await api(`admin/users/${s.dataset.role}`, { method: "PUT", body: { role: s.value } }); toast("Função alterada."); } catch (err) { toast(err.message, false); load(); } });
    $$("[data-active]").forEach(b => b.onclick = async () => { try { await api(`admin/users/${b.dataset.active}`, { method: "PUT", body: { active: b.dataset.v === "1" } }); toast("Acesso atualizado."); load(); } catch (err) { toast(err.message, false); } });
    $$("[data-revoke]").forEach(b => b.onclick = async () => { try { await api(`admin/invites/${b.dataset.revoke}/revoke`, { method: "POST" }); toast("Convite revogado."); load(); } catch (err) { toast(err.message, false); } });
  };
  $("#inv").onsubmit = async e => { e.preventDefault(); const f = e.target; try { await api("admin/invites", { method: "POST", body: { email: f.email.value, role: f.role.value } }); toast("Convite enviado por e-mail."); f.reset(); load(); } catch (err) { toast(err.message, false); } };
  load().catch(err => toast(err.message, false));
}

// =====================================================================================
// Roteador
// =====================================================================================
async function loadMe() {
  ME = await api("auth/me");
  CATS = (await api("admin/categories")).categories;
}

const PUBLIC = { "/admin/login": pageLogin, "/admin/register": pageRegister, "/admin/verify-email": pageVerify, "/admin/forgot-password": pageForgot, "/admin/setup": pageSetup };

async function render() {
  timers.forEach(clearInterval); timers = [];
  window.scrollTo(0, 0);
  const path = location.pathname.replace(/\/+$/, "") || "/admin";
  if (PUBLIC[path]) return PUBLIC[path]();
  if (!ME) {
    try { await loadMe(); }
    catch (err) {
      if (err.data?.code === "EMAIL_NOT_VERIFIED") return go("/admin/verify-email", true);
      if (err.status !== 401) root.innerHTML = `<div class="auth"><div class="box"><h1>Painel indisponível</h1><p class="sub">${esc(err.message)}</p></div></div>`;
      return;
    }
  }
  const m = path.match(/^\/admin\/(products|orders)\/([\w-]+)$/);
  if (m && m[1] === "products") return m[2] === "new" ? (can("products.write") ? pageProduct(null) : go("/admin/products", true)) : pageProduct(m[2]);
  if (m && m[1] === "orders") return pageOrder(m[2]);
  const pages = { "/admin/dashboard": pageDashboard, "/admin/products": pageProducts, "/admin/stock": pageStock, "/admin/stock-in": pageStockIn,
    "/admin/sale": pageSale, "/admin/reservations": pageReservations, "/admin/orders": pageOrders, "/admin/movements": pageMovements,
    "/admin/settings": pageSettings, "/admin/users": pageUsers };
  const page = pages[path];
  const need = NAV.find(n => n[0] === path)?.[2];
  if (!page || (need && !can(need))) return go("/admin/dashboard", true);
  return page();
}

(async () => {
  try {
    const { needsSetup } = await api("auth/setup-status");
    if (needsSetup && location.pathname !== "/admin/setup") return go("/admin/setup", true);
    if (!needsSetup && location.pathname === "/admin/setup") return go("/admin/login", true);
  } catch (err) {
    root.innerHTML = `<div class="auth"><div class="box"><h1>Painel indisponível</h1><p class="sub">${esc(err.message)}</p></div></div>`;
    return;
  }
  if (["/admin", "/admin/", "/admin/index.html"].includes(location.pathname)) return go("/admin/dashboard", true);
  render();
})();
})();
