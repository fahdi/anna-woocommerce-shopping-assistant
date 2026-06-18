# WooCommerce AI Shopping Assistant as an Anna App — Build Plan

Project name (chosen): **anna-woocommerce-shopping-assistant**. Rationale: distinctive, describes the integration, and keeps the WooCommerce reference at the end (same naming discipline WP.org enforced on the plugin).

Source assistant: `fahad-ai-shopping-assistant-for-woocommerce` (WordPress/WooCommerce plugin, 5-tool REST loop).
Target: an Anna App for the Anna hackathon (build week June 15 to 22, 2026).

---

## 1. TL;DR / approach

Build a **schema-2 Anna App** that bundles:

1. **One Executa tool process** (`woo-shop`, Node.js) exposing the same five shopping tools the plugin already has, but talking to the store over the **WooCommerce Store API + REST API** instead of running inside WordPress.
2. **An embedded UI** (static SPA) for the "review moments" Jiao highlighted: show the cart and require explicit confirmation before checkout.
3. **Behavior** ported from the current system prompt into `system_prompt_addendum` (plus an optional SKILL.md for shopping etiquette).

**Biggest simplification from the study:** Anna's host agent drives the tool loop and provides the model via reverse-RPC **sampling**. So the Anna App needs **no Anthropic/Moonshot keys and no agent loop of our own**. We delete `class-api-handler.php`'s entire provider/streaming layer for this target (and with it the `/stream`-always-uses-Moonshot bug found during mapping). The Executa is just the WooCommerce tool surface; Anna handles the LLM, streaming, and the chat surface.

---

## 2. How our plugin maps onto Anna primitives

| Existing plugin piece | Anna App equivalent | Notes |
|---|---|---|
| 5 REST tools (`search_products`, `get_product_details`, `add_to_cart`, `view_cart`, `remove_from_cart`) | `tools[]` (5 entries) in one Executa `describe` manifest | invoke routes by `params.tool`. Keep 5 tools (best LLM ergonomics, 1:1 with today) rather than one dispatcher tool. |
| Anthropic + Moonshot agent loop, SSE streaming | **Deleted.** Anna's agent + reverse-RPC `sampling/createMessage` owns the model, billing, and streaming | No provider keys in the app. Removes the streaming bug entirely. |
| System prompt in `get_system_prompt()` | `manifest.system_prompt_addendum` (max 4000 chars) + optional `SKILL.md` | Port linking/etiquette rules; adapt to Anna chat. |
| WooCommerce data via in-process `wc_get_products` / `WC()->cart` | Executa calls **WC Store API** (`/wp-json/wc/store/v1/*`, session cart) + **WC REST v3** (`/wp-json/wc/v3/*`, catalog) over HTTPS | The plugin's own `fahad-ai/v1` endpoints are LLM-mediated and nonce/same-origin gated, so they are not a clean programmatic channel. Use the Store API + v3 directly. |
| Nonce + rate-limited public endpoints | Not needed | Anna invokes the Executa over stdio; auth to the store is via store credentials (below). |
| API keys stored in `wp_options` | `manifest.credentials[]`, injected per-invoke via `params.context.credentials` | `WOO_STORE_URL`, `WOO_CONSUMER_KEY` (sensitive), `WOO_CONSUMER_SECRET` (sensitive). No OAuth needed. |
| Cart bound to WP session cookie (`wc_load_cart()`) | **WC Store API `Cart-Token` persisted in APS storage** (scope user/tool) | This is the main new engineering problem (see Risks). |
| Money as `wc_price()` HTML | Return raw numeric + a formatted string | Cleaner for the Anna UI than HTML spans; an improvement over the plugin. |

---

## 3. Anna App architecture

### 3.1 Executa `woo-shop` (Node.js, JSON-RPC 2.0 over stdio)
- Long-running process: read stdin line by line, one JSON object per line, respond on stdout (protocol only), log to stderr. Never exit after one request.
- Methods: `describe`, `invoke`, `health`, and `initialize` (v2, to negotiate APS storage for the Cart-Token).
- `describe` returns the manifest with `tools[]` (5 tools, Executa-style `parameters[]` of `{name,type,required,description,default}` — NOT MCP `input_schema`).
- `invoke` reads `{tool, arguments, context}`, routes on `params.tool`, calls the store, returns `{success:true, data:{...}}` (or `{success:false, error}`). The `{success,data}` wrapper is mandatory.
- `context.credentials` carries `WOO_*`; never logged, never cached module-global (request-scoped — one process serves many users).

Why Node: matches the team's existing vanilla-JS work, has an Anna Node SDK, and `fetch` to the WC REST/Store API is trivial.

### 3.2 Embedded UI (schema 2, static SPA in `bundle/`)
- `index.html` + `app.js` (external ES module, because CSP `script-src 'self'` blocks inline scripts) + `style.css` + `icon.svg`. Port the existing `chatbot.css` look.
- `app.js`: `import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js"; const anna = await AnnaAppRuntime.connect();` then read `window.__ANNA_TOOL_IDS__["woo-shop"]`.
- Functions: render current cart (`anna.tools.invoke` view_cart), a **review step** before checkout, and a "Proceed to checkout" that opens the store checkout URL.

### 3.3 Behavior
- `system_prompt_addendum`: ported shopping rules (always search/get-details before recommending; confirm before add; review cart before checkout; defer order/account/returns to store support). Keep under 4000 chars.
- Optional `SKILL.md` (`executa_type: skill`) for tone/linking conventions.

---

## 4. Draft `manifest.json` (schema 2)

```json
{
  "schema": 2,
  "permissions": ["tools.invoke", "chat.write_message", "storage.read", "storage.write", "ui.svg"],
  "required_executas": [
    { "tool_id": "bundled:woo-shop", "min_version": "0.1.0", "version": "latest" }
  ],
  "optional_executas": [],
  "credentials": [
    { "name": "WOO_STORE_URL",       "display_name": "Store URL",        "description": "https://store.example.com", "required": true,  "sensitive": false },
    { "name": "WOO_CONSUMER_KEY",    "display_name": "WC Consumer Key",  "description": "WooCommerce REST API key",   "required": true,  "sensitive": true },
    { "name": "WOO_CONSUMER_SECRET", "display_name": "WC Consumer Secret","description": "WooCommerce REST API secret","required": true,  "sensitive": true }
  ],
  "system_prompt_addendum": "You are a shopping assistant for this WooCommerce store. Always call search_products or get_product_details before recommending; never invent product details. Confirm the product before add_to_cart. Use view_cart before checkout and let the shopper review changes before anything is committed. Defer order status, account, and returns to store support.",
  "user_message_prefix_template": "[Shop] {user_message}",
  "tags": ["woocommerce", "shopping", "ecommerce", "assistant"],
  "ui": {
    "bundle": { "format": "static-spa", "entry": "index.html", "external_origins": [] },
    "views": [
      { "name": "cart", "title": "Shopping Cart", "default": true, "entry": "index.html",
        "min_size": {"w":360,"h":520}, "default_size": {"w":420,"h":640}, "max_size": {"w":720,"h":960},
        "resizable": true, "movable": true, "single_instance": true, "icon": "icon.svg" }
    ],
    "host_api": {
      "tools": ["required:bundled:woo-shop"],
      "chat": ["write_message"],
      "storage": ["get","set"],
      "window": ["set_title"]
    },
    "csp_overrides": { "img-src": ["'self'","data:","blob:","https:"], "script-src": ["'self'"] },
    "state_merge": "last_writer_wins"
  },
  "dev": { "fixtures": ["fixtures/*.jsonl"], "seed_storage": {}, "user_id": 1 }
}
```

`app.json` (store/publish metadata) carries: `slug`, `name`, `version`, `tagline`, `description`, `category`, logo/cover/screenshots, support/privacy URLs, `pricing_model`, and `bundled_executas: { "woo-shop": { "path": "./executas/woo-shop" } }`.

---

## 5. Executa `describe` skeleton (the 5 tools)

Reuse the exact I/O contract from the plugin mapping. Example (search + add):

```js
const MANIFEST = {
  display_name: "WooCommerce Shop",
  version: "0.1.0",
  description: "Search products and manage the cart on a WooCommerce store.",
  runtime: { type: "node", min_version: "18.0.0" },
  host_capabilities: ["aps.kv"],            // persist the Store API Cart-Token
  credentials: [ /* WOO_STORE_URL, WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET */ ],
  tools: [
    { name: "search_products", description: "Search products by name, category, or price range.",
      parameters: [
        { name: "query", type: "string", required: false, description: "search term" },
        { name: "category", type: "string", required: false, description: "category slug or name" },
        { name: "min_price", type: "number", required: false },
        { name: "max_price", type: "number", required: false },
        { name: "limit", type: "integer", required: false, default: 5, description: "max 10" }
      ] },
    { name: "get_product_details", description: "Full details for one product including variations.",
      parameters: [ { name: "product_id", type: "integer", required: true } ] },
    { name: "add_to_cart", description: "Add a product to the shopper's cart.",
      parameters: [
        { name: "product_id", type: "integer", required: true },
        { name: "quantity", type: "integer", required: false, default: 1 },
        { name: "variation_id", type: "integer", required: false }
      ] },
    { name: "view_cart", description: "View the current cart, totals, and checkout URL.", parameters: [] },
    { name: "remove_from_cart", description: "Remove an item by cart_item_key.",
      parameters: [ { name: "cart_item_key", type: "string", required: true } ] }
  ]
};
```

Tool implementations call:
- `search_products` / `get_product_details` -> `GET {store}/wp-json/wc/store/v1/products` (guest-readable, no key) or `wc/v3/products` (key) for richer fields/variations.
- `add_to_cart` / `view_cart` / `remove_from_cart` -> `wc/store/v1/cart/*` with a persisted `Cart-Token` header.

Return raw numeric `price`/`total` plus a formatted display string (improvement over the plugin's `wc_price` HTML).

---

## 6. Repo layout

```
anna-woocommerce-shopping-assistant/
├── app.json                         # store/publish metadata + bundled_executas map
├── manifest.json                    # schema 2: permissions, executas, prompt, ui, credentials
├── package.json                     # devDep: @anna-ai/cli
├── bundle/                          # embedded UI (static SPA)
│   ├── index.html
│   ├── app.js                       # ES module; AnnaAppRuntime.connect()
│   ├── style.css                    # ported from chatbot.css
│   └── icon.svg
├── executas/
│   └── woo-shop/
│       ├── executa.json             # slug, executa_type:"tool", type:"node", distribution
│       ├── index.js                 # stdio JSON-RPC loop: describe/invoke/health/initialize
│       ├── woo-client.js            # WC Store API + v3 wrappers, Cart-Token handling
│       └── package.json
├── fixtures/*.jsonl                 # dev replay for `anna-app fixture verify`
├── tests/
└── PLAN.md                          # this file
```

---

## 7. Build-week timeline (Jun 15 to 22)

- **Day 1 (setup):** Confirm Anna Pro + developer access is enabled for `info@fahdmurtaza.com` (blocked on Jiao — draft reply already prepared). Scaffold from `anna-executa-examples`. Stand up `woo-shop` with `describe` + `search_products` hitting a real WC Store API. Verify with `anna-app executa dev --invoke search_products --args '{"query":"shirt"}'`.
- **Day 2 (tools):** Implement all 5 tools + `WOO_*` credentials. Implement Cart-Token capture and persistence via APS storage (`initialize` negotiates `aps.kv`).
- **Day 3 (behavior):** Write `manifest.json` + `system_prompt_addendum`; run `anna-app dev` and exercise the full loop in chat with Anna's sampling (no provider keys).
- **Day 4 (UI):** Build the embedded SPA: cart view + the review-before-checkout moment; wire `anna.tools.invoke` and `window.__ANNA_TOOL_IDS__`.
- **Day 5 (hardening):** Fixtures + tests, `anna-app validate --strict`, error handling, screenshots, listing copy.
- **Day 6 (publish):** `anna-app apps publish` (mints tool_id, writes `bundle/anna-tool-ids.js`), submit the listing, apply for Verified Developer if store publication is in scope.
- **Day 7 (buffer):** Discord Q&A, polish, demo recording.

---

## 8. Decisions needed from you

1. **Which WooCommerce store backs the demo?** Anna runs the Executa on its side, so it needs a **publicly reachable** store. `woocommerce-demo.local` is not internet-reachable. Options: (a) deploy the demo store to a public host, (b) tunnel local (ngrok/Cloudflare Tunnel) for the hackathon, (c) point at an existing live store. Need a URL + `wc/v3` consumer key/secret.
2. **Tool shape:** 5 discrete tools (recommended, matches today) vs one `shop` dispatcher tool. 
3. **Executa language:** Node (recommended) vs Python.
4. **Scope of UI:** cart + review moment only (recommended for the week) vs a fuller product-browse canvas.

## 9. Risks

- **Cart session continuity (top risk):** mapping the WC Store API `Cart-Token` to a per-Anna-user persisted token via APS storage. Needs `aps.kv` granted by the user and careful request-scoping. Prototype this Day 2.
- **Store reachability:** see decision 1.
- **Verified-developer timing** may exceed the hackathon window; the app can run via `anna-app dev` / local install for judging even if store publication lags.
- **Catalog parity:** Store API vs `wc/v3` expose slightly different fields (variations, stock); confirm which endpoint each tool uses early.

## 10. What is reused vs new

- **Reused (concepts/contract):** the 5-tool I/O contract, the shopping system prompt, the UI styling.
- **New:** Node Executa speaking JSON-RPC over stdio; WC Store API / v3 client with Cart-Token persistence; schema-2 manifest + embedded UI; APS storage usage.
- **Dropped:** Anthropic/Moonshot provider code, the SSE streaming path, the nonce/rate-limit REST layer (Anna handles model + transport).
