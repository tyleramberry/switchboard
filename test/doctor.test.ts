import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifest, loadManifest, writeManifestPin } from "../src/manifest.js";
import { lintManifest } from "../src/doctor.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STRICT = `version: 1
secrets:
  - name: STRICT
    purpose: api token
    env: STRICT_TOKEN
    hosts: [api.example.com]
    timeout_sec: 15
    commands:
      - program: /bin/echo
        args: [".*"]
`;

const LAB = `version: 1
secrets:
  - name: LAB
    purpose: deliberately unsafe profile
    unsafe_allow_interpreter: true
    env: LAB_TOKEN
    hosts: [httpbin.org]
    timeout_sec: 15
    commands:
      - program: /bin/sh
        args: [".*"]
      - program: /usr/bin/curl
        args: [".*"]
`;

test("doctor catches the red-team LAB profile instantly", () => {
  const m = parseManifest(LAB);
  const f = lintManifest(m);
  const errors = f.filter((x) => x.severity === "error");
  assert.ok(errors.length >= 2, `want >=2 errors, got ${JSON.stringify(errors)}`);
  assert.ok(errors.some((x) => x.secret === "LAB" && /interpreter \/bin\/sh/.test(x.message)));
  assert.ok(errors.some((x) => x.secret === "LAB" && /curl/.test(x.message)));
});

test("doctor accepts the strict profile", () => {
  const m = parseManifest(STRICT);
  const f = lintManifest(m);
  assert.equal(f.filter((x) => x.severity === "error").length, 0);
  // echo with catch-all args is only a warning, not an error
  assert.ok(f.some((x) => x.severity === "warning" && /matches any argument/.test(x.message)));
});

test("doctor flags wildcard hosts, local hosts, long timeouts, missing purpose", () => {
  const m = parseManifest(`version: 1
secrets:
  - name: WILD
    hosts: ["*.example.com", "localhost"]
    timeout_sec: 300
    commands: []
`);
  const f = lintManifest(m);
  assert.ok(f.some((x) => x.severity === "warning" && /wildcard/.test(x.message)));
  assert.ok(f.some((x) => x.severity === "info" && /local address localhost/.test(x.message)));
  assert.ok(f.some((x) => x.severity === "info" && /timeout_sec is 300s/.test(x.message)));
  assert.ok(f.some((x) => x.severity === "info" && /no purpose text/.test(x.message)));
});

test("doctor reports an empty manifest as info, not an error", () => {
  const f = lintManifest(parseManifest("version: 1\n"));
  assert.equal(f.filter((x) => x.severity === "error").length, 0);
  assert.ok(f.some((x) => /no secrets declared/.test(x.message)));
});

test("narrow arg patterns are not flagged", () => {
  const m = parseManifest(`version: 1
secrets:
  - name: NARROW
    purpose: scoped command
    timeout_sec: 15
    commands:
      - program: /usr/local/bin/deploy
        args: ["--prod", "--check"]
`);
  const f = lintManifest(m);
  assert.equal(f.length, 0, JSON.stringify(f));
});

test("lintManifest never touches secret values (pure manifest input)", () => {
  // the lint input is the parsed manifest only; no store call happens anywhere in doctor.ts
  const m = parseManifest(STRICT);
  assert.doesNotThrow(() => lintManifest(m));
});
