import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKeys } from "../src/app.ts";

test("parseKeys reads key:account pairs and trims spaces", () => {
  const m = parseKeys("k1:alice, k2:bob ,");
  assert.equal(m.get("k1"), "alice");
  assert.equal(m.get("k2"), "bob");
  assert.equal(m.size, 2);
});

test("parseKeys gives an empty map for an empty string", () => {
  assert.equal(parseKeys("").size, 0);
});

test("parseKeys keeps colons in the account part", () => {
  assert.equal(parseKeys("k:acct:1").get("k"), "acct:1");
});

test("parseKeys rejects entries missing a key or an account", () => {
  for (const bad of ["nocolon", ":acct", "key:"]) assert.throws(() => parseKeys(bad), /bad API_KEYS/);
});
