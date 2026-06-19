# Lessons Learned

## 1. Pantheon OPcache / Multi-Container Cache Invalidation (Jun 2026)

**Problem**: Plugin code changes on Pantheon dev did not take effect even after deactivating/reactivating the plugin. The WooCommerce session cookie produced by the plugin remained wrong (3 fields instead of 4) despite correct disk content.

**Root cause**: Two separate caching layers compounded each other:
- **Pantheon CDN** cached the `302` redirect response from `?anna_checkout=...`, so the bridge never ran twice in a row
- **Pantheon object cache** (cross-container Redis/Memcached) served stale `active_plugins` option — the frontend PHP containers didn't see the updated plugin list immediately after a WP admin deactivate/activate

**What we tried that didn't work**: Delete + reinstall plugin, WP plugin editor save, `.user.ini` OPcache disable, adding Cache-Control headers to the PHP output, new plugin slug with fresh file path.

**What actually fixed it**: Moving to `woo.isupercoder.com` (a clean WordPress install without Pantheon infrastructure) eliminated the caching layers entirely.

**Decision**: Always test session/cookie functionality on a plain hosting environment, not a CDN-accelerated multi-container platform, during early development.

---

## 2. Anna Executa Credentials Cannot Be Updated After Install (Jun 2026)

**Problem**: After switching the WooCommerce store from `dev-anna-woo-demo.pantheonsite.io` to `woo.isupercoder.com`, the executa (woo-shop binary) continued hitting the old Pantheon store. The user's stored `WOO_STORE_URL` credential pointed to Pantheon and there was no API endpoint to update it.

**What we tried**: `POST /api/v1/apps/57/install` with credentials in 4 different body formats (flat, tool-id-keyed, user_executa_id-keyed, named_executas array) — all returned `{"success":true,"installed_executas":[]}`. No credential was saved regardless of format.

**Root cause**: The anna.partners API does not expose a public endpoint to update per-user executa credentials post-install. The credential is written only at first install and is not editable without super-admin access.

**Fix**: Added a migration override in `woo-client.js` constructor that detects any `pantheonsite.io` URL and replaces it with `woo.isupercoder.com`. This makes the stored credential irrelevant for existing installations.

**Decision**: For any store migration, bake the new URL directly into the executa source as a default fallback rather than relying on user-editable credentials.

---

## 3. Cart Token Scope: Panel vs. Executa Are Different Processes (Jun 2026)

**Problem**: Cart items added via the panel (which hits WooCommerce Store API directly) were not reflected when the executa retrieved the cart, and vice versa. The checkout sometimes showed different items than the cart tab.

**Root cause**: The panel (browser iframe) stores `woo_cart_token` in localStorage under the `anna.partners` origin. The executa (server-side binary) receives the cart token from APS KV storage (`aps.kv.get("woo_cart_token")`). These two storage namespaces are the same key but there is a sync delay: the panel writes to localStorage first, then the executa reads from APS KV.

**Key rule**: The panel is the source of truth for the cart token. The executa must read `woo_cart_token` from APS KV, which is populated by the panel's `anna.storage.set` calls via the host bridge.

---

## 4. WooCommerce Session Cookie Format — 4 Fields, Single-Pipe Separator (Jun 2026)

**Problem**: WooCommerce checkout page rejected the session cookie set by our PHP bridge, showing an empty cart instead of the cart built in the panel.

**Root cause**: WooCommerce `WC_Session_Handler::set_customer_session_cookie()` expects exactly 4 pipe-separated (`|`) fields: `customer_id|session_expiration|session_expiring|cookie_hash`. Early versions of the bridge used double-pipe (`||`) or 3 fields. The HMAC is computed as `hash_hmac('md5', "$customer_id|$session_expiration", wp_hash("$customer_id|$session_expiration"))`.

**Fix**: `anna-integration` plugin uses single `|` separator and all 4 fields. See `deploy/anna-checkout-bridge.php`.

---

## 5. Never Hardcode the Demo/Dev Store URL in Published App Releases (Jun 2026)

**Problem**: `bundle/app.js` and `manifest.json` shipped with `dev-anna-woo-demo.pantheonsite.io` hardcoded. When the store migrated, every published version of the app was broken with no way to update users' installed copies without a full uninstall+reinstall.

**Decision**: Store URL should either come from a credential (updateable without rebuilding) or the executa source should have a clearly versioned default that can be overridden. Avoid hardcoding temporary dev URLs in any file that ships in a release bundle.
