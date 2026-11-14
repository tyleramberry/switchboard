import { SecretStore, SecretRef } from "./store.js";

/**
 * Placeholder for a future 1Password backend (Sprint 6+). It exists so the seam
 * is visible: secret_run and the tools only see the SecretStore interface, so
 * swapping backends should not touch them.
 */
export class OnePasswordStore implements SecretStore {
  readonly kind = "1password";
  private fail(): never {
    throw new Error("OnePasswordStore: not implemented");
  }
  async get(_ref: SecretRef): Promise<string | null> {
    this.fail();
  }
  async has(_ref: SecretRef): Promise<boolean> {
    this.fail();
  }
  async set(_ref: SecretRef, _value: string): Promise<void> {
    this.fail();
  }
  async delete(_ref: SecretRef): Promise<boolean> {
    this.fail();
  }
}
