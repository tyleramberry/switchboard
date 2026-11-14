import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { initHome } from "../src/home.js";

export function tempHome(): { root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "sb-test-"));
  const root = join(base, "home");
  initHome(root);
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/**
 * A throwaway keychain file (never login.keychain). Unattended sessions cannot write to the
 * login keychain ("User interaction is not allowed"), and tests must not touch it anyway.
 */
export function tempKeychain(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sb-kc-"));
  const path = join(dir, "switchboard-test.keychain-db");
  const pw = randomBytes(12).toString("hex");
  const run = (args: string[]) => {
    const r = spawnSync("/usr/bin/security", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`security ${args[0]} failed: ${r.stderr}`);
  };
  run(["create-keychain", "-p", pw, path]);
  run(["unlock-keychain", "-p", pw, path]);
  run(["set-keychain-settings", path]); // no auto-lock timeout
  return {
    path,
    cleanup: () => {
      spawnSync("/usr/bin/security", ["delete-keychain", path]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Manifest with one test secret using service `switchboard-test`. */
export function writeTestManifest(root: string, extra = ""): void {
  writeFileSync(
    join(root, "secrets.manifest.yaml"),
    `version: 1
secrets:
  - name: TEST_TOKEN
    purpose: dummy token for tests
    service: switchboard-test
    account: TEST_TOKEN
    env: TEST_TOKEN
    hosts: [httpbin.org, "*.example.com"]
    http: { header: Authorization, template: "Bearer {value}" }
    timeout_sec: 5
    commands:
      - program: /usr/bin/printenv
        args: ["TEST_TOKEN", "HOME", "PATH"]
      - program: /bin/echo
        args: [".*"]
      - program: /bin/sleep
        args: ["[0-9]+"]
      - program: /usr/bin/base64
        args: []
${extra}`,
  );
}
