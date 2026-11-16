import { test } from "node:test";
import assert from "node:assert/strict";
import { Scrubber, encodedForms, REDACTED } from "../src/scrub.js";

const V = "dummy-SECRET_value-12345";

test("scrubs raw, reversed, base64, hex, url-encoded forms", () => {
  const s = new Scrubber([V]);
  const bytes = Buffer.from(V);
  const cases = [
    V,
    [...V].reverse().join(""),
    bytes.toString("base64"),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
    encodeURIComponent(V),
    [...bytes].map((b) => "%" + b.toString(16).padStart(2, "0")).join(""),
    [...bytes].map((b) => "%" + b.toString(16).padStart(2, "0").toUpperCase()).join(""),
  ];
  for (const c of cases) {
    const out = s.scrub(`before ${c} after`);
    assert.equal(out.text.includes(c), false, `leaked form: ${c}`);
    assert.ok(out.redactions >= 1, `no redaction for ${c}`);
  }
});

test("finds base64 of the value inside a longer base64 blob at any alignment", () => {
  const s = new Scrubber([V]);
  for (const prefix of ["", "a", "ab", "abc"]) {
    const blob = Buffer.from(`${prefix}xx${V}yy`).toString("base64");
    assert.ok(s.scrub(blob).redactions >= 1, `missed alignment prefix=${JSON.stringify(prefix)}`);
  }
});

test("tolerates line wrapping (base64 -b 8, xxd -p style)", () => {
  const s = new Scrubber([V]);
  const wrapped = Buffer.from(V).toString("base64").replace(/(.{8})/g, "$1\n");
  assert.ok(s.scrub(wrapped).redactions >= 1);
  const hexWrapped = Buffer.from(V).toString("hex").replace(/(.{10})/g, "$1\n");
  assert.ok(s.scrub(hexWrapped).redactions >= 1);
});

test("leaves unrelated text alone", () => {
  const s = new Scrubber([V]);
  const t = "hello world, nothing to see";
  assert.deepEqual(s.scrub(t), { text: t, redactions: 0 });
  assert.equal(new Scrubber([]).scrub(V).text, V);
});

test("encodedForms never includes tiny fragments", () => {
  const f = encodedForms("abcd");
  for (const x of [...f.exact, ...f.caseless]) assert.ok(x.length >= 4);
  assert.ok(new Scrubber(["abcd"]).scrub("xabcdx").text.includes(REDACTED));
});

test("scrubs rot13 (the tr 'A-Za-z' 'N-ZA-Mn-za-m' leak) and rot13-of-reversed", () => {
  const rot13 = (s: string) => s.replace(/[a-zA-Z]/g, (c) => {
    const b = c.charCodeAt(0);
    const base = b <= 90 ? 65 : 97;
    return String.fromCharCode(((b - base + 13) % 26) + base);
  });
  const s = new Scrubber([V]);
  assert.equal(s.scrub(rot13(V)).redactions, 1);
  assert.equal(s.scrub(rot13([...V].reverse().join(""))).redactions, 1);
  assert.ok(s.scrub(rot13(V)).text.includes(REDACTED));
  // a rot13 transform of something else is not redacted
  const t = rot13("totally unrelated text here");
  assert.deepEqual(s.scrub(t), { text: t, redactions: 0 });
});
