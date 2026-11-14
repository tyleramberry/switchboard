/**
 * SecretStore: the only seam between Switchboard and wherever secret values live.
 *
 * Rules every implementation must follow:
 * - Values are returned only to in-process callers (secret_run, the leak scanner).
 *   No MCP tool ever returns a value.
 * - Implementations must never put a value on a command line (argv is visible
 *   to every process of the same user via `ps`).
 */
export interface SecretRef {
  /** Logical secret name from secrets.manifest.yaml, e.g. DEMO_API_TOKEN. */
  name: string;
  /** Backend-specific locator (Keychain service, 1Password vault/item...). */
  service: string;
  account: string;
}

export interface SecretStore {
  readonly kind: string;
  /** Returns the value, or null when the item does not exist. */
  get(ref: SecretRef): Promise<string | null>;
  has(ref: SecretRef): Promise<boolean>;
  set(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<boolean>;
}

export class SecretStoreError extends Error {}
