// Unit tests for the panel's pure helpers.
//
// NOTE: these functions MIRROR the implementations in bundle/app.js. app.js is a
// browser ES module (top-level `await import(SDK)` + DOM bootstrap) so it can't be
// imported under node:test directly. Keep these copies in sync with app.js — they
// guard the variation-resolution, sort, and merge-safe payload logic.

import { test } from "node:test";
import assert from "node:assert/strict";

// ---- mirrors of bundle/app.js pure helpers ----------------------------------

function resolveVariationId(p, sel) {
  const match = (p.variations || []).find((v) =>
    (p.attributes || []).every((attr) => {
      const chosen = sel[attr.name];
      if (!chosen) return false;
      const va = (v.attributes || []).find((x) => x.name === attr.name);
      return !va || va.value === "" || va.value === chosen;
    }));
  return match ? match.id : null;
}

function makeSort(sortMode) {
  return function sortProducts(list) {
    const arr = list.slice();
    const amt = (p) => p.price?.amount ?? 0;
    if (sortMode === "price-asc") arr.sort((a, b) => amt(a) - amt(b));
    else if (sortMode === "price-desc") arr.sort((a, b) => amt(b) - amt(a));
    else if (sortMode === "sale") arr.sort((a, b) => Number(b.on_sale) - Number(a.on_sale));
    return arr;
  };
}

function filterFromPayload(p) {
  if (!p || typeof p !== "object") return null;
  const keys = ["q", "query", "min_price", "max_price", "category", "on_sale"];
  if (!keys.some((k) => k in p)) return null;
  const price = (v) => {
    const n = Number(v);
    return v == null || v === "" || Number.isNaN(n) || n <= 0 ? undefined : n;
  };
  const truthy = (v) => v === true || v === 1 || v === "1" || v === "true";
  return {
    query: p.q ?? p.query ?? "",
    min_price: price(p.min_price),
    max_price: price(p.max_price),
    category: (p.category === "" || p.category == null) ? undefined : p.category,
    on_sale: truthy(p.on_sale) || undefined,
  };
}

// Real "Midnight Fleece Hoodie" shape from the WC Store API.
const hoodie = {
  attributes: [{ name: "Size", terms: [{ name: "S", slug: "s" }, { name: "M", slug: "m" }, { name: "L", slug: "l" }, { name: "XL", slug: "xl" }] }],
  variations: [
    { id: 94, attributes: [{ name: "Size", value: "s" }] },
    { id: 95, attributes: [{ name: "Size", value: "m" }] },
    { id: 96, attributes: [{ name: "Size", value: "l" }] },
    { id: 97, attributes: [{ name: "Size", value: "xl" }] },
  ],
};

test("resolveVariationId maps a chosen size to the right variation id", () => {
  assert.equal(resolveVariationId(hoodie, { Size: "m" }), 95);
  assert.equal(resolveVariationId(hoodie, { Size: "xl" }), 97);
});

test("resolveVariationId returns null until a valid size is chosen", () => {
  assert.equal(resolveVariationId(hoodie, {}), null);
  assert.equal(resolveVariationId(hoodie, { Size: "xxl" }), null);
});

test("sortProducts orders by price and sale", () => {
  const prods = [
    { name: "A", price: { amount: 49 }, on_sale: false },
    { name: "B", price: { amount: 4.99 }, on_sale: false },
    { name: "C", price: { amount: 249.99 }, on_sale: true },
  ];
  assert.equal(makeSort("price-asc")(prods).map((p) => p.name).join(""), "BAC");
  assert.equal(makeSort("price-desc")(prods).map((p) => p.name).join(""), "CAB");
  assert.equal(makeSort("sale")(prods)[0].name, "C");
  assert.equal(makeSort("relevance")(prods).map((p) => p.name).join(""), "ABC");
});

test("filterFromPayload clears filters sent as 0/false (merge-safety)", () => {
  assert.equal(filterFromPayload({ q: "", on_sale: true }).on_sale, true);
  assert.equal(filterFromPayload({ q: "", on_sale: false }).on_sale, undefined);
  assert.equal(filterFromPayload({ q: "", max_price: 0 }).max_price, undefined);
  assert.equal(filterFromPayload({ q: "", max_price: 20 }).max_price, 20);
  assert.equal(filterFromPayload({ q: "tie" }).query, "tie");
});
