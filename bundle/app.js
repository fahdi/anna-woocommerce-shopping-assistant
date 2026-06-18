// ---- bootstrap ---------------------------------------------------------------
// In the Anna host the SDK is served from /static/anna-apps/_sdk/latest/index.js.
// Outside (preview, fixtures), we fall back to a mock that returns sample data.

let anna;
try {
  const { AnnaAppRuntime } = await import("/static/anna-apps/_sdk/latest/index.js");
  anna = await AnnaAppRuntime.connect();
} catch {
  anna = devMockRuntime();
}

// Host writes tool IDs after publish; fall back to the bundled slug for dev.
const TOOL_ID = window.__ANNA_TOOL_IDS__?.["woo-shop"] ?? "bundled:woo-shop";

// ---- state -------------------------------------------------------------------

let cart = null;       // last successful view_cart result
let phase = "loading"; // loading | cart | review | error
let errorMsg = "";
let removingKey = null; // cart_item_key currently being removed

// ---- Anna tool calls ---------------------------------------------------------

async function fetchCart() {
  setPhase("loading");
  try {
    cart = await anna.tools.invoke({ tool_id: TOOL_ID, method: "view_cart", args: {} });
    updateWindowTitle();
    setPhase("cart");
  } catch (err) {
    errorMsg = err.message ?? "Could not load cart.";
    setPhase("error");
  }
}

async function removeItem(key) {
  if (removingKey) return;
  removingKey = key;
  render();
  try {
    cart = await anna.tools.invoke({ tool_id: TOOL_ID, method: "remove_from_cart", args: { cart_item_key: key } });
    removingKey = null;
    updateWindowTitle();
    setPhase("cart");
  } catch (err) {
    removingKey = null;
    errorMsg = err.message ?? "Could not remove item.";
    setPhase("error");
  }
}

// ---- helpers -----------------------------------------------------------------

function setPhase(p) { phase = p; render(); }

function updateWindowTitle() {
  const n = cart?.item_count ?? 0;
  anna.window.set_title({ title: n > 0 ? `Cart (${n})` : "Cart" });
}

function openCheckout() {
  if (cart?.checkout_url) window.open(cart.checkout_url, "_blank", "noopener");
}

// ---- render ------------------------------------------------------------------

function render() {
  const root = document.getElementById("root");
  root.innerHTML = "";

  // Header — always present
  root.appendChild(renderHeader());

  if (phase === "loading") {
    const wrap = el("div", "scroll-area state-center");
    wrap.appendChild(el("div", "spinner"));
    wrap.appendChild(text("p", "Loading cart…"));
    root.appendChild(wrap);
    return;
  }

  if (phase === "error") {
    const wrap = el("div", "scroll-area");
    const banner = el("div", "error-banner");
    banner.textContent = errorMsg;
    wrap.appendChild(banner);
    root.appendChild(wrap);
    const footer = el("div", "footer");
    const btn = btn_("Retry", "btn btn-secondary", fetchCart);
    footer.appendChild(btn);
    root.appendChild(footer);
    return;
  }

  if (phase === "review") {
    renderReview(root);
    return;
  }

  // phase === "cart"
  const scroll = el("div", "scroll-area");

  if (!cart || cart.items.length === 0) {
    const empty = el("div", "state-center");
    empty.appendChild(cartIcon(40));
    empty.appendChild(text("p", "Your cart is empty.\nAsk me to search for products."));
    scroll.appendChild(empty);
  } else {
    cart.items.forEach((item) => scroll.appendChild(renderItem(item)));
    scroll.appendChild(renderTotals());
  }

  root.appendChild(scroll);

  // Footer
  const footer = el("div", "footer");
  if (cart && cart.items.length > 0) {
    footer.appendChild(btn_("Review & Checkout", "btn btn-primary", () => setPhase("review")));
  }
  footer.appendChild(btn_("Refresh", "btn btn-secondary", fetchCart));
  root.appendChild(footer);
}

function renderHeader() {
  const header = el("div", "header");
  header.appendChild(cartIcon(20));
  const title = el("h1");
  title.textContent = "Shopping Cart";
  header.appendChild(title);
  // Refresh icon button
  const refreshBtn = el("button", "btn-icon");
  refreshBtn.title = "Refresh";
  refreshBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
  refreshBtn.addEventListener("click", fetchCart);
  header.appendChild(refreshBtn);
  return header;
}

function renderItem(item) {
  const wrap = el("div", "item");

  // Placeholder image (no external img allowed by CSP, store images are https:)
  // img-src allows https: per manifest csp_overrides so real images are fine.
  if (item.image) {
    const img = document.createElement("img");
    img.className = "item-img";
    img.src = item.image;
    img.alt = item.name;
    img.onerror = () => img.replaceWith(imgPlaceholder());
    wrap.appendChild(img);
  } else {
    wrap.appendChild(imgPlaceholder());
  }

  const body = el("div", "item-body");
  const name = el("div", "item-name");
  name.textContent = item.name;
  body.appendChild(name);

  const meta = el("div", "item-meta");
  meta.textContent = `Qty: ${item.quantity}`;
  body.appendChild(meta);

  const footer = el("div", "item-footer");
  const price = el("div", "item-price");
  price.textContent = item.line_total?.formatted ?? "";
  footer.appendChild(price);

  const removeBtn = el("button", "btn-remove");
  removeBtn.textContent = removingKey === item.cart_item_key ? "Removing…" : "Remove";
  removeBtn.disabled = removingKey !== null;
  removeBtn.addEventListener("click", () => removeItem(item.cart_item_key));
  footer.appendChild(removeBtn);

  body.appendChild(footer);
  wrap.appendChild(body);
  return wrap;
}

function renderTotals() {
  const row = el("div", "totals");
  const label = el("span", "totals-label");
  label.textContent = `${cart.item_count} item${cart.item_count !== 1 ? "s" : ""}`;
  const amount = el("span", "totals-amount");
  amount.textContent = cart.total?.formatted ?? "";
  row.appendChild(label);
  row.appendChild(amount);
  return row;
}

function renderReview(root) {
  const scroll = el("div", "scroll-area");
  const panel = el("div", "review-panel");

  const heading = el("h2");
  heading.textContent = "Ready to check out?";
  panel.appendChild(heading);

  const summary = el("p");
  summary.textContent = `You have ${cart.item_count} item${cart.item_count !== 1 ? "s" : ""} totalling ${cart.total?.formatted ?? ""}.`;
  panel.appendChild(summary);

  if (cart.items.length > 0) {
    const list = el("ul", "review-bullets");
    cart.items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = `${item.name} × ${item.quantity} — ${item.line_total?.formatted ?? ""}`;
      list.appendChild(li);
    });
    panel.appendChild(list);
  }

  const note = el("p");
  note.textContent = "Clicking Proceed will open the store checkout in a new tab. Payment happens on the store's secure page — not here.";
  panel.appendChild(note);

  const actions = el("div", "review-actions");
  actions.appendChild(btn_("Proceed to Checkout", "btn btn-primary", openCheckout));
  actions.appendChild(btn_("Back to Cart", "btn btn-secondary", () => setPhase("cart")));
  panel.appendChild(actions);

  scroll.appendChild(panel);
  root.appendChild(scroll);
}

// ---- tiny DOM helpers --------------------------------------------------------

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function text(tag, content) {
  const e = el(tag);
  e.textContent = content;
  return e;
}

function btn_(label, cls, onClick) {
  const b = el("button", cls);
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function imgPlaceholder() {
  const wrap = el("div", "item-img-placeholder");
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  return wrap;
}

function cartIcon(size) {
  const wrap = document.createElement("span");
  wrap.style.lineHeight = "0";
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>`;
  return wrap;
}

// ---- dev mock (used when Anna SDK is unavailable: preview, fixtures) ---------

function devMockRuntime() {
  const MOCK_CART = {
    items: [
      { cart_item_key: "abc1", name: "Hoodie", quantity: 1, line_total: { formatted: "$45.00" }, image: null },
      { cart_item_key: "abc2", name: "Cap",    quantity: 2, line_total: { formatted: "$30.00" }, image: null },
    ],
    item_count: 3,
    total: { formatted: "$75.00" },
    checkout_url: "#",
  };
  let mockCart = structuredClone(MOCK_CART);

  return {
    tools: {
      invoke: async ({ method, args = {} } = {}) => {
        await new Promise((r) => setTimeout(r, 300));
        if (method === "view_cart") return mockCart;
        if (method === "remove_from_cart") {
          mockCart = {
            ...mockCart,
            items: mockCart.items.filter((i) => i.cart_item_key !== args.cart_item_key),
            item_count: mockCart.item_count - 1,
          };
          return mockCart;
        }
        throw new Error(`mock: unknown tool ${method}`);
      },
    },
    window: { set_title: ({ title } = {}) => { document.title = title ?? "Cart"; } },
    chat: { writeMessage: (msg) => console.log("[mock chat]", msg) },
  };
}

// ---- init --------------------------------------------------------------------

render();     // show loading state immediately
fetchCart();  // kick off live fetch
