#!/usr/bin/env node
// woo-shop — Anna Executa (tool). JSON-RPC 2.0 over stdio.
//
// Anna invariants honored here (PLAN §; from anna.partners/developers):
//   * Long-running process: one JSON object per line on stdin, respond on
//     stdout. stdout carries ONLY protocol; all logging goes to stderr.
//   * `describe` returns the manifest object DIRECTLY (not wrapped).
//   * `invoke` result is ALWAYS `{ success, data }` (or `{ success:false, error }`).
//   * Tool params use Executa style `parameters:[{name,type,required,description}]`,
//     NOT MCP `input_schema`.
//   * Credentials arrive per-invoke via `params.context.credentials` — never
//     logged, never cached module-global (this one process serves many users).

import { createInterface } from "node:readline";
import { WooClient, WooError } from "./woo-client.js";

const log = (...a) => process.stderr.write(`[woo-shop] ${a.join(" ")}\n`);

const MANIFEST = {
  display_name: "WooCommerce Shop",
  version: "0.1.7",
  description: "Search products and manage the cart on a WooCommerce store.",
  runtime: { type: "node", min_version: "18.0.0" },
  host_capabilities: ["aps.kv"], // persist the Store API Cart-Token per user
  credentials: [
    { name: "WOO_CONSUMER_KEY", display_name: "WC Consumer Key (read-only, optional)", required: false, sensitive: true },
    { name: "WOO_CONSUMER_SECRET", display_name: "WC Consumer Secret (optional)", required: false, sensitive: true },
  ],
  tools: [
    {
      name: "search_products",
      description: "Search products by name, category, or price range.",
      parameters: [
        { name: "query", type: "string", required: false, description: "search term" },
        { name: "category", type: "string", required: false, description: "category slug, name, or id" },
        { name: "min_price", type: "number", required: false, description: "minimum price filter" },
        { name: "max_price", type: "number", required: false, description: "maximum price filter" },
        { name: "limit", type: "integer", required: false, default: 5, description: "max 10" },
      ],
    },
    {
      name: "get_product_details",
      description: "Full details for one product including variations.",
      parameters: [{ name: "product_id", type: "integer", required: true, description: "product ID to retrieve" }],
    },
    {
      name: "add_to_cart",
      description: "Add a product to the shopper's cart.",
      parameters: [
        { name: "product_id", type: "integer", required: true, description: "product ID to add" },
        { name: "quantity", type: "integer", required: false, default: 1, description: "number of items to add" },
        { name: "variation_id", type: "integer", required: false, description: "variation ID for variable products" },
      ],
    },
    { name: "view_cart", description: "View the current cart, totals, and checkout URL.", parameters: [] },
    {
      name: "remove_from_cart",
      description: "Remove an item by cart_item_key.",
      parameters: [{ name: "cart_item_key", type: "string", required: true, description: "cart item key to remove" }],
    },
  ],
};

// --- APS kv storage (Cart-Token persistence across Anna invokes) --------------
// Anna's host provides `aps.kv` as a reverse-RPC capability (host calls back in
// to the executa's stdout with JSON-RPC responses). We track pending requests
// with a simple id→resolve/reject map, falling back to an in-process Map for
// dev/fixtures where the host doesn't speak APS.
//
// Key design: we key by `userId` under scope `user/tool`. The Cart-Token is a
// WooCommerce Store API JWT — safe to store in user-scoped KV.

let apsAvailable = false; // set to true after `initialize` negotiates aps.kv
const memTokens = new Map(); // fallback for dev / fixtures
let _apsReqId = 1000;
const _apsPending = new Map(); // id → { resolve, reject }

function apsKey(userId) { return `woo_cart_token:${userId}`; }

// Send a reverse-RPC request to the host and await its response.
// The host sends back a JSON-RPC result on stdin with the same id.
function apsRequest(method, params) {
  const id = ++_apsReqId;
  return new Promise((resolve, reject) => {
    _apsPending.set(id, { resolve, reject });
    write({ jsonrpc: "2.0", id, method, params });
    // Timeout after 3s — fall back to mem silently.
    setTimeout(() => {
      if (_apsPending.has(id)) {
        _apsPending.delete(id);
        reject(new Error("aps timeout"));
      }
    }, 3000);
  });
}

const storage = {
  async getCartToken(userId) {
    if (apsAvailable) {
      try {
        const r = await apsRequest("aps.kv.get", { key: apsKey(userId), scope: "user/tool" });
        return r?.value ?? null;
      } catch { /* fall through to mem */ }
    }
    return memTokens.get(userId) ?? null;
  },
  async setCartToken(userId, token) {
    if (token) {
      memTokens.set(userId, token); // always keep mem in sync
      if (apsAvailable) {
        try {
          await apsRequest("aps.kv.set", { key: apsKey(userId), value: token, scope: "user/tool" });
        } catch { /* non-fatal */ }
      }
    }
  },
};

async function handleInvoke(params) {
  const { tool, arguments: args = {}, context = {} } = params || {};
  const userId = context.user_id ?? context.userId ?? "anon";
  const creds = context.credentials || {};

  const cartToken = await storage.getCartToken(userId);
  const woo = new WooClient(creds, cartToken);

  let data;
  switch (tool) {
    case "search_products":
      data = await woo.searchProducts(args);
      // Signal the panel to filter — panel polls this key via anna.storage.get
      if (apsAvailable) {
        try { await apsRequest("aps.kv.set", { key: "woo_panel_q", value: args.query ?? "", scope: "user/app" }); } catch {}
      }
      break;
    case "get_product_details": data = await woo.getProductDetails(args); break;
    case "add_to_cart": data = await woo.addToCart(args); break;
    case "view_cart": data = await woo.viewCart(); break;
    case "remove_from_cart": data = await woo.removeFromCart(args); break;
    default: throw new WooError(`unknown tool: ${tool}`, 404, null);
  }
  // Persist any refreshed Cart-Token so the next invoke continues the same cart.
  if (woo.cartToken && woo.cartToken !== cartToken) await storage.setCartToken(userId, woo.cartToken);
  return data;
}

async function dispatch(method, params) {
  switch (method) {
    case "initialize":
      // Anna host advertises supported capabilities in params.capabilities[].
      // Only enable APS if the host actually supports it (dev/fixtures may not).
      if (Array.isArray(params?.capabilities) && params.capabilities.includes("aps.kv")) {
        apsAvailable = true;
        log("aps.kv available — Cart-Tokens will persist across invokes");
      }
      return { protocol_version: 2, capabilities: { storage: ["get", "set"] }, manifest: MANIFEST };
    case "describe":
      return MANIFEST; // returned directly, not wrapped
    case "health":
      return { status: "ok", version: MANIFEST.version };
    case "invoke":
      try {
        return { success: true, data: await handleInvoke(params) };
      } catch (err) {
        const e = err instanceof WooError ? err : new WooError(String(err?.message || err), 500, null);
        log("invoke error:", e.status, e.message);
        return { success: false, error: { message: e.message, status: e.status } };
      }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

// --- startup announce ---------------------------------------------------------
// Write manifest as the very first stdout line so the anna local agent's
// "Rediscover Local" can discover the tool without sending any stdin command.
// If called as `describe` CLI arg, exit immediately after (no stdin loop).
process.stdout.write(JSON.stringify(MANIFEST) + "\n");
if (process.argv[2] === "describe") process.exit(0);

// --- stdio JSON-RPC 2.0 loop -------------------------------------------------
// Track in-flight requests so we only exit after all complete (stdin close
// fires before async fetches resolve when piping input in tests/fixtures).
let inFlight = 0;
let stdinClosed = false;

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  inFlight++;
  let req;
  try {
    req = JSON.parse(text);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    if (--inFlight === 0 && stdinClosed) process.exit(0);
    return;
  }

  const { id = null, method, params } = req;

  // JSON-RPC responses (from the host) have no `method` field.
  if (method === undefined) {
    if (_apsPending.has(id)) {
      const { resolve, reject } = _apsPending.get(id);
      _apsPending.delete(id);
      if ("error" in req) reject(new Error(req.error?.message || "aps error"));
      else resolve(req.result ?? null);
    }
    // Spurious/late responses — silently drop.
    if (--inFlight === 0 && stdinClosed) process.exit(0);
    return;
  }

  try {
    const result = await dispatch(method, params);
    write({ jsonrpc: "2.0", id, result });
  } catch (err) {
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: String(err?.message || err) } });
  }
  if (--inFlight === 0 && stdinClosed) process.exit(0);
});
rl.on("close", () => {
  stdinClosed = true;
  if (inFlight === 0) process.exit(0);
});

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

log("ready");
