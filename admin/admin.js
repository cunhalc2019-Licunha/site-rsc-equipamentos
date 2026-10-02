(() => {
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const root = $("#root");
// Todo texto vindo do banco passa por esc() antes de virar HTML (proteção contra XSS).
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const brl = cents => cents == null ? "—" : (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const moneyStr = cents => cents == null ? "" : (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
const moneyCents = v => { const d = String(v || "").replace(/\D/g, ""); return d ? parseInt(d, 10) : null; };
const dt = s => new Date(s).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

const CONDITION = { novo: "Novo", seminovo: "Seminovo", usado_revisado: "Usado revisado" };
const STATUS = { rascunho: "Rascunho", publicado: "Publicado", arquivado: "Arquivado" };
const TYPE = { entrada: "Entrada", saida: "Saída", ajuste: "Ajuste" };
const METHODS = { pix: "PIX", card: "Cartão", boleto: "Boleto" };

let ME = null;
let CATS = [];
let dirty = false;
const reasonLabel = (type, reason) => ME?.reasons?.[type]?.[reason] || reason;

/* ---------- API ---------- */
async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(`/api/admin/${path}`, {
    method, credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401 && path !== "login") { ME = null; location.hash = "#/login"; throw new Error(data.error || "Sessão expirada."); }
  if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
  return data;
}

let toastTimer;
function toast(msg, ok = true) {
  const t = $("#toast");
  t.innerHTML = `<span style="color:${ok ? "var(--green)" : "#ff8a80"};font-weight:800">${ok ? "✓" : "!"}</span> <span>${esc(msg)}</span>`;
  t.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 3500);
}

/* ---------- Layout ---------- */
function shell(active, html) {
  const nav = [["produtos", "Produtos"], ["movimentacoes", "Movimentações"], ["categorias", "Categorias"]];
  return `
  <div class="mobilebar"><a href="#/produtos" class="brand"><img src="../img/logo.png" alt="" style="width:36px;height:36px"><div><b style="font-size:1.3rem">RSC</b></div></a>
    <button class="burger" id="mnav" style="display:grid" aria-label="Menu">☰</button></div>
  <div class="layout">
    <aside class="sidebar" id="sidebar">
      <a href="#/produtos" class="brand"><img src="../img/logo.png" alt=""><div><b>RSC</b><small>Equipamentos</small></div></a>
      <div class="tagline">Painel administrativo</div>
      <nav class="side-nav">
        <a href="#/produto/novo" class="primary">+ Nova ficha de produto</a>
        ${nav.map(([k, l]) => `<a href="#/${k}" class="${active === k ? "on" : ""}">${l}</a>`).join("")}
        <a href="../" target="_blank" rel="noopener">Ver site ↗</a>
      </nav>
      <div class="side-user"><b>${esc(ME.user.name)}</b><span>${esc(ME.user.email)} · ${esc(ME.store.name)}</span><br><button id="logout">Sair</button></div>
    </aside>
    <main class="main">${html}</main>
  </div>`;
}

function mountShell() {
  $("#logout").onclick = async () => { await api("logout", { method: "POST" }).catch(() => {}); ME = null; location.hash = "#/login"; };
  $("#mnav").onclick = () => $("#sidebar").classList.toggle("open");
}

/* ---------- Login / primeiro acesso ---------- */
function viewLogin() {
  root.innerHTML = `<div class="auth"><div class="box">
    <div class="brand"><img src="../img/logo.png" alt="" style="width:56px;height:56px"><div><b>RSC</b><small>Equipamentos</small></div></div>
    <h1>Painel</h1><p class="sub">Acesso restrito à equipe da loja.</p>
    <form id="f" class="form" novalidate>
      <div class="f"><label>E-mail</label><input name="email" type="email" autocomplete="username" required></div>
      <div class="f"><label>Senha</label><input name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary btn-block" type="submit">Entrar</button>
      <div class="alert" id="err" style="display:none"></div>
    </form></div></div>`;
  $("#f").onsubmit = async e => {
    e.preventDefault();
    const f = e.target, btn = $("button", f);
    btn.disabled = true; $("#err").style.display = "none";
    try {
      await api("login", { method: "POST", body: { email: f.email.value, password: f.password.value } });
      await loadMe(); location.hash = "#/produtos";
    } catch (err) { $("#err").textContent = err.message; $("#err").style.display = "flex"; btn.disabled = false; f.password.value = ""; }
  };
  $("[name=email]").focus();
}

function viewSetup() {
  root.innerHTML = `<div class="auth"><div class="box" style="width:min(480px,100%)">
    <div class="brand"><img src="../img/logo.png" alt="" style="width:56px;height:56px"><div><b>RSC</b><small>Equipamentos</small></div></div>
    <h1>Primeiro acesso</h1><p class="sub">Crie a conta do administrador principal. Esta tela só aparece uma vez.</p>
    <form id="f" class="form" novalidate>
      <div class="f"><label>Código de configuração</label><input name="setupToken" type="password" required><span class="help">Valor da variável ADMIN_SETUP_TOKEN configurada no servidor.</span></div>
      <div class="f"><label>Nome da loja</label><input name="storeName" value="RSC Equipamentos" required></div>
      <div class="f"><label>Seu nome</label><input name="name" autocomplete="name" required></div>
      <div class="f"><label>E-mail de acesso</label><input name="email" type="email" autocomplete="username" required></div>
      <div class="f"><label>Senha (mínimo 10 caracteres)</label><input name="password" type="password" autocomplete="new-password" minlength="10" required></div>
      <div class="f"><label>Confirmar senha</label><input name="password2" type="password" autocomplete="new-password" required></div>
      <label class="check" style="color:var(--text)"><input type="checkbox" name="importCatalog" checked> Importar os 7 produtos e 3 setores que já estão no site</label>
      <button class="btn btn-primary btn-block" type="submit">Criar conta e entrar</button>
      <div class="alert" id="err" style="display:none"></div>
    </form></div></div>`;
  $("#f").onsubmit = async e => {
    e.preventDefault();
    const f = e.target, err = $("#err"), btn = $("button", f);
    err.style.display = "none";
    if (f.password.value !== f.password2.value) { err.textContent = "As senhas não conferem."; err.style.display = "flex"; return; }
    btn.disabled = true;
    try {
      await api("setup", { method: "POST", body: {
        setupToken: f.setupToken.value, storeName: f.storeName.value, name: f.name.value,
        email: f.email.value, password: f.password.value, importCatalog: f.importCatalog.checked } });
      await loadMe(); toast("Painel configurado!"); location.hash = "#/produtos";
    } catch (ex) { err.textContent = ex.message; err.style.display = "flex"; btn.disabled = false; }
  };
}

/* ---------- Lista de produtos ---------- */
async function viewList() {
  root.innerHTML = shell("produtos", `
    <div class="topline"><div><span class="eyebrow">Catálogo</span><h1>Produtos</h1></div>
      <a href="#/produto/novo" class="btn btn-primary">+ Nova ficha</a></div>
    <div class="filters">
      <input id="q" type="search" placeholder="Buscar por nome, marca ou SKU…">
      <select id="fs"><option value="">Ativos (rascunho + publicado)</option><option value="publicado">Publicados</option><option value="rascunho">Rascunhos</option><option value="arquivado">Arquivados</option></select>
      <select id="fc"><option value="">Todas as categorias</option>${CATS.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select>
    </div>
    <div id="list"><div class="empty-state">Carregando…</div></div>`);
  mountShell();
  let timer;
  const load = async () => {
    const qs = new URLSearchParams({ q: $("#q").value, status: $("#fs").value, categoryId: $("#fc").value });
    try {
      const { products } = await api(`products?${qs}`);
      $("#list").innerHTML = products.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr><th></th><th>Produto</th><th>Categoria</th><th>Condição</th><th>Preço</th><th>Estoque</th><th>Status</th></tr></thead>
        <tbody>${products.map(p => {
          const avail = p.on_hand - p.reserved;
          return `<tr class="click" data-id="${esc(p.id)}">
            <td>${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="">` : `<div class="thumb none">sem foto</div>`}</td>
            <td><b>${esc(p.name)}</b><small>${esc(p.sku)}${p.brand ? " · " + esc(p.brand) : ""}</small></td>
            <td>${esc(p.category || "—")}</td>
            <td>${esc(CONDITION[p.condition])}</td>
            <td class="num">${p.price_cents ? brl(p.price_cents) : `<span class="muted">Sob consulta</span>`}</td>
            <td><span class="chip ${avail <= 0 ? "zero" : ""}">${avail} disp.</span><small>${p.stock_type === "unico" ? "Item único" : "Várias unidades"}${p.reserved ? ` · ${p.reserved} reserv.` : ""}</small></td>
            <td><span class="chip ${esc(p.status)}">${esc(STATUS[p.status])}</span>${p.sell_online ? "" : `<small>só na loja</small>`}</td>
          </tr>`; }).join("")}</tbody></table></div>`
        : `<div class="empty-state"><b>Nenhum produto encontrado</b>Cadastre o primeiro pela ficha de entrada.<br><br><a href="#/produto/novo" class="btn btn-primary">+ Nova ficha</a></div>`;
      $$("tr[data-id]").forEach(tr => tr.onclick = () => { location.hash = `#/produto/${tr.dataset.id}`; });
    } catch (err) { $("#list").innerHTML = `<div class="alert">${esc(err.message)}</div>`; }
  };
  $("#q").oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
  $("#fs").onchange = $("#fc").onchange = load;
  load();
}

/* ---------- Ficha de produto (entrada / edição) ---------- */
async function resizeToBase64(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1];
}

const seg = (name, options, value) => `<div class="seg">${Object.entries(options).map(([v, [label, sub]]) =>
  `<label class="${v === value ? "on" : ""}"><input type="radio" name="${name}" value="${v}" ${v === value ? "checked" : ""}><b>${label}</b>${sub ? `<small>${sub}</small>` : ""}</label>`).join("")}</div>`;

async function viewSheet(id) {
  const isNew = !id;
  let p = { name: "", brand: "", category_id: CATS[0]?.id, sku: "", condition: "seminovo", stock_type: "unico", price_cents: null,
    old_price_cents: null, discount_pix_pct: 0, discount_card_pct: 0, payment_methods: ["pix", "card", "boleto"], badge: "",
    description: "", internal_notes: "", sell_online: true, status: "rascunho", specs: [], images: [], on_hand: 0, reserved: 0, movements: [] };
  root.innerHTML = shell("produtos", `<div class="empty-state">Carregando…</div>`); mountShell();
  if (!isNew) {
    try { p = (await api(`products?id=${encodeURIComponent(id)}`)).product; }
    catch (err) { $(".main").innerHTML = `<div class="alert">${esc(err.message)}</div>`; return; }
  }
  let images = [...p.images];
  let specs = p.specs.length ? p.specs.map(s => ({ ...s })) : [{ k: "", v: "" }];
  const entryReasons = ME.reasons.entrada;

  $(".main").innerHTML = `
    <div class="topline"><div><span class="eyebrow">${isNew ? "Ficha de entrada" : esc(p.sku)}</span>
      <h1>${isNew ? "Novo produto" : esc(p.name)}</h1>
      ${isNew ? `<p>Cadastre o equipamento e registre a entrada no estoque em um só passo.</p>` : `<p>Atualizado em ${dt(p.updated_at)}</p>`}</div>
      <a href="#/produtos" class="btn btn-ghost">← Voltar</a></div>
    <div class="sheet">
      <form id="sheet" novalidate style="display:grid;gap:20px">
        <section class="panel"><h3>1. Identificação</h3><p class="hint">Como o produto aparece no site.</p>
          <div class="form">
            <div class="f s4"><label>Nome do produto *</label><input name="name" maxlength="120" value="${esc(p.name)}" placeholder="Ex.: Freezer Horizontal 500L"></div>
            <div class="f s2"><label>SKU / código</label><input name="sku" maxlength="40" value="${esc(p.sku)}" placeholder="Automático"></div>
            <div class="f s3"><label>Marca / modelo</label><input name="brand" maxlength="120" value="${esc(p.brand)}" placeholder="Ex.: Metalfrio DA550"></div>
            <div class="f s3"><label>Categoria (setor) *</label><select name="categoryId">${CATS.map(c => `<option value="${esc(c.id)}" ${c.id === p.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
            <div class="f"><label>Condição *</label>${seg("condition", { novo: ["Novo", "Lacrado / sem uso"], seminovo: ["Seminovo", "Pouco uso, ótimo estado"], usado_revisado: ["Usado revisado", "Revisado pela RSC"] }, p.condition)}</div>
            <div class="f"><label>Tipo de estoque *</label>${seg("stockType", { unico: ["Item único", "Equipamento individual (ex.: usado). Máximo 1 unidade"], quantidade: ["Várias unidades", "Mesmo produto com várias peças em estoque"] }, p.stock_type)}</div>
          </div>
        </section>

        <section class="panel"><h3>2. Fotos</h3><p class="hint">A primeira foto é a capa. Até 10 fotos — elas são reduzidas automaticamente.</p>
          <label class="drop" id="drop"><input type="file" id="files" accept="image/jpeg,image/png,image/webp" multiple hidden>
            <b>Clique para escolher</b> ou arraste as fotos aqui<br><small>JPG, PNG ou WEBP</small></label>
          <div class="pics" id="pics"></div>
        </section>

        <section class="panel"><h3>3. Preço e pagamento</h3><p class="hint">Deixe o preço em branco para mostrar "Sob consulta" (sem compra online).</p>
          <div class="form">
            <div class="f s3"><label>Preço de venda</label><div class="prefix"><span>R$</span><input name="price" class="money" inputmode="numeric" value="${moneyStr(p.price_cents)}" placeholder="0,00"></div></div>
            <div class="f s3"><label>Preço "De" (riscado, opcional)</label><div class="prefix"><span>R$</span><input name="oldPrice" class="money" inputmode="numeric" value="${moneyStr(p.old_price_cents)}" placeholder="0,00"></div></div>
            <div class="f s3"><label>Desconto no PIX</label><div class="suffix"><input name="discountPixPct" type="number" min="0" max="90" step="0.5" value="${Number(p.discount_pix_pct)}"><span>%</span></div></div>
            <div class="f s3"><label>Desconto no cartão</label><div class="suffix"><input name="discountCardPct" type="number" min="0" max="90" step="0.5" value="${Number(p.discount_card_pct)}"><span>%</span></div></div>
            <div class="f"><label>Formas de pagamento aceitas</label><div class="checks">${Object.entries(METHODS).map(([k, l]) =>
              `<label><input type="checkbox" name="pm" value="${k}" ${p.payment_methods.includes(k) ? "checked" : ""}> ${l}</label>`).join("")}</div>
              <span class="help">Ex.: promoção válida só à vista → deixe apenas PIX.</span></div>
          </div>
          <div class="preview-prices" id="pp"></div>
        </section>

        <section class="panel"><h3>4. Descrição e especificações</h3><p class="hint">Medidas, tensão, capacidade, garantia…</p>
          <div class="form">
            <div class="f"><label>Descrição</label><textarea name="description" maxlength="4000" placeholder="Estado de conservação, uso indicado, diferenciais…">${esc(p.description)}</textarea></div>
          </div>
          <label style="display:block;font-size:.82rem;font-weight:600;color:var(--muted);margin:16px 0 8px">Especificações</label>
          <div id="specs"></div>
          <button type="button" class="link-btn" id="addSpec">+ Adicionar especificação</button>
        </section>

        ${isNew ? `
        <section class="panel"><h3>5. Entrada no estoque</h3><p class="hint">Registra a chegada do equipamento. Fica no histórico de movimentações.</p>
          <div class="form">
            <div class="f s2"><label>Quantidade *</label><input name="qty" type="number" min="0" step="1" value="1"></div>
            <div class="f s4"><label>Origem da entrada *</label><select name="reason">${Object.entries(entryReasons).map(([k, l]) => `<option value="${k}" ${k === "compra" ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
            <div class="f s3"><label>Fornecedor / de quem foi comprado</label><input name="supplier" maxlength="120"></div>
            <div class="f s3"><label>Custo unitário (interno)</label><div class="prefix"><span>R$</span><input name="unitCost" class="money" inputmode="numeric" placeholder="0,00"></div></div>
            <div class="f s3"><label>Documento (NF, recibo)</label><input name="document" maxlength="60"></div>
            <div class="f s3"><label>Observação</label><input name="entryNote" maxlength="500"></div>
          </div>
        </section>` : ""}
      </form>

      <div class="side-col">
        <section class="panel" id="pubPanel"><h3>Publicação</h3>
          <div class="form" style="margin-top:12px">
            <div class="f"><label>Status</label><select name="status" form="sheet">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === p.status ? "selected" : ""}>${l}</option>`).join("")}</select>
              <span class="help">Rascunho não aparece no site. Arquivado sai do catálogo, mas mantém o histórico.</span></div>
            <label class="check" style="color:var(--text)"><input type="checkbox" name="sellOnline" form="sheet" ${p.sell_online ? "checked" : ""}> Permitir compra online</label>
            <div class="f"><label>Selo no card (opcional)</label><input name="badge" form="sheet" maxlength="30" value="${esc(p.badge)}" placeholder="Ex.: Promoção"></div>
            <div class="f"><label>Observações internas</label><textarea name="internalNotes" form="sheet" maxlength="2000" style="min-height:80px" placeholder="Não aparece no site">${esc(p.internal_notes)}</textarea></div>
          </div>
        </section>
        ${isNew ? "" : `<section class="panel" id="stockPanel"></section>`}
      </div>
    </div>
    <div class="savebar"><span class="msg" id="msg">${isNew ? "Preencha os campos com * e salve." : "Alterações não salvas são perdidas ao sair."}</span>
      <div style="display:flex;gap:10px">
        ${!isNew && p.status !== "arquivado" && ["owner", "admin"].includes(ME.user.role) ? `<button type="button" class="btn btn-ghost" id="archive">Arquivar</button>` : ""}
        <button type="submit" form="sheet" class="btn btn-primary" id="save">${isNew ? "Salvar e dar entrada" : "Salvar alterações"}</button>
      </div></div>`;

  const form = $("#sheet");
  dirty = false;
  form.addEventListener("input", () => { dirty = true; });
  $("#pubPanel").addEventListener("input", () => { dirty = true; });

  // Seletores segmentados
  form.addEventListener("change", e => {
    if (e.target.type === "radio") $$(`input[name="${e.target.name}"]`, form).forEach(r => r.closest("label").classList.toggle("on", r.checked));
    if (e.target.name === "stockType" && isNew) syncQty();
    dirty = true; previewPrices();
  });
  const syncQty = () => {
    if (!form.qty) return;
    const unico = form.stockType.value === "unico";
    if (unico && Number(form.qty.value) > 1) form.qty.value = 1;
    form.qty.max = unico ? 1 : 100000;
  };
  syncQty();

  // Dinheiro
  $$(".money", form).forEach(i => i.addEventListener("input", () => { const c = moneyCents(i.value); i.value = c == null ? "" : moneyStr(c); previewPrices(); }));
  $$("[name=discountPixPct],[name=discountCardPct]", form).forEach(i => i.addEventListener("input", previewPrices));
  function previewPrices() {
    const price = moneyCents(form.price.value);
    const pms = $$("[name=pm]:checked", form).map(i => i.value);
    const disc = { pix: Number(form.discountPixPct.value) || 0, card: Number(form.discountCardPct.value) || 0, boleto: 0 };
    $("#pp").innerHTML = price ? `<span class="help" style="font-size:.78rem;color:var(--muted)">Como o cliente verá:</span>` + pms.map(m =>
      `<div><span>${METHODS[m]}${disc[m] ? ` (−${disc[m]}%)` : ""}</span><b>${brl(Math.round(price * (1 - disc[m] / 100)))}</b></div>`).join("") : "";
  }
  previewPrices();

  // Especificações
  const renderSpecs = () => {
    $("#specs").innerHTML = specs.map((s, i) => `<div class="spec-row">
      <input data-k="${i}" maxlength="60" placeholder="Ex.: Tensão" value="${esc(s.k)}">
      <input data-v="${i}" maxlength="200" placeholder="Ex.: 220V" value="${esc(s.v)}">
      <button type="button" data-rm="${i}" aria-label="Remover">✕</button></div>`).join("");
  };
  renderSpecs();
  $("#specs").addEventListener("input", e => {
    if (e.target.dataset.k) specs[e.target.dataset.k].k = e.target.value;
    if (e.target.dataset.v) specs[e.target.dataset.v].v = e.target.value;
  });
  $("#specs").addEventListener("click", e => { const b = e.target.closest("[data-rm]"); if (b) { specs.splice(+b.dataset.rm, 1); renderSpecs(); dirty = true; } });
  $("#addSpec").onclick = () => { specs.push({ k: "", v: "" }); renderSpecs(); $(`[data-k="${specs.length - 1}"]`).focus(); };

  // Fotos
  let uploading = 0;
  const renderPics = () => {
    $("#pics").innerHTML = images.map((u, i) => `<div class="pic">${i === 0 ? `<span class="cover">CAPA</span>` : ""}<img src="${esc(u)}" alt="">
      <div class="acts"><button type="button" data-left="${i}" title="Mover para a esquerda">‹</button><button type="button" data-del="${i}" title="Remover">✕</button><button type="button" data-right="${i}" title="Mover para a direita">›</button></div></div>`).join("")
      + Array.from({ length: uploading }, () => `<div class="pic loading">Enviando…</div>`).join("");
  };
  renderPics();
  $("#pics").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    const i = +(b.dataset.left ?? b.dataset.right ?? b.dataset.del);
    if (b.dataset.del !== undefined) images.splice(i, 1);
    else { const j = b.dataset.left !== undefined ? i - 1 : i + 1; if (j < 0 || j >= images.length) return; [images[i], images[j]] = [images[j], images[i]]; }
    dirty = true; renderPics();
  });
  const addFiles = async files => {
    const list = [...files].filter(f => /^image\//.test(f.type)).slice(0, 10 - images.length - uploading);
    if (!list.length) return toast("Limite de 10 fotos ou arquivo inválido.", false);
    uploading += list.length; renderPics();
    for (const file of list) {
      try { const { url } = await api("upload", { method: "POST", body: { data: await resizeToBase64(file) } }); images.push(url); dirty = true; }
      catch (err) { toast(`${file.name}: ${err.message}`, false); }
      uploading--; renderPics();
    }
  };
  $("#files").onchange = e => { addFiles(e.target.files); e.target.value = ""; };
  const drop = $("#drop");
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => addFiles(e.dataTransfer.files));

  // Salvar
  form.onsubmit = async e => {
    e.preventDefault();
    const msg = $("#msg");
    if (uploading) { msg.textContent = "Aguarde o envio das fotos terminar."; msg.className = "msg err"; return; }
    $$(".err", form).forEach(i => i.classList.remove("err"));
    if (!form.name.value.trim()) { form.name.classList.add("err"); form.name.focus(); msg.textContent = "Informe o nome do produto."; msg.className = "msg err"; return; }
    const payload = {
      name: form.name.value, brand: form.brand.value, sku: form.sku.value, categoryId: form.categoryId.value,
      condition: form.condition.value, stockType: form.stockType.value,
      priceCents: moneyCents(form.price.value), oldPriceCents: moneyCents(form.oldPrice.value),
      discountPixPct: form.discountPixPct.value, discountCardPct: form.discountCardPct.value,
      paymentMethods: $$("[name=pm]:checked", form).map(i => i.value),
      description: form.description.value, internalNotes: form.internalNotes.value, badge: form.badge.value,
      sellOnline: form.sellOnline.checked, status: form.status.value,
      specs: specs.filter(s => s.k.trim() && s.v.trim()), images,
    };
    if (isNew) payload.initialEntry = {
      quantity: Number(form.qty.value) || 0, reason: form.reason.value, supplier: form.supplier.value,
      unitCostCents: moneyCents(form.unitCost.value), document: form.document.value, note: form.entryNote.value,
    };
    const btn = $("#save"); btn.disabled = true;
    try {
      const r = await api(isNew ? "products" : `products?id=${encodeURIComponent(id)}`, { method: isNew ? "POST" : "PUT", body: payload });
      dirty = false;
      toast(isNew ? "Produto cadastrado e entrada registrada." : "Alterações salvas.");
      if (isNew) location.hash = `#/produto/${r.id}`; else viewSheet(id);
    } catch (err) { msg.textContent = err.message; msg.className = "msg err"; btn.disabled = false; }
  };

  if ($("#archive")) $("#archive").onclick = async () => {
    if (!confirm("Arquivar este produto? Ele sai do catálogo, mas o histórico é mantido.")) return;
    try { await api(`products?id=${encodeURIComponent(id)}`, { method: "DELETE" }); dirty = false; toast("Produto arquivado."); location.hash = "#/produtos"; }
    catch (err) { toast(err.message, false); }
  };

  if (!isNew) renderStockPanel(p);
}

/* Painel lateral de estoque da ficha (edição) */
function renderStockPanel(p) {
  const box = $("#stockPanel");
  const avail = p.on_hand - p.reserved;
  const R = ME.reasons;
  box.innerHTML = `<h3>Estoque</h3>
    <div class="stock-big" style="margin:12px 0 18px">
      <div><b>${p.on_hand}</b><span>Em estoque</span></div>
      <div><b>${p.reserved}</b><span>Reservado</span></div>
      <div><b class="${avail > 0 ? "grad-text" : ""}">${avail}</b><span>Disponível</span></div>
    </div>
    <form id="mv" class="form" novalidate>
      <div class="f"><label>Movimentação</label>${seg("mtype", { entrada: ["Entrada"], saida: ["Saída"], ajuste: ["Ajuste"] }, "entrada")}</div>
      <div class="f s2"><label>Qtd.</label><input name="quantity" type="number" step="1" value="1"></div>
      <div class="f s4"><label>Motivo</label><select name="reason"></select></div>
      <div class="f"><label id="whoLbl">Fornecedor / origem</label><input name="supplier" maxlength="120"></div>
      <div class="f s3" id="costF"><label>Custo unit.</label><div class="prefix"><span>R$</span><input name="unitCost" class="money" inputmode="numeric"></div></div>
      <div class="f s3"><label>Documento</label><input name="document" maxlength="60"></div>
      <div class="f"><label>Observação</label><input name="note" maxlength="500"></div>
      <span class="help" id="mvHelp" style="grid-column:span 6;font-size:.78rem;color:var(--muted)"></span>
      <button class="btn btn-primary btn-block" style="grid-column:span 6" type="submit">Registrar</button>
    </form>
    <h3 style="font-size:1.1rem;margin:22px 0 10px">Histórico</h3>
    <div class="mini-hist">${p.movements.length ? p.movements.map(m => `<div>
      <span class="${m.quantity > 0 ? "pos" : "neg"} num">${m.quantity > 0 ? "+" : ""}${m.quantity}</span>
      <span>${esc(TYPE[m.type])} · ${esc(reasonLabel(m.type, m.reason))}<small>${dt(m.created_at)}${m.user_name ? " · " + esc(m.user_name) : ""}${m.supplier ? " · " + esc(m.supplier) : ""}${m.document ? " · " + esc(m.document) : ""}</small></span>
      <span class="num muted">saldo ${m.balance_after}</span></div>`).join("") : `<span class="muted">Nenhuma movimentação.</span>`}</div>`;

  const f = $("#mv");
  const sync = () => {
    const t = f.mtype.value;
    f.reason.innerHTML = Object.entries(R[t]).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
    $("#whoLbl").textContent = t === "saida" ? "Cliente / destino" : "Fornecedor / origem";
    $("#costF").style.display = t === "entrada" ? "" : "none";
    f.quantity.min = t === "ajuste" ? "" : 1;
    $("#mvHelp").textContent = t === "ajuste" ? "Ajuste: use número positivo para somar ou negativo para subtrair (ex.: -1)."
      : t === "saida" ? "Use para venda no balcão, perda ou avaria. O saldo é baixado na hora." : p.stock_type === "unico" ? "Item único: o estoque máximo é 1." : "";
  };
  f.addEventListener("change", e => { if (e.target.name === "mtype") { $$("input[name=mtype]", f).forEach(r => r.closest("label").classList.toggle("on", r.checked)); sync(); } });
  $$(".money", f).forEach(i => i.addEventListener("input", () => { const c = moneyCents(i.value); i.value = c == null ? "" : moneyStr(c); }));
  sync();
  f.onsubmit = async e => {
    e.preventDefault();
    const btn = $("button[type=submit]", f); btn.disabled = true;
    try {
      const t = f.mtype.value;
      await api("stock", { method: "POST", body: {
        productId: p.id, type: t, quantity: Number(f.quantity.value), reason: f.reason.value,
        supplier: f.supplier.value, document: f.document.value, note: f.note.value,
        unitCostCents: t === "entrada" ? moneyCents(f.unitCost.value) : null } });
      toast(`${TYPE[t]} registrada.`);
      const fresh = (await api(`products?id=${encodeURIComponent(p.id)}`)).product;
      renderStockPanel(fresh);
    } catch (err) { toast(err.message, false); btn.disabled = false; }
  };
}

/* ---------- Movimentações ---------- */
async function viewMovements() {
  root.innerHTML = shell("movimentacoes", `
    <div class="topline"><div><span class="eyebrow">Estoque</span><h1>Movimentações</h1><p>Histórico de entradas, saídas e ajustes (os 300 mais recentes).</p></div></div>
    <div class="filters"><select id="ft"><option value="">Todos os tipos</option><option value="entrada">Entradas</option><option value="saida">Saídas</option><option value="ajuste">Ajustes</option></select></div>
    <div id="list"><div class="empty-state">Carregando…</div></div>`);
  mountShell();
  const load = async () => {
    try {
      const { movements } = await api(`stock?${new URLSearchParams({ type: $("#ft").value })}`);
      $("#list").innerHTML = movements.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Data</th><th>Produto</th><th>Tipo</th><th>Qtd.</th><th>Saldo</th><th>Fornecedor / cliente</th><th>Documento</th><th>Custo unit.</th><th>Usuário</th></tr></thead>
        <tbody>${movements.map(m => `<tr class="click" data-id="${esc(m.product_id)}">
          <td class="num">${dt(m.created_at)}</td>
          <td><b>${esc(m.product_name)}</b><small>${esc(m.sku)}</small></td>
          <td>${esc(TYPE[m.type])}<small>${esc(reasonLabel(m.type, m.reason))}</small></td>
          <td class="num ${m.quantity > 0 ? "pos" : "neg"}">${m.quantity > 0 ? "+" : ""}${m.quantity}</td>
          <td class="num">${m.balance_after}</td>
          <td>${esc(m.supplier || "—")}${m.note ? `<small>${esc(m.note)}</small>` : ""}</td>
          <td>${esc(m.document || "—")}</td>
          <td class="num">${m.unit_cost_cents != null ? brl(m.unit_cost_cents) : "—"}</td>
          <td>${esc(m.user_name || "—")}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty-state"><b>Nenhuma movimentação</b>As entradas registradas nas fichas aparecem aqui.</div>`;
      $$("tr[data-id]").forEach(tr => tr.onclick = () => { location.hash = `#/produto/${tr.dataset.id}`; });
    } catch (err) { $("#list").innerHTML = `<div class="alert">${esc(err.message)}</div>`; }
  };
  $("#ft").onchange = load;
  load();
}

/* ---------- Categorias ---------- */
async function viewCategories() {
  root.innerHTML = shell("categorias", `
    <div class="topline"><div><span class="eyebrow">Catálogo</span><h1>Categorias</h1><p>Os setores da loja (Refrigeração, Cocção…).</p></div></div>
    <div class="sheet"><div id="list"><div class="empty-state">Carregando…</div></div>
      <section class="panel"><h3 id="ctitle">Nova categoria</h3>
        <form id="cf" class="form" novalidate style="margin-top:12px">
          <div class="f"><label>Nome *</label><input name="name" maxlength="60"></div>
          <div class="f"><label>Descrição</label><textarea name="description" maxlength="300" style="min-height:80px"></textarea></div>
          <div class="f s3"><label>Ordem</label><input name="position" type="number" min="0" value="0"></div>
          <label class="check f s3" style="color:var(--text);align-self:end"><input type="checkbox" name="active" checked> Ativa</label>
          <button class="btn btn-primary btn-block" style="grid-column:span 6" type="submit">Salvar</button>
          <button class="btn btn-ghost btn-block" style="grid-column:span 6;display:none" type="button" id="cnew">Cancelar edição</button>
        </form></section></div>`);
  mountShell();
  let editing = null;
  const f = $("#cf");
  const reset = () => { editing = null; f.reset(); $("#ctitle").textContent = "Nova categoria"; $("#cnew").style.display = "none"; };
  const load = async () => {
    const { categories } = await api("categories"); CATS = categories;
    $("#list").innerHTML = `<div class="tbl-wrap"><table class="tbl" style="min-width:0"><thead><tr><th>Nome</th><th>Produtos</th><th>Ordem</th><th>Status</th></tr></thead>
      <tbody>${categories.map(c => `<tr class="click" data-id="${esc(c.id)}"><td><b>${esc(c.name)}</b><small>${esc(c.description || "")}</small></td>
        <td class="num">${c.products}</td><td class="num">${c.position}</td><td><span class="chip ${c.active ? "publicado" : "arquivado"}">${c.active ? "Ativa" : "Inativa"}</span></td></tr>`).join("")}</tbody></table></div>`;
    $$("tr[data-id]").forEach(tr => tr.onclick = () => {
      const c = categories.find(x => x.id === tr.dataset.id); editing = c.id;
      f.name.value = c.name; f.description.value = c.description || ""; f.position.value = c.position; f.active.checked = c.active;
      $("#ctitle").textContent = "Editar categoria"; $("#cnew").style.display = "";
    });
  };
  $("#cnew").onclick = reset;
  f.onsubmit = async e => {
    e.preventDefault();
    try {
      await api(editing ? `categories?id=${encodeURIComponent(editing)}` : "categories", { method: editing ? "PUT" : "POST",
        body: { name: f.name.value, description: f.description.value, position: f.position.value, active: f.active.checked } });
      toast("Categoria salva."); reset(); load();
    } catch (err) { toast(err.message, false); }
  };
  load().catch(err => { $("#list").innerHTML = `<div class="alert">${esc(err.message)}</div>`; });
}

/* ---------- Roteador ---------- */
async function loadMe() {
  ME = await api("me");
  CATS = (await api("categories")).categories;
}

async function route() {
  const [a, b] = location.hash.replace(/^#\/?/, "").split("/");
  if (a === "setup") return viewSetup();
  if (a === "login") return viewLogin();
  if (!ME) {
    try { await loadMe(); }
    catch { return; } // api() já redirecionou para o login
  }
  if (a === "produto") return viewSheet(b === "novo" ? null : b);
  if (a === "movimentacoes") return viewMovements();
  if (a === "categorias") return viewCategories();
  return viewList();
}

let lastHash = location.hash;
window.addEventListener("hashchange", () => {
  if (dirty && !confirm("Há alterações não salvas na ficha. Sair mesmo assim?")) { history.replaceState(null, "", lastHash); return; }
  dirty = false; lastHash = location.hash; route();
});
window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

(async () => {
  try {
    const { needsSetup } = await api("setup");
    if (needsSetup) { location.hash = "#/setup"; return viewSetup(); }
  } catch (err) {
    root.innerHTML = `<div class="auth"><div class="box"><h1>Painel indisponível</h1><p class="sub">${esc(err.message)}</p></div></div>`;
    return;
  }
  if (location.hash === "#/setup") { location.hash = "#/produtos"; return; } // o hashchange chama route()
  route();
})();
})();
