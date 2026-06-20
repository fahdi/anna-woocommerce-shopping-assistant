// ---- bootstrap --------------------------------------------------------------- v0.1.48
let anna;
try {
  const { AnnaAppRuntime } = await import("/static/anna-apps/_sdk/latest/index.js");
  anna = await AnnaAppRuntime.connect();
} catch {
  anna = devMockAnna();
}

// ---- WooCommerce client (direct fetch - CORS enabled on store) ---------------
// The store at DEV_STORE has Access-Control-Allow-Origin: https://anna.partners
// so all fetches work directly from the panel iframe without a server proxy.

const STORE = "https://woo.isupercoder.com";
const API   = STORE + "/wp-json/wc/store/v1";
const TOKEN_KEY = "woo_cart_token";

function getToken()   { return localStorage.getItem(TOKEN_KEY); }
function saveToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); }

async function storeFetch(path, { method = "GET", body } = {}) {
  const token = getToken();
  const headers = { Accept: "application/json" };
  if (body)  headers["Content-Type"] = "application/json";
  if (token) headers["Cart-Token"] = token;
  if (method !== "GET") {
    const seed = await fetch(API + "/cart", { cache: "no-store", headers: { Accept: "application/json", ...(token ? { "Cart-Token": token } : {}) } });
    const nonce  = seed.headers.get("nonce") || seed.headers.get("x-wc-store-api-nonce");
    const seedTk = seed.headers.get("cart-token");
    // Only bootstrap token from seed when we have none - CDN may return stale cached tokens
    if (seedTk && !token) { saveToken(seedTk); headers["Cart-Token"] = seedTk; }
    if (nonce) headers["Nonce"] = nonce;
  }
  const res = await fetch(API + path, { cache: "no-store", method, headers, body: body ? JSON.stringify(body) : undefined });
  const tk2 = res.headers.get("cart-token");
  // POST responses carry the definitive cart token; GET responses may be CDN-cached stale tokens
  if (tk2 && (method !== "GET" || !getToken())) saveToken(tk2);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Store API ${res.status}`);
  return data;
}

function money(prices, field = "price") {
  if (!prices) return null;
  const minor = Number(prices.currency_minor_unit ?? 2);
  const raw   = Number(prices[field] ?? 0) / 10 ** minor;
  const sym   = prices.currency_symbol || prices.currency_prefix || "$";
  return { amount: raw, currency: prices.currency_code || "USD", formatted: `${sym}${raw.toFixed(minor)}` };
}

function normalizeProduct(p) {
  return {
    id:                p.id,
    name:              p.name?.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&") || "",
    slug:              p.slug,
    permalink:         p.permalink,
    price:             money(p.prices, "price"),
    regular_price:     money(p.prices, "regular_price"),
    on_sale:           Boolean(p.on_sale),
    in_stock:          p.is_in_stock !== false,
    has_variations:    p.type === "variable" || (Array.isArray(p.variations) && p.variations.length > 0),
    short_description: (p.short_description || "").replace(/<[^>]*>/g, "").trim(),
    image:             p.images?.[0]?.src || null,
  };
}

function normalizeCart(cart) {
  const totals = cart.totals || {};
  const minor  = Number(totals.currency_minor_unit ?? 2);
  const sym    = totals.currency_symbol || "$";
  const fmt    = (v) => `${sym}${(Number(v || 0) / 10 ** minor).toFixed(minor)}`;
  return {
    items: (cart.items || []).map((i) => ({
      cart_item_key: i.key,
      product_id:    i.id,
      name:          i.name,
      quantity:      i.quantity,
      image:         i.images?.[0]?.src || null,
      line_total:    { formatted: fmt(i.totals?.line_total) },
    })),
    item_count:   cart.items_count ?? (cart.items || []).reduce((n, i) => n + i.quantity, 0),
    total:        { formatted: fmt(totals.total_price) },
    checkout_url: `${STORE}/checkout/`,
  };
}

// ---- unified API -------------------------------------------------------------

async function wooSearch(filter = {}) {
  const f = typeof filter === "string" ? { query: filter } : (filter || {});
  const { query = "", min_price, max_price, category } = f;
  const hasPrice = min_price != null && !Number.isNaN(Number(min_price))
    || max_price != null && !Number.isNaN(Number(max_price));
  // The Store API price filter needs a WC lookup table that may be unpopulated,
  // so we over-fetch and filter client-side (mirrors executas/woo-shop/woo-client.js).
  const perPage = hasPrice || category ? 50 : 12;
  const qs = new URLSearchParams();
  if (query)    qs.set("search", query);
  if (category) qs.set("category", category);
  qs.set("per_page", String(perPage));
  let rows = await storeFetch(`/products?${qs.toString()}`);
  if (hasPrice) {
    rows = rows.filter((p) => {
      const minor   = Number(p.prices?.currency_minor_unit ?? 2);
      const dollars = Number(p.prices?.price ?? 0) / 10 ** minor;
      if (min_price != null && !Number.isNaN(Number(min_price)) && dollars < Number(min_price)) return false;
      if (max_price != null && !Number.isNaN(Number(max_price)) && dollars > Number(max_price)) return false;
      return true;
    });
  }
  rows = rows.slice(0, 12);
  return { count: rows.length, products: rows.map(normalizeProduct) };
}

async function wooAddToCart(productId, quantity = 1) {
  const cart = await storeFetch("/cart/add-item", { method: "POST", body: { id: productId, quantity } });
  return normalizeCart(cart);
}

async function wooViewCart() {
  const cart = await storeFetch("/cart");
  return normalizeCart(cart);
}

async function wooRemoveFromCart(key) {
  const cart = await storeFetch("/cart/remove-item", { method: "POST", body: { key } });
  return normalizeCart(cart);
}

// ---- state -------------------------------------------------------------------
let tab = "shop";
let searchQuery = "";
let searchFilter = { query: "" };  // { query, min_price?, max_price?, category? }
let products = null;      // null | { count, products: [] }
let searching = false;
let searchError = "";
let noSession = false;    // true when executa not running (no active agent session)

let cart = null;
let cartLoading = false;
let cartPhase = "cart";   // "cart" | "review" | "error"
let cartError = "";
let removingKey = null;
let addingId = null;

let toastMsg = "";
let toastTimer = null;

// ---- actions -----------------------------------------------------------------

async function doSearch(filter) {
  const f = typeof filter === "string" ? { query: filter } : (filter || { query: "" });
  searchFilter = f;
  searchQuery = f.query || "";
  searchError = "";
  noSession = false;
  searching = true;
  render();
  try {
    products = await wooSearch(f);
  } catch (err) {
    products = null;
    if (isNoSession(err)) {
      noSession = true;
    } else {
      searchError = err.message ?? "Search failed - try again.";
    }
  }
  searching = false;
  render();
}

async function doAddToCart(productId) {
  if (addingId !== null) return;
  addingId = productId;
  render();
  try {
    cart = await wooAddToCart(productId, 1);
    updateWindowTitle();
    showToast("Added to cart!");
  } catch (err) {
    showToast(err.message ?? "Couldn't add item - try again.");
  }
  addingId = null;
  render();
}

async function fetchCart() {
  cartLoading = true;
  cartError = "";
  cartPhase = "cart";
  render();
  try {
    cart = await wooViewCart();
    updateWindowTitle();
  } catch (err) {
    cartError = isNoSession(err) ? "Start a chat to manage your cart." : (err.message ?? "Could not load cart.");
    cartPhase = "error";
  }
  cartLoading = false;
  render();
}

async function removeItem(key) {
  if (removingKey) return;
  removingKey = key;
  render();
  try {
    cart = await wooRemoveFromCart(key);
    updateWindowTitle();
  } catch (err) {
    cartError = err.message ?? "Could not remove item.";
    cartPhase = "error";
  }
  removingKey = null;
  render();
}

function openCheckout() {
  const token = getToken();
  const url = token
    ? `${STORE}/?anna_checkout=${encodeURIComponent(token)}&_cb=${Date.now()}`
    : (cart?.checkout_url ?? `${STORE}/checkout/`);
  window.open(url, "_blank", "noopener");
}

// ---- helpers -----------------------------------------------------------------

function isNoSession(err) {
  const msg = err?.message || "";
  return msg.includes("Plugin not found") || msg.includes("not found") || msg.includes("unavailable");
}

function updateWindowTitle() {
  const n = cart?.item_count ?? 0;
  anna.window.set_title({ title: n > 0 ? `Shop (${n} in cart)` : "Shop" });
}

function showToast(msg) {
  if (toastTimer) clearTimeout(toastTimer);
  toastMsg = msg;
  render();
  toastTimer = setTimeout(() => { toastMsg = ""; render(); }, 2500);
}

function switchTab(t) {
  tab = t;
  if (t === "cart" && !cart && !cartLoading) fetchCart();
  render();
}

// ---- render ------------------------------------------------------------------

function render() {
  const root = document.getElementById("root");
  root.innerHTML = "";
  root.appendChild(renderHeader());
  if (tab === "shop") renderShopTab(root);
  else renderCartTab(root);
  if (toastMsg) root.appendChild(renderToast());
}

// ---- header ------------------------------------------------------------------

function renderHeader() {
  const header = el("div", "header");
  const tabs   = el("div", "tabs");

  const shopTab = el("button", "tab-btn" + (tab === "shop" ? " active" : ""));
  shopTab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Shop`;
  shopTab.addEventListener("click", () => switchTab("shop"));

  const cartTab = el("button", "tab-btn" + (tab === "cart" ? " active" : ""));
  const cartCount = cart?.item_count ?? 0;
  cartTab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg> Cart`;
  if (cartCount > 0) {
    const badge = el("span", "badge");
    badge.textContent = cartCount;
    cartTab.appendChild(badge);
  }
  cartTab.addEventListener("click", () => switchTab("cart"));

  tabs.appendChild(shopTab);
  tabs.appendChild(cartTab);
  header.appendChild(tabs);
  return header;
}

// ---- shop tab ----------------------------------------------------------------

function renderShopTab(root) {
  const searchWrap = el("div", "search-wrap");
  const input = document.createElement("input");
  input.className = "search-input";
  input.type = "text";
  input.placeholder = "Search products…";
  input.value = searchQuery;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) doSearch(input.value.trim());
  });

  const searchBtn = el("button", "btn btn-search" + (searching ? " loading" : ""));
  searchBtn.textContent = searching ? "Searching…" : "Search";
  searchBtn.disabled = searching;
  searchBtn.addEventListener("click", () => {
    if (input.value.trim()) doSearch(input.value.trim());
  });

  searchWrap.appendChild(input);
  searchWrap.appendChild(searchBtn);
  root.appendChild(searchWrap);

  const scroll = el("div", "scroll-area");

  if (searching) {
    const center = el("div", "state-center");
    center.appendChild(el("div", "spinner"));
    scroll.appendChild(center);
  } else if (noSession) {
    const center = el("div", "state-center");
    center.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <p>Chat with Anna first - she'll search the store and open the results here for you.</p>
    `;
    scroll.appendChild(center);
  } else if (searchError) {
    const banner = el("div", "error-banner");
    banner.textContent = searchError;
    scroll.appendChild(banner);
  } else if (!products) {
    const center = el("div", "state-center");
    center.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <p>Search the store above to browse products</p>
    `;
    scroll.appendChild(center);
  } else if (products.count === 0) {
    const center = el("div", "state-center");
    const p = document.createElement("p");
    p.textContent = `No products found${describeFilterSuffix()}`;
    center.appendChild(p);
    scroll.appendChild(center);
  } else {
    const count = el("div", "results-count");
    count.textContent = describeResults(products.count);
    scroll.appendChild(count);

    const grid = el("div", "product-grid");
    products.products.forEach((p) => grid.appendChild(renderProductCard(p)));
    scroll.appendChild(grid);
  }

  root.appendChild(scroll);
}

function renderProductCard(p) {
  const card = el("div", "product-card");

  const imgWrap = el("div", "product-img-wrap");
  if (p.image) {
    const img = document.createElement("img");
    img.className = "product-img";
    img.src = p.image;
    img.alt = p.name;
    img.loading = "lazy";
    img.onerror = () => img.replaceWith(productImgPlaceholder());
    imgWrap.appendChild(img);
  } else {
    imgWrap.appendChild(productImgPlaceholder());
  }
  if (p.on_sale) {
    const saleBadge = el("span", "sale-badge");
    saleBadge.textContent = "Sale";
    imgWrap.appendChild(saleBadge);
  }
  card.appendChild(imgWrap);

  const body = el("div", "product-body");

  const name = el("div", "product-name");
  name.textContent = p.name;
  body.appendChild(name);

  const stockBadge = el("span", p.in_stock ? "stock-badge in-stock" : "stock-badge out-of-stock");
  stockBadge.textContent = p.in_stock ? "✓ In stock" : "✗ Out of stock";
  body.appendChild(stockBadge);

  if (p.short_description) {
    const desc = el("div", "product-desc");
    desc.textContent = p.short_description;
    body.appendChild(desc);
  }

  const priceRow = el("div", "product-price-row");
  const price = el("span", "product-price");
  price.textContent = p.price?.formatted ?? "";
  priceRow.appendChild(price);
  if (p.on_sale && p.regular_price?.formatted && p.regular_price.formatted !== p.price?.formatted) {
    const orig = el("span", "product-price-orig");
    orig.textContent = p.regular_price.formatted;
    priceRow.appendChild(orig);
  }
  body.appendChild(priceRow);

  const actionRow = el("div", "product-action-row");

  if (p.permalink) {
    const viewLink = document.createElement("a");
    viewLink.className = "btn-view";
    viewLink.href = p.permalink;
    viewLink.target = "_blank";
    viewLink.rel = "noopener noreferrer";
    viewLink.textContent = "View";
    actionRow.appendChild(viewLink);
  }

  if (p.has_variations) {
    const optBtn = document.createElement("a");
    optBtn.className = "btn btn-atc";
    optBtn.href = p.permalink;
    optBtn.target = "_blank";
    optBtn.rel = "noopener noreferrer";
    optBtn.textContent = "Select Options";
    actionRow.appendChild(optBtn);
  } else {
    const isAdding = addingId === p.id;
    const atcBtn = el("button", "btn btn-atc" + (isAdding ? " loading" : "") + (!p.in_stock ? " oos" : ""));
    atcBtn.textContent = isAdding ? "Adding…" : p.in_stock ? "Add to Cart" : "Out of Stock";
    atcBtn.disabled = !p.in_stock || addingId !== null;
    atcBtn.addEventListener("click", () => doAddToCart(p.id));
    actionRow.appendChild(atcBtn);
  }

  body.appendChild(actionRow);
  card.appendChild(body);
  return card;
}

// ---- cart tab ----------------------------------------------------------------

function renderCartTab(root) {
  const scroll = el("div", "scroll-area");

  if (cartLoading) {
    const center = el("div", "state-center");
    center.appendChild(el("div", "spinner"));
    const p = document.createElement("p");
    p.textContent = "Loading cart…";
    center.appendChild(p);
    scroll.appendChild(center);
    root.appendChild(scroll);
    return;
  }

  if (cartPhase === "error") {
    const banner = el("div", "error-banner");
    banner.textContent = cartError;
    scroll.appendChild(banner);
    root.appendChild(scroll);
    const footer = el("div", "footer");
    footer.appendChild(btn_("Retry", "btn btn-secondary", fetchCart));
    root.appendChild(footer);
    return;
  }

  if (cartPhase === "review") {
    renderReview(root);
    return;
  }

  if (!cart || cart.items.length === 0) {
    const center = el("div", "state-center");
    center.innerHTML = `
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
      </svg>
      <p>Your cart is empty.<br>Search for products in the Shop tab.</p>
    `;
    scroll.appendChild(center);
  } else {
    cart.items.forEach((item) => scroll.appendChild(renderCartItem(item)));
    scroll.appendChild(renderTotals());
  }

  root.appendChild(scroll);

  const footer = el("div", "footer");
  if (cart && cart.items.length > 0) {
    footer.appendChild(btn_("Review & Checkout", "btn btn-primary", () => { cartPhase = "review"; render(); }));
  }
  footer.appendChild(btn_("Refresh", "btn btn-secondary", fetchCart));
  root.appendChild(footer);
}

function renderCartItem(item) {
  const wrap = el("div", "item");
  if (item.image) {
    const img = document.createElement("img");
    img.className = "item-img";
    img.src = item.image;
    img.alt = item.name;
    img.onerror = () => img.replaceWith(cartImgPlaceholder());
    wrap.appendChild(img);
  } else {
    wrap.appendChild(cartImgPlaceholder());
  }
  const body   = el("div", "item-body");
  const name   = el("div", "item-name"); name.textContent = item.name; body.appendChild(name);
  const meta   = el("div", "item-meta"); meta.textContent = `Qty: ${item.quantity}`; body.appendChild(meta);
  const footer = el("div", "item-footer");
  const price  = el("div", "item-price"); price.textContent = item.line_total?.formatted ?? ""; footer.appendChild(price);
  const rm     = el("button", "btn-remove");
  rm.textContent = removingKey === item.cart_item_key ? "Removing…" : "Remove";
  rm.disabled    = removingKey !== null;
  rm.addEventListener("click", () => removeItem(item.cart_item_key));
  footer.appendChild(rm);
  body.appendChild(footer);
  wrap.appendChild(body);
  return wrap;
}

function renderTotals() {
  const row    = el("div", "totals");
  const label  = el("span", "totals-label");
  label.textContent = `${cart.item_count} item${cart.item_count !== 1 ? "s" : ""}`;
  const amount = el("span", "totals-amount");
  amount.textContent = cart.total?.formatted ?? "";
  row.appendChild(label);
  row.appendChild(amount);
  return row;
}

function renderReview(root) {
  const scroll  = el("div", "scroll-area");
  const panel   = el("div", "review-panel");
  const heading = document.createElement("h2");
  heading.textContent = "Ready to check out?";
  panel.appendChild(heading);
  const summary = document.createElement("p");
  summary.textContent = `You have ${cart.item_count} item${cart.item_count !== 1 ? "s" : ""} totalling ${cart.total?.formatted ?? ""}.`;
  panel.appendChild(summary);
  if (cart.items.length > 0) {
    const list = document.createElement("ul");
    list.className = "review-bullets";
    cart.items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = `${item.name} × ${item.quantity} - ${item.line_total?.formatted ?? ""}`;
      list.appendChild(li);
    });
    panel.appendChild(list);
  }
  const note = document.createElement("p");
  note.textContent = "Clicking Proceed will open the store checkout in a new tab. Payment happens on the store's secure page - not here.";
  panel.appendChild(note);
  const actions = el("div", "review-actions");
  actions.appendChild(btn_("Proceed to Checkout", "btn btn-primary", openCheckout));
  actions.appendChild(btn_("Back to Cart", "btn btn-secondary", () => { cartPhase = "cart"; render(); }));
  panel.appendChild(actions);
  scroll.appendChild(panel);
  root.appendChild(scroll);
}

function renderToast() {
  const toast = el("div", "toast");
  toast.textContent = toastMsg;
  return toast;
}

// ---- result labelling --------------------------------------------------------
// Human label for the active filter, e.g. ' for "tie" under $20'.
function describeFilterSuffix() {
  const { query, min_price, max_price } = searchFilter || {};
  const parts = [];
  if (query) parts.push(` for "${query}"`);
  if (min_price != null && max_price != null) parts.push(` between $${min_price} and $${max_price}`);
  else if (max_price != null)                 parts.push(` under $${max_price}`);
  else if (min_price != null)                 parts.push(` over $${min_price}`);
  return parts.join("");
}

function describeResults(n) {
  const suffix = describeFilterSuffix();
  if (suffix) return `${n} result${n !== 1 ? "s" : ""}${suffix}`;
  return `${n} product${n !== 1 ? "s" : ""} available`;
}

// ---- DOM helpers -------------------------------------------------------------

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function btn_(label, cls, onClick) {
  const b = el("button", cls);
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function productImgPlaceholder() {
  const wrap = el("div", "product-img-placeholder");
  wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  return wrap;
}

function cartImgPlaceholder() {
  const wrap = el("div", "item-img-placeholder");
  wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  return wrap;
}

// ---- dev mock (Anna SDK) -----------------------------------------------------

function devMockAnna() {
  return {
    entryPayload: {},
    on: () => () => {},  // no-op subscribe returning a no-op unsubscribe
    window: {
      set_title: ({ title } = {}) => { document.title = title ?? "Shop"; },
      hello: async () => ({ entry_payload: {} }),
    },
    tools:  { invoke: async () => ({ success: false, error: "Plugin not found (dev mock)" }) },
  };
}

// ---- init --------------------------------------------------------------------
render();

// Pre-load cart count for the badge (silently - don't block or show errors on init)
fetchCart().catch(() => {});

// Auto-search on open. The agent drives the panel by calling
//   open_app_view(view="cart", payload={ q, min_price, max_price })
// The host delivers that payload as the window's entry_payload — available on
// connect (anna.entryPayload) AND re-delivered as an "entry_payload" event when
// the agent re-opens the already-open panel (single_instance view). We do NOT
// poll anna.storage: the executa's aps.kv and the app's anna.storage are
// separate stores, so that bridge never delivered the query.
function filterFromUrl() {
  const p = new URLSearchParams(location.search.length > 1 ? location.search : location.hash.replace(/^#\/?/, ""));
  const num = (k) => (p.has(k) && p.get(k) !== "" ? Number(p.get(k)) : undefined);
  return {
    query:     p.has("q") ? p.get("q") : "",
    min_price: num("min_price"),
    max_price: num("max_price"),
    category:  p.has("category") && p.get("category") !== "" ? p.get("category") : undefined,
  };
}

// Build a filter from an agent-supplied payload ({ q|query, min_price, max_price,
// category }). Returns null when the payload carries no search intent.
//
// IMPORTANT: open_app_view MERGES the payload into the window's existing
// entry_payload (shallow, last-writer-wins per key) — it does NOT replace it. So
// a stale price filter survives a later text search unless the agent re-sends
// the price keys. By convention the agent always sends all three keys, using 0
// (or empty) to mean "no price limit"; we map 0/empty/null/negative → undefined
// so a cleared filter actually clears.
function filterFromPayload(p) {
  if (!p || typeof p !== "object") return null;
  const keys = ["q", "query", "min_price", "max_price", "category"];
  if (!keys.some((k) => k in p)) return null;
  const price = (v) => {
    const n = Number(v);
    return v == null || v === "" || Number.isNaN(n) || n <= 0 ? undefined : n;
  };
  return {
    query:     p.q ?? p.query ?? "",
    min_price: price(p.min_price),
    max_price: price(p.max_price),
    category:  (p.category === "" || p.category == null) ? undefined : p.category,
  };
}

// First paint: entry_payload (agent) wins, else URL params, else browse-all.
const _initFilter = filterFromPayload(anna.entryPayload) ?? filterFromUrl();
doSearch(_initFilter);

// Live sync: when the agent calls open_app_view(view="cart", payload={...}) on
// the already-open panel, the host updates THIS window's entry_payload but does
// NOT push an event to the loaded iframe. So we poll window.hello() — which
// returns the live entry_payload — and re-run the search when it changes.
let _lastPayloadKey = JSON.stringify(filterFromPayload(anna.entryPayload));
async function pollEntryPayload() {
  try {
    if (anna.window && typeof anna.window.hello === "function") {
      const hello = await anna.window.hello({});
      const f = filterFromPayload(hello?.entry_payload);
      const key = JSON.stringify(f);
      if (f && key !== _lastPayloadKey) {
        _lastPayloadKey = key;
        tab = "shop";
        doSearch(f);
      }
    }
  } catch (_) { /* token refresh races — ignore, retry next tick */ }
  setTimeout(pollEntryPayload, 1500);
}
pollEntryPayload();

// Also honor the documented entry_payload event in case a future host emits it.
if (typeof anna.on === "function") {
  anna.on("entry_payload", (p) => {
    const f = filterFromPayload(p);
    if (f) { _lastPayloadKey = JSON.stringify(f); tab = "shop"; doSearch(f); }
  });
}

