import { spawn } from "node:child_process";
import { SecretStore, SecretRef, SecretStoreError } from "./store.js";
import { ensureHelper, helperPathFor } from "./keychain-helper.js";

const SECURITY = "/usr/bin/security";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(program: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

/** Quote a token for `security -i` (its own tokenizer, not a shell). */
function q(s: string): string {
  if (/[\n\r]/.test(s)) throw new SecretStoreError("newlines are not supported in keychain fields");
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * macOS Keychain behind a switchboard-owned helper binary (the F2 fix).
 *
 * - Items are created with `-T <helper>` so the item ACL trusts ONLY the
 *   ad-hoc-signed helper — never /usr/bin/security, which any same-user
 *   process can exec.
 * - Reads and deletes go through the helper (value on the child's stdout,
 *   never argv). Writes go through `security -i` with the command on stdin,
 *   so the value never appears in any process's argv.
 * - `keychain` lets tests point at a throwaway keychain file instead of login.keychain.
 */
export class KeychainStore implements SecretStore {
  readonly kind = "keychain";
  constructor(private readonly keychain?: string) {}

  /** "-" = the default keychain search list (helper convention). */
  private kcArg(): string {
    return this.keychain ?? "-";
  }

  async get(ref: SecretRef): Promise<string | null> {
    const helper = ensureHelper(this.keychain);
    const r = await run(helper, ["read", this.kcArg(), ref.service, ref.account]);
    if (r.code === 44) return null; // errSecItemNotFound
    if (r.code !== 0) {
      throw new SecretStoreError(
        `keychain read failed for ${ref.name} (exit ${r.code})${r.stderr.trim() ? ": " + r.stderr.trim() : ""}`,
      );
    }
    return r.stdout.replace(/\n$/, "");
  }

  async has(ref: SecretRef): Promise<boolean> {
    return (await this.get(ref)) !== null;
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    const helper = ensureHelper(this.keychain);
    // Re-add rather than -U so the item's ACL is rebuilt trusting only the helper.
    await this.delete(ref);
    const kc = this.keychain ? " " + q(this.keychain) : "";
    const cmd = `add-generic-password -T ${q(helper)} -s ${q(ref.service)} -a ${q(ref.account)} -w ${q(value)}${kc}\n`;
    const r = await run(SECURITY, ["-i"], cmd);
    // `security -i` exits 0 even when a command fails; confirm by reading back.
    if (r.code !== 0 || !(await this.has(ref))) {
      throw new SecretStoreError(
        `keychain write failed for ${ref.name}: ${r.stderr.trim().split("\n")[0] ?? "unknown error"}`,
      );
    }
  }

  async delete(ref: SecretRef): Promise<boolean> {
    const helper = ensureHelper(this.keychain);
    const r = await run(helper, ["delete", this.kcArg(), ref.service, ref.account]);
    if (r.code === 44) return false; // errSecItemNotFound
    if (r.code === 0) return true;
    throw new SecretStoreError(
      `keychain delete failed for ${ref.name} (exit ${r.code})${r.stderr.trim() ? ": " + r.stderr.trim() : ""}`,
    );
  }
}

export { helperPathFor };
