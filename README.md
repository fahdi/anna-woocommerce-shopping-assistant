# WooCommerce Shopping Assistant for Anna

An Anna App that turns Anna into a shopping assistant for any WooCommerce store. Search products, manage a cart, and proceed to checkout — all without leaving the chat.

## What it does

- **Search the catalog** by keyword (`hoodie`, `beanie`, etc.) or browse everything
- **Visual product panel** — images, prices, variants, and Add to Cart buttons in a side panel
- **Cart management** — add, remove, view totals; cart persists across the conversation
- **Checkout bridge** — hands the cart off to WooCommerce checkout with the session intact

Anna handles the conversation. The panel handles the shopping UI. The two stay in sync.

## Architecture

```
User message
    │
    ▼
Anna (LLM)
    ├── search_products(query)   ← executa tool (server-side, WC REST API)
    └── open_app_view(url)       ← host API call → opens the panel SPA
                                                         │
                                                         ▼
                                              Panel SPA (bundle/app.js)
                                                  │
                                                  └── WC Store API (browser → store)
                                                        /wc/store/v1/products
                                                        /wc/store/v1/cart
                                                        /wc/store/v1/cart/add-item
                                                        /wc/store/v1/cart/remove-item
                                                        /wc/store/v1/checkout
```

The panel SPA calls the WooCommerce Store API directly from the browser (CORS must be open on the store). Cart state is tracked via a `Cart-Token` JWT stored in `sessionStorage`.

## Files

```
anna-woocommerce-shopping-assistant/
├── app.json              # Anna App manifest (slug, version, description)
├── manifest.json         # Schema v2: permissions, system_prompt_addendum, UI config
├── bundle/
│   ├── app.js            # Panel SPA — search UI, cart, checkout
│   └── icon.svg          # App icon
├── executas/
│   └── woo-shop/         # Bundled executa (Node.js): search_products, add_to_cart, etc.
├── deploy/
│   └── anna-checkout-bridge.php  # WP mu-plugin: bridges Store API session → WC cookie
├── fixtures/             # Dev harness fixture responses
└── tests/                # Integration test suite
```

## Setup

### 1. WooCommerce store requirements

- WooCommerce 8.0+ with Store API enabled (default)
- CORS open to `https://anna.partners` (add via filter or plugin)
- Pantheon / any host: set `Cache-Control: no-store` on `/wc/store/v1/cart` responses

### 2. Checkout bridge (required for checkout to work)

Copy `deploy/anna-checkout-bridge.php` to `wp-content/mu-plugins/` on your store. This bridges the Store API JWT session to the WooCommerce PHP session cookie so the cart is intact when the user lands on the WC checkout page.

Without this file, clicking "Proceed to Checkout" opens an empty cart.

### 3. Deploy the Anna App

```bash
# Install Anna CLI
npm install -g @anna-ai/cli

# Publish
anna publish
```

### 4. Configure in Anna

1. Open Anna → Apps → WooCommerce Shopping Assistant
2. Set your store URL in credentials: `WOO_STORE_URL=https://yourstore.com`
3. Start a chat and say "show me your products"

## Demo store

`https://woo.isupercoder.com` — 22 products: hoodies, t-shirts, beanies, cap, belt, sunglasses, pennant, polo, long sleeve tee.

## Key implementation details

### Cart-Token session management

The WC Store API uses a stateless JWT (`Cart-Token` response header) to identify anonymous sessions. The panel stores this in `sessionStorage` and sends it on every request.

**CDN gotcha**: Pantheon Fastly caches GET responses including `/wc/store/v1/cart`. Always set `Cache-Control: no-store` on cart endpoints server-side, and use `cache: "no-store"` in all `fetch()` calls client-side.

**Token stability rule**: Only save the `Cart-Token` from GET responses if no token exists yet. Always save it from POST responses. This prevents stale CDN-cached tokens from clobbering a valid session.

### Checkout flow

```
Panel "Proceed to Checkout" click
    │
    ▼
openCheckout() in bundle/app.js
    │  builds /?anna_checkout=<JWT>
    ▼
anna-checkout-bridge.php (mu-plugin)
    │  decodes JWT → extracts session key
    │  sets wp_woocommerce_session_* cookie
    ▼
wp_safe_redirect( wc_get_checkout_url() )
    │
    ▼
WooCommerce /checkout/ with cart intact
```

### Anna's system prompt

`manifest.json` → `system_prompt_addendum` tells Anna:
1. Call `search_products(query)` to query the live catalog
2. Call `open_app_view('index.html?q=QUERY')` to show the panel
3. Reply naturally based on what was found — no canned responses, no inventing product data

### Browse-all

`open_app_view('index.html?q=')` (empty string) triggers browse-all. The panel detects `?q=` via `_params.has("q")` (not truthiness check — empty string is a valid query).

## Versions

| Version | Change |
|---------|--------|
| 0.1.18 | Checkout bridge URL (`/?anna_checkout=JWT`) |
| 0.1.17 | Intent-driven prompt: search_products → open_app_view → natural reply |
| 0.1.16 | Panel-first UX, browse-all fix, CDN cache fix (`per_page=12`) |
| 0.1.15 | `cache: "no-store"` on all fetches, cart token stability |
| 0.1.14 | PHP filter: `no-store` on Store API cart responses |

## Store API endpoints used

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/wc/store/v1/products?search=X&per_page=12` | Search catalog |
| GET | `/wc/store/v1/cart` | Fetch current cart |
| POST | `/wc/store/v1/cart/add-item` | Add item |
| POST | `/wc/store/v1/cart/remove-item` | Remove item |

Note: remove-item is `POST`, not `DELETE`.

## Development

```bash
# Run tests against the demo store
node tests/run.js

# Local dev harness (requires Anna CLI)
anna dev
```

Tests cover: search (keyword, browse-all, no-match), cart lifecycle (add, remove, persist), and Store API cache headers.

## Links

- Anna platform: https://anna.partners
- WooCommerce Store API docs: https://github.com/woocommerce/woocommerce/tree/trunk/plugins/woocommerce/src/StoreApi
- Issues: https://github.com/fahdi/anna-woocommerce-shopping-assistant/issues
