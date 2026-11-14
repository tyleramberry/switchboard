import { KeychainStore } from "./keychain.js";
import { OnePasswordStore } from "./onepassword.js";
import { SecretStore } from "./store.js";

export * from "./store.js";
export { KeychainStore } from "./keychain.js";
export { OnePasswordStore } from "./onepassword.js";

/**
 * Pick a backend. SWITCHBOARD_KEYCHAIN points the Keychain backend at a specific
 * keychain file (used by tests and the red team so they never touch login.keychain).
 */
export function createStore(kind: string = "keychain", env: NodeJS.ProcessEnv = process.env): SecretStore {
  switch (kind) {
    case "keychain":
      return new KeychainStore(env.SWITCHBOARD_KEYCHAIN || undefined);
    case "1password":
      return new OnePasswordStore();
    default:
      throw new Error(`unknown secret store: ${kind}`);
  }
}
