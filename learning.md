# Lessons Learned

## 1. Cart Token Scope: Panel vs. Executa Are Different Processes (Jun 2026)

**Problem**: Cart items added via the panel (which hits WooCommerce Store API directly) were not reflected when the executa retrieved the cart, and vice versa. The checkout sometimes showed different items than the cart tab.

**Root cause**: The panel (browser iframe) stores `woo_cart_token` in localStorage under the `anna.partners` origin. The executa (server-side binary) receives the cart token from APS KV storage (`aps.kv.get("woo_cart_token")`). These two storage namespaces are the same key but there is a sync delay: the panel writes to localStorage first, then the executa reads from APS KV.

**Key rule**: The panel is the source of truth for the cart token. The executa must read `woo_cart_token` from APS KV, which is populated by the panel's `anna.storage.set` calls via the host bridge.

---

## 2. WooCommerce Session Cookie Format — 4 Fields, Single-Pipe Separator (Jun 2026)

**Problem**: WooCommerce checkout page rejected the session cookie set by our PHP bridge, showing an empty cart instead of the cart built in the panel.

**Root cause**: WooCommerce `WC_Session_Handler::set_customer_session_cookie()` expects exactly 4 pipe-separated (`|`) fields: `customer_id|session_expiration|session_expiring|cookie_hash`. Early versions of the bridge used double-pipe (`||`) or 3 fields. The HMAC is computed as `hash_hmac('md5', "$customer_id|$session_expiration", wp_hash("$customer_id|$session_expiration"))`.

**Fix**: `anna-integration` plugin uses single `|` separator and all 4 fields. See `deploy/anna-checkout-bridge.php`.

---

## 3. Anna Executa Parameters Must Have a `description` Field (Jun 2026)

**Problem**: The woo-shop executa showed "0/1 running, 1 not installed" in the Anna agents dashboard. "Rediscover Local" triggered but reported "describe returned no manifest".

**Root cause**: `ParameterSchema.from_dict()` inside the Anna app does `d['description']` (not `d.get('description')`), so any parameter missing a `description` key raises `KeyError`. The exception is silently caught in `discover_and_load()` which returns `None`, causing the manifest to be discarded.

**Fix**: Every tool parameter in the manifest must include a `description` field — even optional/obvious ones.

---

## 4. Anna Executa Binary Layout Requires Symlink Chain (Jun 2026)

**Problem**: The bin entry at `~/.anna/executa/bin/<tool_id>` was a regular file. The auto-scan path worked but "Rediscover Local" failed with "unable to determine registration key".

**Root cause**: `_infer_tool_home_from_executable()` resolves the executable via `readlink()` to find the path segment containing "tools" and infer the tool_id. When the bin entry is a plain file (not a symlink into the versioned tool directory), the function returns `None` and the tool_id cannot be inferred.

**Required structure**:
```
~/.anna/executa/bin/<tool_id>           → symlink
~/.anna/executa/tools/<tool_id>/
  current/                              → symlink → v<version>/
  v<version>/
    <tool_id>                           (the actual executable / shim)
```

**Fix**: Created the full versioned directory tree and made the bin entry a symlink pointing into `tools/<tool_id>/current/<tool_id>`.

---

## 5. Never Hardcode Temporary Dev/Demo Store URLs in Release Artifacts (Jun 2026)

**Problem**: Store URL was hardcoded in published release assets. When the store changed, every installed copy of the app broke with no way to update without a full uninstall+reinstall.

**Decision**: Store URL must come from a user-editable credential (`WOO_STORE_URL`). The executa source should have a versioned default fallback (`woo.isupercoder.com`) that can be overridden — never a temporary URL in any file that ships in a release bundle.

---

## 6. "Edits Don't Take Effect" = Warm Local Executa Process, Not a Server Cache (Jun 2026)

**Problem**: After editing `woo-client.js` / bumping the executa version / re-publishing, the running tool kept returning old results (price filter returned 0 long after the fix shipped). Rebuilding the binary, switching npm↔binary distribution, and deleting runtime windows all had no effect.

**Root cause**: On this Mac the executa runs **locally** through the Anna desktop app (`/Applications/Anna.app`), not server-side. The desktop app launches the local shim (`~/.anna/executa/bin/<tool_id>` → `node <repo>/executas/woo-shop/index.js`) as a **long-running node process**. Node loads `woo-client.js` into memory once at start, so source edits never reach an already-running process. There were stale processes alive from a *previous day* still serving old code. (The linux binary in `executa.json` also crashes on macOS ARM64 — ELF vs Mach-O — and the agent silently falls back to the node shim; crash reports land in `~/Library/Logs/DiagnosticReports/`.)

**Fix / diagnosis**:
- `ps aux | grep "woo-shop/index.js"` — look for old start times.
- `pkill -f "woo-shop/index.js"` to force a fresh spawn on the next invoke.
- Verify a fresh spawn is correct: pipe a JSON-RPC `invoke` into `~/.anna/executa/bin/<tool_id>` and check the result.
- If killing the executa mid-session leaves the agent's tool registry stale (it flails with `exec_run`/`search_tools` instead of `search_products`): restart the desktop app — `pkill -9 -f "Anna.app/Contents/MacOS/Anna"; open -a Anna` — it re-discovers the executa cleanly (creds cached, auto-reconnects).

---

## 7. `aps.kv` (executa) and `anna.storage` (panel) Are Separate Stores — Sync via `entry_payload` (Jun 2026)

**Problem**: A chat search (e.g. "anything under $20") did not update the already-open panel — it kept showing browse-all. The panel polled `anna.storage.get("woo_panel_q")` while the executa wrote `aps.kv.set("woo_panel_q", …)`; `__wooLastQ()` was always null.

**Root cause**: The executa's `aps.kv` is keyed by the *tool* principal; the panel's `anna.storage` is keyed by the *app/window* principal. Same key string, **different backing stores** — the bridge never delivered anything. (`scope: "user/app"` did not unify them.)

**Fix**: Drive the panel through the host's view mechanism instead:
- Agent calls `open_app_view(view="cart", payload={q,min_price,max_price})`; the payload becomes the window's `entry_payload`.
- Panel reads `anna.entryPayload` on connect **and polls `anna.window.hello()` (~1.5 s)** to pick up later searches — the host updates `entry_payload` on an already-open window but does **not** emit an event for it. (Confirmed: only `kind:"res"` messages arrive, never `kind:"event"` for entry_payload.)
- `single_instance:true` on the view makes `open_app_view` reuse the open window instead of spawning duplicates.

---

## 8. `open_app_view` Takes a View NAME + a MERGED Payload (Not a URL) (Jun 2026)

**Problem**: The prompt told the agent to call `open_app_view('index.html?q=…&max_price=20')` (the old documented form). It failed with `unknown view 'index.html?q=…'`. Later, a text search after a price search showed "no wallets under $20" — the price filter stuck.

**Root cause (two parts)**:
1. The current platform `open_app_view` accepts `{ view, payload }` where `view` is a registered **view name** (`"cart"`), not a URL. The README's URL form is obsolete.
2. The host **merges** each `payload` onto the window's existing `entry_payload` (shallow, per-key, last-writer-wins) — it does **not** replace. So a key the agent omits keeps its previous value.

**Fix**: The agent sends **all three** keys (`q`, `min_price`, `max_price`) on **every** call, using `0` to mean "no price limit". The panel maps `0`/empty/null → no filter. Verified by checking the live window's `entry_payload` via `GET /api/v1/anna-apps/runtime/windows`.

---

## 9. WC Store API Price Filter Needs an Unpopulated Lookup Table — Filter Client-Side (Jun 2026)

**Problem**: `/wc/store/v1/products?min_price=…&max_price=…` returned 0 results for every value (even huge ones) on this store.

**Root cause**: The Store API price filter reads `wc_product_meta_lookup` (min/max price columns), which isn't populated on this demo store. There is no API param to bypass it.

**Fix**: Both the panel (`bundle/app.js wooSearch`) and the executa (`woo-client.js searchProducts`) over-fetch (`per_page=50`) and filter client-side on `prices.price` (minor units: `"499"` ÷ 10^`currency_minor_unit` = $4.99). Cheap at this catalog size (16 products).

---

## What's Next / Future Work

Items 1–7 shipped in **v0.1.50** (executa v0.1.12). See commit `d027582`.

1. ✅ **Variable products in-panel** — size `<select>` resolves the variation_id (`resolveVariationId`); Add to Cart stays in-panel.
2. ✅ **`on_sale` filter** — `search_products(on_sale)` + client-side filter (panel + executa); "On sale" toolbar chip; `on_sale` in the open_app_view payload convention.
3. ✅ **Cart quantity stepper** — − [n] + per line via `/cart/update-item` (− at 1 removes).
4. ✅ **Sort control** — Featured / Price asc / Price desc / On-sale-first (client-side).
5. ✅ **Cold-start prompt hardening** — opener: tools already available; forbids shell/exec/file/web-search/browser/tool-discovery.
6. ✅ **Catalog freshness** — prompt reinforces always-search-first; no static snapshot to drift.
7. ✅ **Distribution** — linux binary rebuilt at v0.1.12, released `woo-shop-v0.1.12`, executa.json updated. (darwin SEA build blocked by Node 26 sentinel-fuse; local mac uses the node shim — to build darwin, use Node 22.)

Still open:

8. **Productionize the price filter** — a tiny mu-plugin / WP-CLI step to populate `wc_product_meta_lookup` would let the Store API filter server-side and cut the over-fetch for larger catalogs.
9. **Live web-dashboard E2E for v0.1.50 features** — pending re-login (the web session expired during an Anna.app restart). Logic + Store-API mechanics are unit-/curl-verified; the chat→panel + checkout path was proven E2E on v0.1.48 (same architecture).
10. **Prompt length budget** — `system_prompt_addendum` has a hard 4000-char limit; the current prompt is ~3.3k. Keep new examples terse.
11. **Cold-start warm-up** — even with the prompt opener, the very first invoke after an executa restart can still thrash; a post-deploy warm-up ping (one throwaway `search_products`) would pre-warm the process and tool registry.
