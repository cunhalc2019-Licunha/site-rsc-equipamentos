(() => {
const CFG = window.RSC_CONFIG;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $("#app");
const brl = v => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const waLink = msg => `https://wa.me/${CFG.whatsapp}?text=${encodeURIComponent(msg)}`;
const icon = (id, size = 20, style = "") => `<svg class="ico" style="width:${size}px;height:${size}px;${style}"><use href="#i-${id}"/></svg>`;

const METHODS = {
  pix:    { label: "PIX",                icon: "pix",     sub: "Aprovação imediata" },
  card:   { label: "Cartão de crédito",  icon: "card",    sub: `Em até ${CFG.maxInstallments}x` },
  boleto: { label: "Boleto bancário",    icon: "barcode", sub: "Compensação em até 3 dias úteis" },
};

let DATA = { sectors: [], products: [] };
const product = id => DATA.products.find(p => p.id === id);
const sector = slug => DATA.sectors.find(s => s.slug === slug);
const allowedMethods = p => p.methods || Object.keys(METHODS);
// Mesmo cálculo usado em api/checkout.js — o servidor é quem define o valor final.
const unitPrice = (p, method) => Math.round(p.price * (1 - ((p.discounts || {})[method] || 0) / 100) * 100) / 100;
const bestPrice = p => Math.min(...allowedMethods(p).map(m => unitPrice(p, m)));
const soldOut = p => p.stock !== undefined && p.stock <= 0;
const canBuy = p => !!p && !!p.price && !soldOut(p) && p.online !== false;

/* ---------- Carrinho ---------- */
let cart = {};
try { cart = JSON.parse(localStorage.getItem("rsc-cart")) || {}; } catch {}
const saveCart = () => { try { localStorage.setItem("rsc-cart", JSON.stringify(cart)); } catch {} updateBadge(); };
const cartLines = () => Object.entries(cart).map(([id, qty]) => ({ p: product(id), qty })).filter(l => canBuy(l.p))
  .map(l => ({ ...l, qty: Math.min(l.qty, l.p.stock || 99) }));
const updateBadge = () => { $("#cartCount").textContent = cartLines().reduce((n, l) => n + l.qty, 0); };

function addToCart(id, qty = 1) {
  const p = product(id);
  if (!canBuy(p)) return;
  cart[id] =Math.min((cart[id] || 0) + qty, p.stock || 99);
  saveCart();
  toast(`${icon("check", 18, "color:var(--green)")} <span><b>${p.name}</b> adicionado ao carrinho.</span> <a href="#/carrinho">Ver carrinho</a>`);
}

let toastTimer;
function toast(html) {
  const t = $("#toast"); t.innerHTML = html; t.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 3200);
}

/* ---------- Componentes ---------- */
function priceBlock(p) {
  if (!p.price) return `<b>Sob consulta</b><small>Fale com um vendedor</small>`;
  const best = bestPrice(p);
  const disc = best < p.price;
  return `${p.oldPrice ? `<span class="old">${brl(p.oldPrice)}</span>` : ""}
    <b class="grad-text">${brl(best)}</b>
    <small>${allowedMethods(p).length === 1 && allowedMethods(p)[0] === "pix" ? "somente no PIX" : disc ? "no PIX" : `ou ${CFG.maxInstallments}x no cartão`}</small>`;
}

function card(p) {
  const s = sector(p.sector);
  return `<article class="card fade">
    <a class="card-media" href="#/produto/${p.id}">
      ${soldOut(p) ? `<span class="badge">Vendido</span>` : p.badge ? `<span class="badge hot">${p.badge}</span>` : ""}
      <img src="${p.images[0]}" alt="${p.name} ${p.brand}" loading="lazy" ${soldOut(p) ? `style="filter:grayscale(1);opacity:.6"` : ""}>
    </a>
    <div class="card-body">
      <span class="card-cat">${s ? s.name : ""}</span>
      <a href="#/produto/${p.id}"><h3>${p.name}</h3></a>
      <span class="brandname">${p.brand}</span>
      <div class="card-foot">
        <div class="card-price">${priceBlock(p)}</div>
        ${canBuy(p)
          ? `<button class="add-btn" data-add="${p.id}">${icon("cart", 16)} Comprar</button>`
          : soldOut(p)
          ? `<button class="add-btn ghost" data-wa="Olá! Vi que o ${p.name} (${p.brand}) foi vendido. Vocês têm algum similar?">${icon("wa", 16)} Similar</button>`
          : `<button class="add-btn ghost" data-wa="Olá! Tenho interesse em: ${p.name} (${p.brand}).">${icon("wa", 16)} Consultar</button>`}
      </div>
    </div>
  </article>`;
}

function pageHead(title, crumbs, sub = "", extra = "") {
  return `<div class="page-head"><div class="container">
    <div class="crumbs"><a href="#/">Início</a>${crumbs.map(c => `<span>/</span>${c[1] ? `<a href="${c[1]}">${c[0]}</a>` : `<span>${c[0]}</span>`}`).join("")}</div>
    <h1>${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ""}${extra}
  </div></div>`;
}

/* ---------- Páginas ---------- */
function viewHome() {
  const featured = DATA.products.filter(p => p.badge || p.price).slice(0, 3);
  return `
  <section class="hero"><div class="container hero-grid">
    <div class="fade">
      <span class="eyebrow">Loja online · Compra e venda</span>
      <h1>Equipamentos <span class="grad-text">profissionais</span> para a sua cozinha industrial</h1>
      <p class="lead">Equipamentos novos e usados revisados: refrigeração, inox, cocção, fatiadores, utensílios e muito mais. Escolha pelo setor e retire na loja ou receba no seu negócio.</p>
      <div class="hero-ctas">
        <a href="#/loja" class="btn btn-primary">Comprar agora ${icon("arrow")}</a>
        <a href="#" class="btn btn-ghost" data-wa="Olá! Estou procurando um equipamento. Podem me ajudar?">${icon("wa", 20, "color:var(--green)")} Falar com vendedor</a>
      </div>
      <div class="stats">
        <div><b class="grad-text">${DATA.products.length}+</b><span>equipamentos no catálogo</span></div>
        <div><b class="grad-text">${DATA.sectors.length}</b><span>setores</span></div>
        <div><b class="grad-text">3 meses</b><span>de garantia nos usados*</span></div>
      </div>
    </div>
    <div class="hero-media fade">
      ${(() => {
        const pick = (slug, skip) => DATA.products.find(p => p.sector === slug && p !== skip) || DATA.products.find(p => p !== skip);
        const a = pick("geladeiras"), b = pick("fogoes", a), c = pick("cortadores", b);
        return [[a, "tile tall"], [b, "tile"], [c, "tile"]].filter(([p]) => p)
          .map(([p, cls]) => `<a class="${cls}" href="#/produto/${p.id}"><img src="${p.images[0]}" alt="${p.name}"></a>`).join("");
      })()}
      <div class="hero-badge"><img src="img/logo.png" alt=""><div><b>Compra 100% segura</b><span>Pagamento via Mercado Pago</span></div></div>
    </div>
  </div></section>

  <div class="features"><div class="container">
    <div class="feature"><div class="fi">${icon("lock")}</div><div><b>Pagamento seguro</b><span>PIX, cartão e boleto</span></div></div>
    <div class="feature"><div class="fi">${icon("shield")}</div><div><b>Garantia RSC</b><span>Equipamentos revisados</span></div></div>
    <div class="feature"><div class="fi">${icon("truck")}</div><div><b>Retire ou receba</b><span>Retirada grátis na loja</span></div></div>
    <div class="feature"><div class="fi">${icon("swap")}</div><div><b>Compra e venda</b><span>Avaliamos seu equipamento</span></div></div>
  </div></div>

  <section class="block"><div class="container">
    <div class="section-head"><div><span class="eyebrow">Compre por setor</span><h2>Encontre pelo <span class="grad-text">setor</span></h2></div>
      <p>Organizamos a loja pelos setores da sua cozinha para você achar o equipamento certo mais rápido.</p></div>
    <div class="sectors">${DATA.sectors.map(s => {
      const n = DATA.products.filter(p => p.sector === s.slug).length;
      return `<a class="sector-card fade" href="#/setor/${s.slug}"><img src="${s.cover}" alt="${s.name}">
        <div class="in"><span class="card-cat">${n} ${n === 1 ? "produto" : "produtos"}</span><h3>${s.name}</h3><p>${s.desc}</p>
        <div class="go"><span>Ver produtos</span><span>${icon("arrow", 18)}</span></div></div></a>`;
    }).join("")}</div>
  </div></section>

  <section class="block" style="padding-top:0"><div class="container">
    <div class="section-head"><div><span class="eyebrow">Destaques</span><h2>Ofertas da <span class="grad-text">semana</span></h2></div>
      <a href="#/ofertas" class="btn btn-ghost">Ver todas as ofertas ${icon("arrow")}</a></div>
    <div class="grid">${featured.map(card).join("")}</div>
  </div></section>

  ${sellBlock()}
  ${contactBlock()}`;
}

function viewShop({ slug = null, offers = false } = {}) {
  const s = slug && sector(slug);
  if (slug && !s) return viewNotFound();
  const title = offers ? `Ofertas` : s ? s.name : "Todos os produtos";
  const crumbs = offers ? [["Ofertas"]] : s ? [["Loja", "#/loja"], [s.name]] : [["Loja"]];
  const sub = offers ? "Promoções e condições especiais por tempo limitado." : s ? s.desc : "Todo o catálogo da RSC Equipamentos, organizado por setor.";
  return `${pageHead(title, crumbs, sub)}
  <div class="container shop">
    <aside class="side">
      <div><h4>Setores</h4><div class="side-list">
        <a href="#/loja" class="${!s && !offers ? "on" : ""}">Todos <span>${DATA.products.length}</span></a>
        ${DATA.sectors.map(x => `<a href="#/setor/${x.slug}" class="${s && x.slug === s.slug ? "on" : ""}">${x.name} <span>${DATA.products.filter(p => p.sector === x.slug).length}</span></a>`).join("")}
        <a href="#/ofertas" class="${offers ? "on" : ""}">🔥 Ofertas <span>${DATA.products.filter(isOffer).length}</span></a>
      </div></div>
      <div><h4>Filtrar</h4>
        <label class="check"><input type="checkbox" id="fBuy"> Compra online disponível</label>
        <label class="check"><input type="checkbox" id="fPix"> Desconto no PIX</label>
      </div>
    </aside>
    <div>
      <div class="toolbar">
        <div class="search">${icon("search")}<input id="q" type="search" placeholder="Buscar equipamento, marca…"></div>
        <select class="sel" id="sort">
          <option value="rel">Mais relevantes</option>
          <option value="asc">Menor preço</option>
          <option value="desc">Maior preço</option>
          <option value="az">Nome (A–Z)</option>
        </select>
      </div>
      <div class="grid" id="grid"></div>
    </div>
  </div>`;
}
const isOffer = p => p.badge || p.oldPrice || p.discounts;

function mountShop({ slug = null, offers = false } = {}) {
  const render = () => {
    const q = $("#q").value.trim().toLowerCase();
    let list = DATA.products.filter(p =>
      (!slug || p.sector === slug) && (!offers || isOffer(p)) &&
      (!$("#fBuy").checked || canBuy(p)) &&
      (!$("#fPix").checked || (p.discounts && p.discounts.pix) || (p.oldPrice && allowedMethods(p).includes("pix"))) &&
      (!q || `${p.name} ${p.brand}`.toLowerCase().includes(q)));
    const sort = $("#sort").value;
    const val = p => p.price ? bestPrice(p) : Infinity;
    if (sort === "asc") list.sort((a, b) => val(a) - val(b));
    if (sort === "desc") list.sort((a, b) => (b.price ? val(b) : -1) - (a.price ? val(a) : -1));
    if (sort === "az") list.sort((a, b) => a.name.localeCompare(b.name));
    $("#grid").innerHTML = list.length ? list.map(card).join("") : `<div class="empty" style="grid-column:1/-1">Nenhum produto encontrado.</div>`;
  };
  ["#q", "#sort", "#fBuy", "#fPix"].forEach(s => $(s).addEventListener("input", render));
  render();
}

function viewProduct(id) {
  const p = product(id);
  if (!p) return `<div class="container"><div class="done fail"><div class="big">${icon("x", 38)}</div><h1>Produto indisponível</h1>
    <p>Este equipamento foi vendido ou está reservado por outro cliente no momento. Fale com a gente: chegam novos itens toda semana.</p>
    <div style="display:flex;gap:12px;justify-content:center;margin-top:24px;flex-wrap:wrap"><a href="#/loja" class="btn btn-primary">Ver produtos disponíveis</a>
    <a href="#" class="btn btn-ghost" data-wa="Olá! Vi um produto no site que está indisponível. Vocês têm algum similar?">${icon("wa", 20, "color:var(--green)")} Procurar similar</a></div></div></div>`;
  const s = sector(p.sector);
  const methods = allowedMethods(p);
  const buy = soldOut(p) ? `
    <div class="buybox">
      <div><div class="now" style="font-size:2.4rem">Vendido</div><p class="muted" style="margin-top:6px">Este equipamento já foi vendido. Fale com a gente — chegam novos itens toda semana.</p></div>
      <a href="#" class="btn btn-wa btn-block" data-wa="Olá! Vi que o ${p.name} (${p.brand}) foi vendido. Vocês têm algum similar?">${icon("wa")} Procurar similar no WhatsApp</a>
    </div>` : canBuy(p) ? `
    <div class="buybox">
      <div>${p.oldPrice ? `<span class="old">De ${brl(p.oldPrice)}</span>` : ""}
        <div class="now grad-text">${brl(bestPrice(p))}</div>
        ${p.oldPrice ? `<span class="pill ok" style="display:inline-block;margin-top:8px">Economize ${brl(p.oldPrice - bestPrice(p))}</span>` : ""}</div>
      <div class="pay-lines">${methods.map(m => `<div><span>${icon(METHODS[m].icon, 16, "vertical-align:-3px;margin-right:6px;color:var(--orange)")}${METHODS[m].label}</span><b>${brl(unitPrice(p, m))}${m === "card" ? ` <span class="muted" style="font-weight:500">em até ${CFG.maxInstallments}x</span>` : ""}</b></div>`).join("")}</div>
      <div class="qty-row">
        <div class="stepper"><button data-step="-1" aria-label="Diminuir">−</button><span id="pq">1</span><button data-step="1" aria-label="Aumentar">+</button></div>
        <button class="btn btn-primary" id="buyNow">${icon("lock", 18)} Comprar agora</button>
      </div>
      <button class="btn btn-ghost btn-block" id="addCart">${icon("cart", 18)} Adicionar ao carrinho</button>
      ${p.note ? `<div class="note">${icon("info", 16)} ${p.note}</div>` : ""}
    </div>` : `
    <div class="buybox">
      <div><div class="now" style="font-size:2.4rem">Preço sob consulta</div><p class="muted" style="margin-top:6px">Fale com nossa equipe para saber preço, disponibilidade e condições.</p></div>
      <a href="#" class="btn btn-wa btn-block" data-wa="Olá! Gostaria de saber o preço de: ${p.name} (${p.brand}).">${icon("wa")} Consultar preço no WhatsApp</a>
    </div>`;
  return `<div class="container">
    <div class="crumbs" style="padding-top:28px"><a href="#/">Início</a><span>/</span><a href="#/loja">Loja</a><span>/</span><a href="#/setor/${s.slug}">${s.name}</a><span>/</span><span>${p.name}</span></div>
    <div class="pdp fade">
      <div>
        <div class="gallery-main">${p.badge ? `<span class="badge hot">${p.badge}</span>` : ""}<img id="mainImg" src="${p.images[0]}" alt="${p.name}"></div>
        ${p.images.length > 1 ? `<div class="thumbs">${p.images.map((src, i) => `<button class="${i ? "" : "on"}" data-img="${src}"><img src="${src}" alt="Foto ${i + 1}"></button>`).join("")}</div>` : ""}
      </div>
      <div class="pdp-info">
        <span class="card-cat">${s.name}</span>
        <h1>${p.name}</h1>
        <span class="muted">${p.brand}</span>
        <div class="pills">
          <span class="pill">${p.condition}</span>
          ${p.price ? `<span class="pill ok">${icon("check", 14, "vertical-align:-2px")} Compra online</span>` : ""}
          <span class="pill">${icon("store", 14, "vertical-align:-2px")} Retirada na loja</span>
        </div>
        <p class="muted">${p.desc}</p>
        ${buy}
        <h3 style="font-size:1.5rem;margin-top:10px">Especificações</h3>
        <table class="specs">${Object.entries(p.specs || {}).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>
      </div>
    </div>
    ${(() => {
      const rel = DATA.products.filter(x => x.sector === p.sector && x.id !== p.id).slice(0, 3);
      return rel.length ? `<section style="padding-bottom:90px"><div class="section-head"><div><span class="eyebrow">Mesmo setor</span><h2>Você também pode <span class="grad-text">gostar</span></h2></div></div><div class="grid">${rel.map(card).join("")}</div></section>` : "";
    })()}
  </div>`;
}

function mountProduct(id) {
  const p = product(id); if (!p) return;
  $$(".thumbs button").forEach(b => b.onclick = () => { $$(".thumbs button").forEach(x => x.classList.toggle("on", x === b)); $("#mainImg").src = b.dataset.img; });
  if (!canBuy(p)) return;
  let q = 1;
  $$("[data-step]").forEach(b => b.onclick = () => { q = Math.max(1, Math.min(p.stock || 99, q + +b.dataset.step)); $("#pq").textContent = q; });
  $("#addCart").onclick = () => addToCart(p.id, q);
  $("#buyNow").onclick = () => { addToCart(p.id, q); location.hash = "#/checkout"; };
}

function stepsBar(n) {
  const st = ["Carrinho", "Dados e pagamento", "Confirmação"];
  return `<div class="steps">${st.map((t, i) => `${i ? `<span class="sep"></span>` : ""}<span class="${i <= n ? "on" : ""}"><i>${i + 1}</i>${t}</span>`).join("")}</div>`;
}

function viewCart() {
  const lines = cartLines();
  if (!lines.length) return `${pageHead("Carrinho", [["Carrinho"]], "", stepsBar(0))}
    <div class="container"><div class="done"><div class="big">${icon("cart", 38)}</div><h1>Carrinho vazio</h1><p>Explore os setores e encontre o equipamento ideal para o seu negócio.</p><a href="#/loja" class="btn btn-primary" style="margin-top:24px">Ir para a loja ${icon("arrow")}</a></div></div>`;
  const methods = commonMethods(lines);
  const subtotal = lines.reduce((t, l) => t + l.p.price * l.qty, 0);
  const pix = methods.includes("pix") ? lines.reduce((t, l) => t + unitPrice(l.p, "pix") * l.qty, 0) : null;
  return `${pageHead("Carrinho", [["Carrinho"]], "", stepsBar(0))}
  <div class="container co">
    <div class="panel">${lines.map(({ p, qty }) => `
      <div class="line">
        <img src="${p.images[0]}" alt="">
        <div><a href="#/produto/${p.id}"><b>${p.name}</b></a><small>${p.brand} · ${brl(p.price)} un.</small><br><button class="rm" data-rm="${p.id}">Remover</button></div>
        <div style="display:grid;gap:8px;justify-items:end">
          <div class="stepper"><button data-cq="${p.id}" data-d="-1">−</button><span>${qty}</span><button data-cq="${p.id}" data-d="1">+</button></div>
          <b>${brl(p.price * qty)}</b>
        </div>
      </div>`).join("")}
    </div>
    <aside class="panel summary">
      <h3>Resumo</h3>
      <div class="sum-row"><span>Subtotal</span><span>${brl(subtotal)}</span></div>
      <div class="sum-row"><span>Entrega</span><span class="muted">calculada no checkout</span></div>
      <div class="sum-row total"><span>Total</span><b>${brl(subtotal)}</b></div>
      ${pix !== null && pix < subtotal ? `<div class="sum-row"><span>${icon("pix", 16, "vertical-align:-3px;color:var(--orange)")} No PIX</span><span class="disc">${brl(pix)}</span></div>` : ""}
      ${!methods.includes("card") ? `<div class="alert" style="margin-top:12px">${icon("info", 18)} Um ou mais itens têm preço promocional válido somente no PIX.</div>` : ""}
      ${deadlineWarning()}
      <p class="muted" style="font-size:.8rem;margin-top:10px">Os itens do carrinho ainda <b>não</b> estão reservados. A reserva começa quando você confirma o pedido.</p>
      <a href="#/checkout" class="btn btn-primary btn-block" style="margin-top:18px">${icon("lock", 18)} Finalizar compra</a>
      <a href="#/loja" class="btn btn-ghost btn-block" style="margin-top:10px">Continuar comprando</a>
    </aside>
  </div>`;
}

function mountCart() {
  $$("[data-rm]").forEach(b => b.onclick = () => { delete cart[b.dataset.rm]; saveCart(); route(); });
  $$("[data-cq]").forEach(b => b.onclick = () => {
    const id = b.dataset.cq, p = product(id);
    cart[id] = Math.max(1, Math.min(p.stock || 99, cart[id] + +b.dataset.d)); saveCart(); route();
  });
}

const commonMethods = lines => Object.keys(METHODS).filter(m => lines.every(l => allowedMethods(l.p).includes(m)));

function viewCheckout() {
  const lines = cartLines();
  if (!lines.length) { location.hash = "#/carrinho"; return ""; }
  const methods = commonMethods(lines);
  return `${pageHead("Finalizar compra", [["Carrinho", "#/carrinho"], ["Checkout"]], "", stepsBar(1))}
  <form class="container co" id="coForm" novalidate>
    <div>
      <div class="panel"><h3><i>1</i> Seus dados</h3>
        <div class="form">
          <div class="f s3"><label>Nome completo / Razão social *</label><input name="name" required autocomplete="name"></div>
          <div class="f s3"><label>CPF ou CNPJ *</label><input name="doc" required inputmode="numeric" data-mask="doc"></div>
          <div class="f s3"><label>E-mail *</label><input name="email" type="email" required autocomplete="email"></div>
          <div class="f s3"><label>Celular / WhatsApp *</label><input name="phone" required inputmode="numeric" data-mask="phone" autocomplete="tel"></div>
        </div>
      </div>

      <div class="panel"><h3><i>2</i> Entrega</h3>
        <div class="opts">
          <label class="opt on"><input type="radio" name="delivery" value="retirada" checked><div class="t"><b>Retirar na loja</b><small>Rod. Anchieta, 1138 — Vila Moinho Velho, São Paulo/SP</small></div><span class="tag">GRÁTIS</span></label>
          <label class="opt"><input type="radio" name="delivery" value="entrega"><div class="t"><b>Entrega no meu endereço</b><small>Frete calculado pela equipe e combinado pelo WhatsApp após a compra</small></div><span class="tag" style="color:var(--muted)">A COMBINAR</span></label>
        </div>
        <div class="form" id="addr" style="margin-top:18px;display:none">
          <div class="f s2"><label>CEP *</label><input name="cep" inputmode="numeric" data-mask="cep" autocomplete="postal-code"></div>
          <div class="f s4"><label>Endereço *</label><input name="street" autocomplete="address-line1"></div>
          <div class="f s2"><label>Número *</label><input name="number"></div>
          <div class="f s4"><label>Complemento</label><input name="comp"></div>
          <div class="f s2"><label>Bairro *</label><input name="district"></div>
          <div class="f s3"><label>Cidade *</label><input name="city"></div>
          <div class="f" style="grid-column:span 1"><label>UF *</label><input name="uf" maxlength="2"></div>
        </div>
      </div>

      <div class="panel"><h3><i>3</i> Pagamento</h3>
        <div class="opts">${Object.entries(METHODS).map(([k, m]) => {
          const ok = methods.includes(k);
          return `<label class="opt ${ok && k === methods[0] ? "on" : ""} ${ok ? "" : "off"}"><input type="radio" name="method" value="${k}" ${ok && k === methods[0] ? "checked" : ""} ${ok ? "" : "disabled"}>
            <span class="fi" style="width:40px;height:40px">${icon(m.icon)}</span><div class="t"><b>${m.label}</b><small>${ok ? m.sub : "Indisponível para itens em promoção à vista"}</small></div><span class="tag" data-mtotal="${k}"></span></label>`;
        }).join("")}</div>
        <div class="secure">${icon("lock", 16)} ${backendOrders()
          ? "Ao confirmar, seu pedido é registrado e os itens ficam reservados para você. A equipe RSC envia as instruções de pagamento pelo WhatsApp (o pagamento online será habilitado em breve)."
          : "Ao confirmar, seu pedido é enviado à equipe RSC pelo WhatsApp para finalizar o pagamento."}</div>
      </div>
    </div>

    <aside class="panel summary">
      <h3>Seu pedido</h3>
      ${lines.map(({ p, qty }) => `<div class="sum-row"><span>${qty}× ${p.name}</span><span data-line="${p.id}"></span></div>`).join("")}
      <div class="sum-row" style="border-top:1px solid var(--line);margin-top:8px;padding-top:12px"><span>Subtotal</span><span>${brl(lines.reduce((t, l) => t + l.p.price * l.qty, 0))}</span></div>
      <div class="sum-row"><span>Desconto</span><span class="disc" id="sDisc"></span></div>
      <div class="sum-row"><span>Entrega</span><span id="sShip">Grátis</span></div>
      <div class="sum-row total"><span>Total</span><b id="sTotal"></b></div>
      <div class="muted" id="sInst" style="font-size:.85rem;text-align:right"></div>
      ${deadlineWarning()}
      <button class="btn btn-primary btn-block" style="margin-top:18px" id="payBtn" type="submit">${icon("lock", 18)} <span>Confirmar pedido</span></button>
      <div class="alert" id="coErr" style="margin-top:12px;display:none"></div>
      ${backendOrders() ? "" : `<div class="alert" style="margin-top:12px">${icon("info", 18)} <span><b>Modo demonstração:</b> o pedido será enviado ao WhatsApp da loja.</span></div>`}
    </aside>
  </form>`;
}

function mountCheckout() {
  const form = $("#coForm"); if (!form) return;
  const lines = cartLines();
  const totals = method => lines.reduce((t, l) => t + unitPrice(l.p, method) * l.qty, 0);
  const subtotal = lines.reduce((t, l) => t + l.p.price * l.qty, 0);

  const refresh = () => {
    const method = form.method.value;
    const delivery = form.delivery.value;
    $$(".opt", form).forEach(o => o.classList.toggle("on", $("input", o).checked));
    $("#addr").style.display = delivery === "entrega" ? "grid" : "none";
    lines.forEach(l => { $(`[data-line="${l.p.id}"]`).textContent = brl(unitPrice(l.p, method) * l.qty); });
    const total = totals(method);
    $("#sDisc").textContent = total < subtotal ? `− ${brl(subtotal - total)}` : "—";
    $("#sShip").textContent = delivery === "entrega" ? "A combinar" : "Grátis";
    $("#sTotal").textContent = brl(total);
    $("#sInst").textContent = method === "card" ? `ou até ${CFG.maxInstallments}x de ${brl(total / CFG.maxInstallments)}*` : "";
    Object.keys(METHODS).forEach(m => { const el = $(`[data-mtotal="${m}"]`); if (el && !$(`input[value="${m}"]`, form).disabled) el.textContent = brl(totals(m)); });
  };
  form.addEventListener("change", refresh);
  refresh();

  // máscaras
  const masks = {
    phone: v => v.slice(0, 11).replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d{1,4})$/, "$1-$2"),
    cep: v => v.slice(0, 8).replace(/^(\d{5})(\d)/, "$1-$2"),
    doc: v => v.length <= 11
      ? v.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2")
      : v.slice(0, 14).replace(/^(\d{2})(\d)/, "$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d)/, ".$1/$2").replace(/(\d{4})(\d)/, "$1-$2"),
  };
  $$("[data-mask]", form).forEach(i => i.addEventListener("input", () => { i.value = masks[i.dataset.mask](i.value.replace(/\D/g, "")); }));

  // busca de CEP (ViaCEP)
  form.cep.addEventListener("input", async () => {
    const cep = form.cep.value.replace(/\D/g, "");
    if (cep.length !== 8) return;
    try {
      const r = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
      if (r.erro) return;
      form.street.value = r.logradouro || ""; form.district.value = r.bairro || "";
      form.city.value = r.localidade || ""; form.uf.value = r.uf || "";
      form.number.focus();
    } catch {}
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#coErr"); err.style.display = "none";
    const need = ["name", "doc", "email", "phone"];
    if (form.delivery.value === "entrega") need.push("cep", "street", "number", "district", "city", "uf");
    let bad = need.filter(n => !form[n].value.trim());
    const docLen = form.doc.value.replace(/\D/g, "").length;
    if (docLen && docLen !== 11 && docLen !== 14) bad.push("doc");
    if (form.email.value && !/^\S+@\S+\.\S+$/.test(form.email.value)) bad.push("email");
    if (form.phone.value && form.phone.value.replace(/\D/g, "").length < 10) bad.push("phone");
    $$("input", form).forEach(i => i.classList.toggle("err", bad.includes(i.name)));
    if (bad.length) { err.innerHTML = `${icon("info", 18)} Confira os campos destacados em vermelho.`; err.style.display = "flex"; $(`[name="${bad[0]}"]`, form).focus(); return; }

    const fd = Object.fromEntries(new FormData(form));
    const order = {
      items: lines.map(l => ({ id: l.p.id, qty: l.qty })),
      method: fd.method, delivery: fd.delivery,
      buyer: { name: fd.name, doc: fd.doc, email: fd.email, phone: fd.phone,
        address: fd.delivery === "entrega" ? { cep: fd.cep, street: fd.street, number: fd.number, comp: fd.comp, district: fd.district, city: fd.city, uf: fd.uf } : null },
    };

    const btn = $("#payBtn"); btn.disabled = true;

    // Pedido real no backend: ele recalcula preços, confere a disponibilidade e reserva os itens.
    if (backendOrders()) {
      try {
        const res = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          items: order.items.map(i => ({ id: i.id, quantity: i.qty })), method: order.method, delivery: order.delivery,
          customer: { name: fd.name, email: fd.email, phone: fd.phone, document: fd.doc }, address: order.buyer.address,
        }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (data.code === "UNAVAILABLE") { err.innerHTML = `${icon("info", 18)} <span>${data.error} Remova o item do carrinho para continuar.</span>`; }
          else err.innerHTML = `${icon("info", 18)} <span>${data.error || "Não foi possível registrar o pedido."}</span>`;
          err.style.display = "flex"; btn.disabled = false; return;
        }
        cart = {}; saveCart();
        location.hash = `#/pedido/${data.order.token}`;
      } catch {
        btn.disabled = false;
        err.innerHTML = `${icon("info", 18)} Falha de conexão. Tente novamente.`; err.style.display = "flex";
      }
      return;
    }

    // Modo demonstração: envia o pedido ao WhatsApp
    const id = "RSC-" + Date.now().toString(36).toUpperCase();
    const total = totals(fd.method);
    const a = order.buyer.address;
    const msg = [
      `🛒 *Novo pedido pelo site — ${id}*`, "",
      ...lines.map(l => `• ${l.qty}x ${l.p.name} (${l.p.brand}) — ${brl(unitPrice(l.p, fd.method) * l.qty)}`), "",
      `*Total:* ${brl(total)}`,
      `*Pagamento:* ${METHODS[fd.method].label}`,
      `*Entrega:* ${fd.delivery === "entrega" ? "Entrega (frete a combinar)" : "Retirada na loja"}`,
      a ? `*Endereço:* ${a.street}, ${a.number}${a.comp ? " - " + a.comp : ""} - ${a.district}, ${a.city}/${a.uf} - CEP ${a.cep}` : "", "",
      `*Cliente:* ${fd.name}`, `*CPF/CNPJ:* ${fd.doc}`, `*E-mail:* ${fd.email}`, `*Telefone:* ${fd.phone}`,
    ].filter(x => x !== null).join("\n");
    window.open(waLink(msg), "_blank", "noopener");
    cart = {}; saveCart();
    sessionStorage.setItem("rsc-last-order", id);
    location.hash = "#/pedido/enviado";
  });
}

// Aviso obrigatório no carrinho e no checkout (prazo vem do backend; padrão 24h).
function deadlineWarning() {
  const h = DATA.reservationHours || 24;
  return `<div class="alert deadline" style="margin-top:14px">${icon("clock", 18)}<span><b>ATENÇÃO AO PRAZO DE PAGAMENTO</b><br>
    Após confirmar seu pedido, o produto ficará reservado por até ${h} horas. Se o pagamento não for confirmado dentro desse período,
    a reserva poderá expirar e o produto voltará a ficar disponível para compra.</span></div>`;
}
const backendOrders = () => DATA.source === "api";
const dtBR = s => new Date(s).toLocaleString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

// Acompanhamento do pedido (link com token secreto).
function viewOrderTrack() {
  return `${pageHead("Seu pedido", [["Pedido"]], "", stepsBar(2))}<div class="container"><div class="done fade" id="track"><p class="muted">Carregando pedido…</p></div></div>`;
}
async function mountOrderTrack(token) {
  const box = $("#track");
  try {
    const r = await fetch(`/api/orders/${encodeURIComponent(token)}`, { cache: "no-store" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Pedido não encontrado.");
    const o = d.order;
    const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const waiting = o.status === "aguardando_pagamento";
    box.innerHTML = `
      <div class="big">${icon(waiting ? "clock" : o.status === "pago" || o.status === "concluido" ? "check" : "info", 40)}</div>
      <h1>Pedido #${o.number}</h1>
      <p style="margin-bottom:6px">Status: <b style="color:var(--text)">${esc(o.statusLabel)}</b> · Pagamento: <b style="color:var(--text)">${esc(o.payment_status)}</b></p>
      ${waiting && o.reserved_until ? `<div class="alert deadline" style="text-align:left;margin:18px 0">${icon("clock", 18)}<span><b>ATENÇÃO AO PRAZO DE PAGAMENTO</b><br>
        Seus itens estão reservados até <b>${dtBR(o.reserved_until)}</b>. Se o pagamento não for confirmado até lá, a reserva poderá expirar e o produto voltará a ficar disponível para compra.</span></div>` : ""}
      <div class="panel" style="text-align:left;margin-top:14px">
        ${o.items.map(i => `<div class="sum-row"><span>${i.quantity}× ${esc(i.name)} <small class="muted">(${esc(i.sku)})</small></span><span>${brl(i.total_cents / 100)}</span></div>`).join("")}
        ${o.discount_cents ? `<div class="sum-row"><span>Desconto</span><span class="disc">− ${brl(o.discount_cents / 100)}</span></div>` : ""}
        <div class="sum-row total"><span>Total</span><b>${brl(o.total_cents / 100)}</b></div>
      </div>
      ${waiting ? `<p style="margin-top:16px">Guarde este link para acompanhar o pedido. Para pagar, fale com a equipe RSC — o pagamento online será habilitado em breve.</p>` : ""}
      <div style="display:flex;gap:12px;justify-content:center;margin-top:24px;flex-wrap:wrap">
        ${waiting ? `<a href="#" class="btn btn-wa" data-wa="Olá! Fiz o pedido #${o.number} no site (${brl(o.total_cents / 100)}). Como faço o pagamento?">${icon("wa")} Combinar pagamento</a>` : ""}
        <a href="#/loja" class="btn btn-ghost">Continuar comprando</a>
      </div>`;
  } catch (e) {
    box.classList.add("fail");
    box.innerHTML = `<div class="big">${icon("x", 38)}</div><h1>Pedido não encontrado</h1><p>${e.message}</p>`;
  }
}

function viewOrder(status) {
  const id = sessionStorage.getItem("rsc-last-order") || new URLSearchParams(location.search).get("external_reference") || "";
  if (status === "sucesso") { cart = {}; saveCart(); }
  const map = {
    sucesso: ["check", "Pagamento aprovado!", "Recebemos seu pagamento. Nossa equipe vai entrar em contato pelo WhatsApp para combinar a retirada ou entrega.", ""],
    pendente: ["clock", "Pagamento pendente", "Assim que o pagamento for confirmado (PIX ou boleto), você receberá a confirmação por e-mail e nossa equipe entrará em contato.", ""],
    falha: ["x", "Pagamento não concluído", "O pagamento foi recusado ou cancelado. Seu carrinho foi mantido — você pode tentar novamente com outro meio de pagamento.", "fail"],
    enviado: ["wa", "Pedido enviado!", "Seu pedido foi enviado à equipe RSC pelo WhatsApp. Finalize por lá a forma de pagamento e a retirada ou entrega.", ""],
  };
  const [ic, title, text, cls] = map[status] || map.enviado;
  return `${pageHead("Pedido", [["Pedido"]], "", stepsBar(2))}
  <div class="container"><div class="done ${cls} fade">
    <div class="big">${icon(ic, 40)}</div>
    <h1>${title}</h1>
    ${id ? `<p style="margin-bottom:10px">Número do pedido: <b style="color:var(--text)">${id}</b></p>` : ""}
    <p>${text}</p>
    <div style="display:flex;gap:12px;justify-content:center;margin-top:28px;flex-wrap:wrap">
      ${status === "falha" ? `<a href="#/checkout" class="btn btn-primary">Tentar novamente</a>` : `<a href="#/loja" class="btn btn-primary">Continuar comprando</a>`}
      <a href="#" class="btn btn-ghost" data-wa="Olá! Tenho uma dúvida sobre o pedido ${id}.">${icon("wa", 20, "color:var(--green)")} Falar com a loja</a>
    </div>
  </div></div>`;
}

function sellBlock() {
  return `<section class="block" style="padding-top:0"><div class="container">
    <div class="sell">
      <div style="position:relative;z-index:1">
        <span class="eyebrow" style="color:#fff">Também compramos</span>
        <h2>Tem um equipamento parado? A RSC compra!</h2>
        <p>Avaliamos seu equipamento de cozinha industrial, refrigeração ou açougue e fazemos uma proposta justa. Rápido, sem burocracia.</p>
        <a href="#" class="btn btn-dark" data-wa="Olá! Tenho um equipamento para vender. Podem avaliar?">${icon("wa", 20, "color:var(--green)")} Quero vender meu equipamento</a>
      </div>
      <ol><li><i>1</i> Envie fotos e modelo pelo WhatsApp</li><li><i>2</i> Receba a avaliação da nossa equipe</li><li><i>3</i> Feche negócio e receba na hora</li></ol>
    </div>
    <div class="brands"><span>GELOPAR</span><span>METALFRIO</span><span>SKYMSEN</span><span>MACOM</span><span>VULCAN</span></div>
  </div></section>`;
}

function contactBlock() {
  return `<section class="block" style="padding-top:20px"><div class="container">
    <div class="section-head"><div><span class="eyebrow">Visite a loja</span><h2>Venha ver de <span class="grad-text">perto</span></h2></div>
      <p>Todos os equipamentos ficam expostos e podem ser testados na hora. Compras online podem ser retiradas aqui.</p></div>
    <div class="loc">
      <div class="loc-info">
        <div class="loc-row"><div class="fi">${icon("pin")}</div><div><b>Endereço</b><span>Rod. Anchieta, 1138 — Vila Moinho Velho<br>São Paulo/SP · CEP 04246-001</span></div></div>
        <div class="loc-row"><div class="fi">${icon("clock")}</div><div><b>Horário</b><span>Segunda a sexta: 9h às 17h30<br>Sábado: 8h às 11h30</span></div></div>
        <div class="loc-row"><div class="fi">${icon("phone")}</div><div><b>Telefones / WhatsApp</b><a href="tel:+5511957357190">(11) 95735-7190</a><br><a href="tel:+5511964048779">(11) 96404-8779</a></div></div>
        <div class="loc-row"><div class="fi">${icon("ig")}</div><div><b>Instagram</b><a href="https://www.instagram.com/rsc.equipamentos/" target="_blank" rel="noopener">@rsc.equipamentos</a></div></div>
        <a href="https://www.google.com/maps/search/?api=1&query=Rodovia+Anchieta+1138+Vila+Moinho+Velho+São+Paulo" target="_blank" rel="noopener" class="btn btn-primary">Como chegar ${icon("arrow")}</a>
      </div>
      <div class="map"><iframe loading="lazy" title="Mapa RSC Equipamentos" src="https://www.google.com/maps?q=Rodovia+Anchieta,+1138+-+Vila+Moinho+Velho,+S%C3%A3o+Paulo+-+SP,+04246-001&output=embed"></iframe></div>
    </div>
  </div></section>`;
}

function viewNotFound() {
  return `<div class="container"><div class="done fail"><div class="big">${icon("x", 38)}</div><h1>Página não encontrada</h1><p>O conteúdo que você procura não existe ou foi removido.</p><a href="#/loja" class="btn btn-primary" style="margin-top:24px">Ir para a loja</a></div></div>`;
}

/* ---------- Roteador ---------- */
function route() {
  const parts = (location.hash.replace(/^#\/?/, "").split("?")[0] || "").split("/").filter(Boolean);
  const [a, b] = parts;
  let html, mount = () => {}, nav = a || "home";
  switch (a) {
    case undefined: html = viewHome(); break;
    case "loja": html = viewShop(); mount = () => mountShop(); break;
    case "ofertas": html = viewShop({ offers: true }); mount = () => mountShop({ offers: true }); break;
    case "setor": html = viewShop({ slug: b }); mount = () => sector(b) && mountShop({ slug: b }); nav = "loja"; break;
    case "produto": html = viewProduct(b); mount = () => mountProduct(b); nav = "loja"; break;
    case "carrinho": html = viewCart(); mount = mountCart; break;
    case "checkout": html = viewCheckout(); mount = mountCheckout; nav = "carrinho"; break;
    case "pedido":
      if (b && b.length > 15) { html = viewOrderTrack(); mount = () => mountOrderTrack(b); }
      else html = viewOrder(b);
      break;
    case "vender": html = `${pageHead("Venda seu equipamento", [["Venda seu equipamento"]], "Compramos equipamentos para cozinhas industriais, refrigeração e açougue.")}<div style="padding-top:60px"></div>${sellBlock()}`; break;
    case "contato": html = `${pageHead("Contato e loja física", [["Contato"]], "Atendimento presencial e pelo WhatsApp.")}<div style="padding-top:40px"></div>${contactBlock()}`; break;
    default: html = viewNotFound();
  }
  if (html === "") return;
  app.innerHTML = html;
  mount();
  $$("[data-nav]").forEach(l => l.classList.toggle("on", l.dataset.nav === nav));
  const sec = a === "setor" ? b : a === "produto" && product(b) ? product(b).sector : null;
  $$("#sectorbar a").forEach(l => l.classList.toggle("on", l.dataset.s === (sec || (a === "loja" ? "all" : a === "ofertas" ? "ofertas" : ""))));
  $("#menu").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "instant" });
}

/* ---------- Eventos globais ---------- */
document.addEventListener("click", e => {
  const w = e.target.closest("[data-wa]");
  if (w) { e.preventDefault(); window.open(waLink(w.dataset.wa), "_blank", "noopener"); return; }
  const add = e.target.closest("[data-add]");
  if (add) addToCart(add.dataset.add);
});
$("#burger").onclick = () => $("#menu").classList.toggle("open");
window.addEventListener("hashchange", route);
$("#year").textContent = new Date().getFullYear();

// Catálogo: vem do banco (/api/catalog, alimentado pelo painel ADM). Se a API não estiver
// disponível ou o painel ainda não foi configurado, usa o arquivo estático data/products.json.
// Todos os textos são escapados uma vez aqui, pois as telas montam HTML com esses dados.
const escapeDeep = v => typeof v === "string" ? v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
  : Array.isArray(v) ? v.map(escapeDeep)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [escapeDeep(k), escapeDeep(x)])) : v;

async function loadCatalog() {
  try {
    const r = await fetch("/api/catalog", { cache: "no-cache", headers: { Accept: "application/json" } });
    if (r.ok) { const d = await r.json(); if (d.configured) return { ...d, source: "api" }; }
  } catch {}
  return { ...(await (await fetch("data/products.json")).json()), source: "static" };
}

loadCatalog().then(escapeDeep).then(d => {
  DATA = d;
  $("#sectorbar").innerHTML = `<a href="#/loja" data-s="all">Todos os produtos</a>${d.sectors.map(s => `<a href="#/setor/${s.slug}" data-s="${s.slug}">${s.name}</a>`).join("")}<a href="#/ofertas" data-s="ofertas">🔥 Ofertas</a>`;
  $("#footSectors").innerHTML = d.sectors.map(s => `<li><a href="#/setor/${s.slug}">${s.name}</a></li>`).join("");
  // Retorno do Mercado Pago (?status=approved...) → página de pedido
  const st = new URLSearchParams(location.search).get("status");
  if (st && !location.hash) location.hash = `#/pedido/${{ approved: "sucesso", pending: "pendente", in_process: "pendente" }[st] || "falha"}`;
  updateBadge(); route();
});
})();
