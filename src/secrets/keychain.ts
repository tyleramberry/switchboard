import { spawn } from "node:child_process";
import { SecretStore, SecretRef, SecretStoreError } from "./store.js";

const SECURITY = "/usr/bin/security";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY, args, {
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
 * macOS Keychain via /usr/bin/security.
 *
 * - Reads use `find-generic-password -w` (value comes back on the child's stdout, never argv).
 * - Writes use `security -i` and feed the command on stdin, so the value never appears in
 *   any process's argv.
 * - `keychain` lets tests point at a throwaway keychain file instead of login.keychain.
 */
export class KeychainStore implements SecretStore {
  readonly kind = "keychain";
  constructor(private readonly keychain?: string) {}

  private kcArgs(): string[] {
    return this.keychain ? [this.keychain] : [];
  }

  async get(ref: SecretRef): Promise<string | null> {
    const r = await run(["find-generic-password", "-s", ref.service, "-a", ref.account, "-w", ...this.kcArgs()]);
    if (r.code === 44) return null; // errSecItemNotFound
    if (r.code !== 0) throw new SecretStoreError(`keychain read failed for ${ref.name} (exit ${r.code})`);
    return r.stdout.replace(/\n$/, "");
  }

  async has(ref: SecretRef): Promise<boolean> {
    const r = await run(["find-generic-password", "-s", ref.service, "-a", ref.account, ...this.kcArgs()]);
    return r.code === 0;
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    const kc = this.keychain ? " " + q(this.keychain) : "";
    const cmd = `add-generic-password -U -s ${q(ref.service)} -a ${q(ref.account)} -w ${q(value)}${kc}\n`;
    const r = await run(["-i"], cmd);
    // `security -i` exits 0 even when a command fails; confirm by reading back existence.
    if (r.code !== 0 || !(await this.has(ref))) {
      throw new SecretStoreError(
        `keychain write failed for ${ref.name}: ${r.stderr.trim().split("\n")[0] ?? "unknown error"}`,
      );
    }
  }

  async delete(ref: SecretRef): Promise<boolean> {
    const r = await run(["delete-generic-password", "-s", ref.service, "-a", ref.account, ...this.kcArgs()]);
    return r.code === 0;
  }
}
