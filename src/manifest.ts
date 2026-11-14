import { readFileSync, existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import YAML from "yaml";

export interface CommandRule {
  program: string;
  /** Each argument must fully match one of these regexes. Empty/absent = no arguments allowed. */
  args: string[];
}

export interface SecretSpec {
  name: string;
  purpose: string;
  store: string;
  service: string;
  account: string;
  env: string;
  hosts: string[];
  http?: { header: string; template: string };
  commands: CommandRule[];
  timeout_sec: number;
  /** Opt-in escape hatch for shells/interpreters. Off by default. */
  unsafe_allow_interpreter: boolean;
}

export interface Manifest {
  version: number;
  secrets: SecretSpec[];
  warnings: string[];
}

export class ManifestError extends Error {}

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Programs that turn "allowed arguments" into "run anything". */
export const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh",
  "env", "xargs", "python", "python3", "node", "perl", "ruby", "php", "osascript",
  "awk", "gawk", "sed", "tclsh", "lua", "deno", "bun", "find", "make", "script", "sudo",
]);

function isInterpreter(program: string): boolean {
  const b = basename(program).replace(/[0-9.]+$/, "");
  return INTERPRETERS.has(basename(program)) || INTERPRETERS.has(b);
}

function str(v: unknown, field: string, name: string): string {
  if (typeof v !== "string" || !v) throw new ManifestError(`${name}: '${field}' must be a non-empty string`);
  return v;
}

export function parseManifest(text: string): Manifest {
  const doc = YAML.parse(text) ?? {};
  const warnings: string[] = [];
  if (typeof doc !== "object") throw new ManifestError("manifest must be a mapping");
  const raw = Array.isArray(doc.secrets) ? doc.secrets : [];
  const seen = new Set<string>();
  const secrets: SecretSpec[] = raw.map((s: any, i: number): SecretSpec => {
    const name = str(s?.name, "name", `secrets[${i}]`);
    if (!NAME_RE.test(name)) throw new ManifestError(`${name}: name must match ${NAME_RE}`);
    if (seen.has(name)) throw new ManifestError(`${name}: duplicate name`);
    seen.add(name);
    for (const forbidden of ["value", "secret", "password", "token"]) {
      if (forbidden in (s ?? {})) throw new ManifestError(`${name}: manifest must not contain a '${forbidden}' field (values live in the Keychain)`);
    }
    const env = s.env ?? name;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(env)) throw new ManifestError(`${name}: bad env name`);
    const unsafe = s.unsafe_allow_interpreter === true;
    const commands: CommandRule[] = (Array.isArray(s.commands) ? s.commands : []).map((c: any, j: number) => {
      const program = str(c?.program, `commands[${j}].program`, name);
      if (!isAbsolute(program)) throw new ManifestError(`${name}: program must be an absolute path: ${program}`);
      if (isInterpreter(program)) {
        if (!unsafe) throw new ManifestError(`${name}: ${program} is a shell/interpreter; refusing (set unsafe_allow_interpreter: true to override)`);
        warnings.push(`${name}: interpreter ${program} allowlisted with unsafe_allow_interpreter`);
      }
      const args: string[] = Array.isArray(c.args) ? c.args.map(String) : [];
      for (const a of args) new RegExp(`^(?:${a})$`); // throws on bad regex
      return { program, args };
    });
    const hosts: string[] = (Array.isArray(s.hosts) ? s.hosts : []).map((h: unknown) => String(h).toLowerCase());
    let http: SecretSpec["http"];
    if (s.http) {
      http = { header: str(s.http.header, "http.header", name), template: str(s.http.template, "http.template", name) };
      if (!http.template.includes("{value}")) throw new ManifestError(`${name}: http.template must contain {value}`);
      if (hosts.length === 0) throw new ManifestError(`${name}: http requires a hosts allowlist`);
    }
    const timeout = Number(s.timeout_sec ?? 30);
    if (!(timeout > 0 && timeout <= 300)) throw new ManifestError(`${name}: timeout_sec must be in (0, 300]`);
    return {
      name,
      purpose: String(s.purpose ?? ""),
      store: String(s.store ?? "keychain"),
      service: String(s.service ?? "switchboard"),
      account: String(s.account ?? name),
      env,
      hosts,
      http,
      commands,
      timeout_sec: timeout,
      unsafe_allow_interpreter: unsafe,
    };
  });
  return { version: Number(doc.version ?? 1), secrets, warnings };
}

export function loadManifest(path: string): Manifest {
  if (!existsSync(path)) return { version: 1, secrets: [], warnings: [] };
  return parseManifest(readFileSync(path, "utf8"));
}
