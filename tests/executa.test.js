// Integration tests for the woo-shop executa stdio JSON-RPC protocol.
// These run the real process and pipe requests/responses — no mocking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const EXECUTA = join(dirname(fileURLToPath(import.meta.url)), "../executas/woo-shop/index.js");
const STORE_URL = "https://woo.isupercoder.com";

// Runs `requests` through the executa and returns parsed responses keyed by id.
// APS reverse-RPC messages (method field present on outbound) are collected but
// not matched — the caller can optionally reply to them via `apsReplies` map.
function run(requests, { apsReplies = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [EXECUTA], { stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: child.stdout });
    const results = {};

    rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      // Outbound APS reverse-RPC (executa asking host for kv)
      if (msg.method) {
        if (apsReplies[msg.id] !== undefined) {
          child.stdin.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id, result: apsReplies[msg.id],
          }) + "\n");
        }
        return;
      }

      if (msg.id !== null && msg.id !== undefined) results[msg.id] = msg;
    });

    child.on("close", () => resolve(results));
    child.on("error", reject);

    requests.forEach((r) => child.stdin.write(JSON.stringify(r) + "\n"));
    child.stdin.end();
  });
}

// ---- protocol ----------------------------------------------------------------

test("initialize returns protocol_version and manifest", async () => {
  const r = await run([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: ["aps.kv"] } },
  ]);
  assert.ok(r[1].result);
  assert.equal(r[1].result.protocol_version, 2);
  assert.ok(r[1].result.manifest?.tools?.length > 0);
});

test("describe returns manifest directly (not wrapped)", async () => {
  const r = await run([
    { jsonrpc: "2.0", id: 1, method: "describe" },
  ]);
  const m = r[1].result;
  assert.ok(m.display_name);
  assert.ok(Array.isArray(m.tools));
  assert.equal(m.tools.length, 5);
  const names = m.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), [
    "add_to_cart", "get_product_details", "remove_from_cart", "search_products", "view_cart",
  ]);
});

test("health returns ok", async () => {
  const r = await run([
    { jsonrpc: "2.0", id: 1, method: "health" },
  ]);
  assert.equal(r[1].result.status, "ok");
});

test("unknown method returns JSON-RPC error", async () => {
  const r = await run([
    { jsonrpc: "2.0", id: 1, method: "bogus_method" },
  ]);
  assert.ok(r[1].error);
  assert.ok(!r[1].result);
});

test("malformed JSON returns parse error", async () => {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [EXECUTA], { stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: child.stdout });
    let got;
    rl.on("line", (line) => { try { got = JSON.parse(line); } catch {} });
    child.on("close", () => {
      try {
        assert.equal(got?.error?.code, -32700);
        resolve();
      } catch (e) { reject(e); }
    });
    child.on("error", reject);
    child.stdin.write("not json\n");
    child.stdin.end();
  });
});

// ---- invoke errors -----------------------------------------------------------

test("invoke unknown tool returns success:false", async () => {
  const r = await run([
    { jsonrpc: "2.0", id: 1, method: "invoke",
      params: { tool: "no_such_tool", arguments: {},
        context: { user_id: "t1", credentials: { WOO_STORE_URL: STORE_URL } } } },
  ]);
  assert.equal(r[1].result.success, false);
  assert.ok(r[1].result.error?.message);
});

test("invoke missing WOO_STORE_URL returns success:false", async () => {
  const r = await run([
    { jsonrpc: "2.0", id: 1, method: "invoke",
      params: { tool: "view_cart", arguments: {}, context: { credentials: {} } } },
  ]);
  assert.equal(r[1].result.success, false);
  assert.match(r[1].result.error.message, /WOO_STORE_URL/);
});

// ---- APS kv round-trip -------------------------------------------------------

test("APS kv.get response is routed to pending resolver (not re-dispatched)", async () => {
  // We send initialize (triggers aps.kv capability detection) then view_cart.
  // When the executa sends aps.kv.get, we reply immediately. The invoke result
  // must come back with success:true (no aps error surfaced to caller).
  const r = await run(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: ["aps.kv"] } },
      { jsonrpc: "2.0", id: 2, method: "invoke",
        params: { tool: "view_cart", arguments: {},
          context: { user_id: "aps-test", credentials: { WOO_STORE_URL: STORE_URL } } } },
    ],
    // Reply to every aps.kv.get with null (no prior token).
    { apsReplies: { 1001: { value: null }, 1002: { value: null } } }
  );
  assert.equal(r[2].result.success, true);
  assert.ok(Array.isArray(r[2].result.data.items));
});
