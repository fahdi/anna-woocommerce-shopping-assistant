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
