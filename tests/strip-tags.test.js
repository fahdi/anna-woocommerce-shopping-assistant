import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTags } from "../executas/woo-shop/woo-client.js";

test("strips HTML tags", () => {
  assert.equal(stripTags("<b>hello</b>"), "hello");
  assert.equal(stripTags('<a href="x">link</a>'), "link");
});

test("decodes numeric entities", () => {
  assert.equal(stripTags("Hoodie &#8211; Blue"), "Hoodie – Blue");
  assert.equal(stripTags("&#169;"), "©");
});

test("decodes hex entities", () => {
  assert.equal(stripTags("&#x2013;"), "–");
  assert.equal(stripTags("&#X41;"), "A");
});

test("decodes named entities", () => {
  assert.equal(stripTags("&amp;"), "&");
  assert.equal(stripTags("&lt;b&gt;"), "<b>");
  assert.equal(stripTags("&quot;"), '"');
  assert.equal(stripTags("&apos;"), "'");
  // &nbsp; in context — mid-word spaces survive collapse; standalone trims to ""
  assert.equal(stripTags("foo&nbsp;bar"), "foo bar");
});

test("collapses whitespace and trims", () => {
  assert.equal(stripTags("  foo   bar  "), "foo bar");
  assert.equal(stripTags("&nbsp;"), ""); // lone non-breaking space trims away
});

test("handles empty and non-string input", () => {
  assert.equal(stripTags(""), "");
  assert.equal(stripTags(null), "");
  assert.equal(stripTags(undefined), "");
  assert.equal(stripTags(42), "42");
});

test("real-world WC product name", () => {
  assert.equal(
    stripTags("Hoodie &#8211; Blue, Yes"),
    "Hoodie – Blue, Yes"
  );
});
