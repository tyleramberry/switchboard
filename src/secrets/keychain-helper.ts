import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SecretStoreError } from "./store.js";

/**
 * A tiny compiled helper that is the ONLY binary trusted by keychain items
 * (item ACLs are created with `-T <helper>`). F2 fix, 2026-11-16: before this,
 * items trusted /usr/bin/security itself, so any same-user process could read
 * a value with `security find-generic-password -w`.
 *
 * The helper is ad-hoc code-signed after compile. Keychain ACL trust binds to
 * the code's identity (cdhash), so an attacker who OVERWRITES the helper at
 * its path is no longer trusted (prompt -> refused headlessly). Residual,
 * documented honestly in WRITEUP.md: the intact helper is exec-able by any
 * same-user process, so a shell-level attacker can still call it. That is the
 * "same user = trusted" boundary; the real fix is the 1Password backend.
 */

const HELPER_NAME = "switchboard-keychain-read";
const CLANG = "/usr/bin/clang";
const CODESIGN = "/usr/bin/codesign";

const C_SOURCE = String.raw`#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

/* read or delete one generic-password item. Prints the value for "read". */
int main(int argc, char **argv) {
  if (argc != 5) { fprintf(stderr, "usage: %s <read|delete> <keychain|-> <service> <account>\n", argv[0]); return 2; }
  const char *mode = argv[1];
  SecKeychainRef kc = NULL;
  if (strcmp(argv[2], "-") != 0) {
    if (SecKeychainOpen(argv[2], &kc) != errSecSuccess) { fprintf(stderr, "keychain open failed\n"); return 4; }
  }
  void *data = NULL;
  UInt32 len = 0;
  SecKeychainItemRef item = NULL;
  OSStatus st = SecKeychainFindGenericPassword(kc, (UInt32)strlen(argv[3]), argv[3],
      (UInt32)strlen(argv[4]), argv[4], &len, &data,
      mode[0] == 'd' ? (SecKeychainItemRef *)&item : NULL);
  if (st == errSecItemNotFound) { if (kc) CFRelease(kc); return 44; }
  if (st != errSecSuccess) { fprintf(stderr, "keychain read failed (%d)\n", (int)st); if (kc) CFRelease(kc); return 1; }
  if (mode[0] == 'd') {
    OSStatus d = SecKeychainItemDelete(item);
    if (d != errSecSuccess) { fprintf(stderr, "keychain delete failed (%d)\n", (int)d); return 1; }
    printf("deleted\n");
  } else {
    fwrite(data, 1, len, stdout);
    printf("\n");
  }
  if (data) SecKeychainItemFreeContent(NULL, data);
  if (item) CFRelease(item);
  if (kc) CFRelease(kc);
  return 0;
}
`;

export function helperPathFor(keychain?: string): string {
  if (keychain) return join(dirname(keychain), HELPER_NAME);
  const home = (process.env.SWITCHBOARD_HOME ?? "").trim() || join(homedir(), "agent-home");
  return join(home, ".switchboard", HELPER_NAME);
}

/**
 * Compile (once) and ad-hoc-sign the helper. Idempotent; never touched when
 * the binary and its sidecar signature of "this node built me" are current.
 */
export function ensureHelper(keychain?: string): string {
  const p = helperPathFor(keychain);
  const parentFile = p + ".built-by";
  const node = process.execPath;
  if (existsSync(p) && existsSync(parentFile) && readFileSync(parentFile, "utf8").trim() === node) {
    return p;
  }
  mkdirSync(dirname(p), { recursive: true });
  const src = join(dirname(p), HELPER_NAME + ".c");
  writeFileSync(src, C_SOURCE);
  const r = spawnSync(
    CLANG,
    ["-O2", "-Wno-deprecated-declarations", "-framework", "Security", "-framework", "CoreFoundation", src, "-o", p],
    { encoding: "utf8", timeout: 60_000 },
  );
  rmSync(src, { force: true });
  if (r.status !== 0 || !existsSync(p)) {
    throw new SecretStoreError(
      `could not build the keychain helper (clang failed): ${(r.stderr || "").trim().slice(0, 200)}`,
    );
  }
  // Ad-hoc signature: the item ACL binds to this cdhash, so replacing the
  // binary at the same path breaks trust (the overwrite attacker gets a
  // prompt, which is a refusal in an unattended context).
  spawnSync(CODESIGN, ["--force", "--sign", "-", p], { encoding: "utf8" });
  chmodSync(p, 0o700);
  writeFileSync(parentFile, node + "\n");
  return p;
}
