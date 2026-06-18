// woo-client.js — WooCommerce Store API (+ optional REST v3) client.
//
// Credential-free by default: the Store API `products` and `cart` endpoints are
// guest-accessible and need only the store base URL (WOO_STORE_URL). A read-only
// wc/v3 consumer key/secret can be supplied later for richer catalog fields
// (reliable variations, stock) — when absent we fall back to the Store API.
//
// Money: WooCommerce Store API returns prices in MINOR units as strings (e.g.
// "1999" with currency_minor_unit 2 => $19.99). We expose both the raw numeric
// value and a formatted display string — cleaner for the Anna UI than the
// plugin's `wc_price()` HTML.

const STORE_API = "/wp-json/wc/store/v1";
const REST_V3 = "/wp-json/wc/v3";

export class WooError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "WooError";
    this.status = status;
    this.body = body;
  }
}

export class WooClient {
  /**
   * @param {object} creds context.credentials injected per-invoke (never logged/cached globally)
   * @param {string} creds.WOO_STORE_URL e.g. https://dev-anna-woo-demo.pantheonsite.io
   * @param {string} [creds.WOO_CONSUMER_KEY] optional read-only wc/v3 key
   * @param {string} [creds.WOO_CONSUMER_SECRET]
   * @param {string|null} [cartToken] persisted Store API Cart-Token for this user
   */
  constructor(creds, cartToken = null) {
    if (!creds || !creds.WOO_STORE_URL) {
      throw new WooError("WOO_STORE_URL credential is required", 400, null);
    }
    this.base = String(creds.WOO_STORE_URL).replace(/\/+$/, "");
    this.key = creds.WOO_CONSUMER_KEY || null;
    this.secret = creds.WOO_CONSUMER_SECRET || null;
    // Mutated after any cart call so the caller can persist it (APS storage).
    this.cartToken = cartToken;
    // Nonce is session-scoped and returned by GET /cart; fetched lazily before
    // any cart write. Short-lived (~24h) so we re-fetch if a write returns 401.
    this._nonce = null;
  }

  // Ensure we have a Cart-Token and Nonce before a write operation.
  // Calls GET /cart once per client instance (or on 401 retry).
  async _ensureCartSession() {
    if (this.cartToken && this._nonce) return;
    const res = await fetch(this.base + STORE_API + "/cart", {
      headers: { Accept: "application/json", ...(this.cartToken ? { "Cart-Token": this.cartToken } : {}) },
    });
    const token = res.headers.get("cart-token");
    const nonce = res.headers.get("nonce");
    if (token) this.cartToken = token;
    if (nonce) this._nonce = nonce;
  }

  get hasV3() {
    return Boolean(this.key && this.secret);
  }

  // ---- low-level transports -------------------------------------------------

  async _storeFetch(path, { method = "GET", body, query } = {}) {
    const isWrite = method !== "GET";
    // Cart writes need a Cart-Token + Nonce; fetch them lazily.
    if (isWrite) await this._ensureCartSession();

    const url = new URL(this.base + STORE_API + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }

    const doFetch = async () => {
      const headers = { Accept: "application/json" };
      if (body) headers["Content-Type"] = "application/json";
      if (this.cartToken) headers["Cart-Token"] = this.cartToken;
      if (isWrite && this._nonce) headers["Nonce"] = this._nonce;

      const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const refreshed = res.headers.get("cart-token");
      if (refreshed) this.cartToken = refreshed;
      return res;
    };

    let res = await doFetch();

    // On 401 nonce expiry, re-bootstrap the session and retry once.
    if (res.status === 401 && isWrite) {
      this._nonce = null;
      await this._ensureCartSession();
      res = await doFetch();
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new WooError(data?.message || `Store API ${res.status}`, res.status, data);
    }
    return data;
  }

  async _v3Fetch(path, query = {}) {
    const url = new URL(this.base + REST_V3 + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    // Basic Auth over HTTPS (avoids key/secret in the query string).
    const auth = Buffer.from(`${this.key}:${this.secret}`).toString("base64");
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new WooError(data?.message || `REST v3 ${res.status}`, res.status, data);
    }
    return data;
  }

  // ---- helpers --------------------------------------------------------------

  // Store API prices are minor-unit strings; normalize to {amount, formatted}.
  _money(prices, field = "price") {
    if (!prices) return null;
    const minorUnit = Number(prices.currency_minor_unit ?? 2);
    const raw = Number(prices[field] ?? 0) / 10 ** minorUnit;
    const sym = prices.currency_symbol || prices.currency_prefix || "$";
    return { amount: raw, currency: prices.currency_code || "USD", formatted: `${sym}${raw.toFixed(minorUnit)}` };
  }

  _normalizeProduct(p) {
    return {
      id: p.id,
      name: stripTags(p.name || ""),
      slug: p.slug,
      type: p.type,
      permalink: p.permalink,
      price: this._money(p.prices, "price"),
      regular_price: this._money(p.prices, "regular_price"),
      on_sale: Boolean(p.on_sale),
      in_stock: p.is_in_stock !== false,
      short_description: stripTags(p.short_description || ""),
      image: p.images?.[0]?.src || null,
      has_variations: (p.variations?.length || 0) > 0,
    };
  }

  // Resolve a category slug or name to a Store API term id (returns null if none).
  async _categoryId(category) {
    if (!category) return null;
    if (/^\d+$/.test(String(category))) return Number(category);
    const terms = await this._storeFetch("/products/categories", { query: { search: category } });
    const hit = Array.isArray(terms) ? terms.find((t) => t.slug === category) || terms[0] : null;
    return hit ? hit.id : null;
  }

  // ---- the five tools -------------------------------------------------------

  async searchProducts({ query, category, min_price, max_price, limit = 5 } = {}) {
    const per_page = Math.min(Number(limit) || 5, 10);
    const categoryId = await this._categoryId(category);
    const products = await this._storeFetch("/products", {
      query: { search: query, category: categoryId, min_price, max_price, per_page },
    });
    return { count: products.length, products: products.map((p) => this._normalizeProduct(p)) };
  }

  async getProductDetails({ product_id } = {}) {
    if (!product_id) throw new WooError("product_id is required", 400, null);
    const p = await this._storeFetch(`/products/${product_id}`);
    const base = this._normalizeProduct(p);
    return {
      ...base,
      description: stripTags(p.description || ""),
      attributes: (p.attributes || []).map((a) => ({ name: a.name, terms: (a.terms || []).map((t) => t.name) })),
      variations: p.variations || [],
      categories: (p.categories || []).map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
    };
  }

  async addToCart({ product_id, quantity = 1, variation_id } = {}) {
    if (!product_id) throw new WooError("product_id is required", 400, null);
    const body = { id: Number(variation_id || product_id), quantity: Number(quantity) || 1 };
    const cart = await this._storeFetch("/cart/add-item", { method: "POST", body });
    return this._normalizeCart(cart);
  }

  async viewCart() {
    const cart = await this._storeFetch("/cart");
    return this._normalizeCart(cart);
  }

  async removeFromCart({ cart_item_key } = {}) {
    if (!cart_item_key) throw new WooError("cart_item_key is required", 400, null);
    const cart = await this._storeFetch("/cart/remove-item", { method: "POST", body: { key: cart_item_key } });
    return this._normalizeCart(cart);
  }

  _normalizeCart(cart) {
    const totals = cart.totals || {};
    const minorUnit = Number(totals.currency_minor_unit ?? 2);
    const fmt = (v) => `${totals.currency_symbol || "$"}${(Number(v || 0) / 10 ** minorUnit).toFixed(minorUnit)}`;
    return {
      items: (cart.items || []).map((i) => ({
        cart_item_key: i.key,
        product_id: i.id,
        name: i.name,
        quantity: i.quantity,
        line_total: { amount: Number(i.totals?.line_total || 0) / 10 ** minorUnit, formatted: fmt(i.totals?.line_total) },
      })),
      item_count: cart.items_count ?? (cart.items || []).reduce((n, i) => n + i.quantity, 0),
      total: { amount: Number(totals.total_price || 0) / 10 ** minorUnit, formatted: fmt(totals.total_price) },
      // Store checkout URL — the review-before-checkout moment hands the shopper here.
      checkout_url: `${this.base}/checkout/`,
    };
  }
}

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}
