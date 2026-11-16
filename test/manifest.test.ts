import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, writeManifestPin, verifyManifestPin, pinPathFor, ManifestError } from "../src/manifest.js";

const MANIFEST = `version: 1
secrets:
  - name: TEST
    purpose: test secret
    env: TEST_TOKEN
    hosts: [example.com]
    timeout_sec: 15
    commands:
      - program: /bin/echo
        args: [".*"]
`;

function withTempHome(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "sb-manifest-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("unpinned manifest loads with a warning", () => {
  withTempHome((root) => {
    const p = join(root, "secrets.manifest.yaml");
    writeFileSync(p, MANIFEST);
    const m = loadManifest(p);
    assert.equal(m.secrets.length, 1);
    assert.ok(m.warnings.some((w) => w.includes("not pinned")));
  });
});

test("pinned manifest loads clean; any change fails closed", () => {
  withTempHome((root) => {
    const p = join(root, "secrets.manifest.yaml");
    writeFileSync(p, MANIFEST);
    writeManifestPin(p);
    // unchanged: loads without the unpinned warning
    const m = loadManifest(p);
    assert.ok(!m.warnings.some((w) => w.includes("not pinned")));
    // tampered (agent widens its own allowlist): fails closed
    writeFileSync(p, MANIFEST.replace("hosts: [example.com]", "hosts: [example.com, evil.test]"));
    assert.throws(() => loadManifest(p), ManifestError);
    assert.throws(() => loadManifest(p), /changed since it was pinned/);
    // re-pin after an intentional owner edit: works again
    writeManifestPin(p);
    const m2 = loadManifest(p);
    assert.ok(m2.secrets[0].hosts.includes("evil.test"));
  });
});

test("verifyManifestPin returns the digest path contract", () => {
  withTempHome((root) => {
    const p = join(root, "secrets.manifest.yaml");
    writeFileSync(p, MANIFEST);
    assert.match(pinPathFor(p), /secrets\.manifest\.sha256$/);
    const digest = writeManifestPin(p);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(pinPathFor(p), "utf8").trim(), digest);
    assert.equal(verifyManifestPin(p), undefined);
  });
});

test("pin verification can be skipped explicitly (owner tooling)", () => {
  withTempHome((root) => {
    const p = join(root, "secrets.manifest.yaml");
    writeFileSync(p, MANIFEST);
    writeManifestPin(p);
    writeFileSync(p, MANIFEST + "# edited\n");
    const m = loadManifest(p, { verifyPin: false });
    assert.equal(m.secrets.length, 1);
  });
});
