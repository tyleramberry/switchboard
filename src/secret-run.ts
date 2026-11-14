import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { SecretSpec } from "./manifest.js";
import { SecretStore } from "./secrets/store.js";
import { Scrubber } from "./scrub.js";

export const MAX_OUTPUT = 256 * 1024;

export interface CommandRequest {
  argv: string[];
}
export interface HttpRequest {
  method?: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface RunOutcome {
  ok: boolean;
  exit_code: number | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  status?: number;
  redactions: number;
  truncated: boolean;
}

export class PolicyError extends Error {}

const URL_IN_ARG = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/**
 * curl flags that would defeat the URL host check or leak by side channel: proxies, config
 * files, DNS overrides, redirects, output to disk, variable expansion of file contents.
 * Applies whenever the invoked program is curl; everything else still has to match the
 * manifest's arg regexes. Prefer the http mode over curl for anything new.
 */
const CURL_DENY = new Set([
  "-x", "--proxy", "--proxy1.0", "--preproxy", "--proxytunnel", "-p",
  "--connect-to", "--resolve", "--doh-url", "-K", "--config", "-q",
  "--expand-url", "--expand-connect-to", "--expand-proxy",
  "-o", "-O", "--output", "--remote-name", "-J",
  "-T", "--upload-file", "-L", "--location",
  "--unix-socket", "--abstract-socket",
]);

/** Programs that speak to the network; their bare-host arguments are host-checked. */
const NET_TOOLS = new Set(["curl", "wget", "fetch"]);

/** A bare "host" or "host:port" token (with a dot), optionally with scheme/userinfo. */
const HOSTISH = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[A-Za-z0-9._~%-]+@)?([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::\d{1,5})?$/;

function hostAllowed(host: string, hosts: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return hosts.some((a) => h === a || (a.startsWith("*.") && h.endsWith(a.slice(1))));
}

/** Throws PolicyError unless argv is allowed for this secret. Exported for tests. */
export function checkCommand(spec: SecretSpec, argv: string[]): void {
  if (!Array.isArray(argv) || argv.length === 0) throw new PolicyError("argv must be a non-empty array");
  for (const a of argv) {
    if (typeof a !== "string") throw new PolicyError("argv entries must be strings");
    if (a.includes("\0")) throw new PolicyError("NUL byte in argument");
  }
  const [program, ...args] = argv;
  const base = basename(program);
  if (NET_TOOLS.has(base)) {
    for (const a of args) {
      if (CURL_DENY.has(a)) throw new PolicyError(`${program} flag ${a} is not allowed (host allowlist could be bypassed)`);
    }
  }
  const rule = spec.commands.find((c) => c.program === program);
  if (!rule) {
    throw new PolicyError(
      `program not allowlisted for ${spec.name}: ${program} (allowed: ${spec.commands.map((c) => c.program).join(", ") || "none"})`,
    );
  }
  const res = rule.args.map((r) => new RegExp(`^(?:${r})$`, "s"));
  args.forEach((a, i) => {
    if (!res.some((re) => re.test(a))) throw new PolicyError(`argument ${i + 1} not allowed by manifest: ${JSON.stringify(a)}`);
    for (const m of a.matchAll(URL_IN_ARG)) {
      let host: string;
      try {
        host = new URL(m[0]).hostname;
      } catch {
        throw new PolicyError(`unparsable URL in argument ${i + 1}`);
      }
      if (!hostAllowed(host, spec.hosts)) throw new PolicyError(`host not allowlisted for ${spec.name}: ${host}`);
    }
    // A bare host(:port) argument to a network tool is checked too, so "curl -x 1.2.3.4:8"
    // or "curl httpbin.org" cannot smuggle a proxy/target past the URL check.
    if (NET_TOOLS.has(base)) {
      const m = HOSTISH.exec(a);
      if (m && m[1].includes(".")) {
        const host = m[1].toLowerCase();
        if (!hostAllowed(host, spec.hosts)) throw new PolicyError(`host not allowlisted for ${spec.name}: ${host}`);
      }
    }
  });
}

export function checkHttp(spec: SecretSpec, req: HttpRequest): URL {
  if (!spec.http) throw new PolicyError(`${spec.name} has no http rule in the manifest`);
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    throw new PolicyError("invalid URL");
  }
  if (u.protocol !== "https:") throw new PolicyError("only https URLs are allowed");
  if (u.username || u.password) throw new PolicyError("credentials in URL are not allowed");
  if (!hostAllowed(u.hostname, spec.hosts)) throw new PolicyError(`host not allowlisted for ${spec.name}: ${u.hostname}`);
  const method = (req.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) throw new PolicyError("method not allowed");
  for (const k of Object.keys(req.headers ?? {})) {
    if (k.toLowerCase() === spec.http.header.toLowerCase()) throw new PolicyError(`header ${k} is set by Switchboard`);
  }
  return u;
}

function audit(path: string | undefined, entry: Record<string, unknown>): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch {
    /* audit is best effort */
  }
}

export interface RunContext {
  store: SecretStore;
  /** Scrubber over every secret value known to the server (defense in depth). */
  extraScrubValues?: string[];
  auditPath?: string;
  timeoutMs?: number;
}

async function loadValue(spec: SecretSpec, store: SecretStore): Promise<string> {
  const value = await store.get({ name: spec.name, service: spec.service, account: spec.account });
  if (value === null) throw new PolicyError(`secret ${spec.name} has no value in the ${store.kind} store`);
  if (value.length < 4) throw new PolicyError(`secret ${spec.name} is too short to scrub safely (<4 chars)`);
  return value;
}

export async function runCommand(spec: SecretSpec, req: CommandRequest, ctx: RunContext): Promise<RunOutcome> {
  checkCommand(spec, req.argv);
  const value = await loadValue(spec, ctx.store);
  const scrubber = new Scrubber([value, ...(ctx.extraScrubValues ?? [])]);
  const work = mkdtempSync(join(tmpdir(), "sb-run-"));
  const timeoutMs = ctx.timeoutMs ?? spec.timeout_sec * 1000;
  try {
    const result = await new Promise<{ code: number | null; out: string; err: string; timedOut: boolean; truncated: boolean }>(
      (resolve, reject) => {
        const child = spawn(req.argv[0], req.argv.slice(1), {
          shell: false,
          cwd: work,
          detached: true, // own process group, so a timeout kills grandchildren too
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: work, TMPDIR: work, LANG: "en_US.UTF-8", [spec.env]: value },
        });
        let out = "", err = "", truncated = false, timedOut = false;
        const cap = (cur: string, d: Buffer) => {
          if (cur.length + d.length > MAX_OUTPUT) {
            truncated = true;
            return (cur + d.toString("utf8")).slice(0, MAX_OUTPUT);
          }
          return cur + d.toString("utf8");
        };
        child.stdout!.on("data", (d: Buffer) => (out = cap(out, d)));
        child.stderr!.on("data", (d: Buffer) => (err = cap(err, d)));
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, timeoutMs);
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(new PolicyError(`spawn failed: ${(e as Error).message}`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, out, err, timedOut, truncated });
        });
      },
    );
    const so = scrubber.scrub(result.out);
    const se = scrubber.scrub(result.err);
    const redactions = so.redactions + se.redactions;
    audit(ctx.auditPath, {
      tool: "secret_run", kind: "command", secret: spec.name, program: req.argv[0],
      exit: result.code, timed_out: result.timedOut, redactions,
    });
    return {
      ok: !result.timedOut && result.code === 0,
      exit_code: result.code,
      timed_out: result.timedOut,
      stdout: so.text,
      stderr: se.text,
      redactions,
      truncated: result.truncated,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function runHttp(spec: SecretSpec, req: HttpRequest, ctx: RunContext): Promise<RunOutcome> {
  const url = checkHttp(spec, req);
  const value = await loadValue(spec, ctx.store);
  const scrubber = new Scrubber([value, ...(ctx.extraScrubValues ?? [])]);
  const timeoutMs = ctx.timeoutMs ?? spec.timeout_sec * 1000;
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  headers[spec.http!.header] = spec.http!.template.replace("{value}", value);
  let status = 0, body = "", timedOut = false, truncated = false;
  try {
    const res = await fetch(url, {
      method: (req.method ?? "GET").toUpperCase(),
      headers,
      body: req.body,
      redirect: "manual", // never carry the credential to a redirect target
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    body = await res.text();
    if (body.length > MAX_OUTPUT) {
      body = body.slice(0, MAX_OUTPUT);
      truncated = true;
    }
    if (status >= 300 && status < 400) body = `[redirect to ${res.headers.get("location") ?? "?"} not followed]\n` + body;
  } catch (e) {
    timedOut = (e as Error).name === "TimeoutError";
    body = `request failed: ${(e as Error).message}`;
  }
  const s = scrubber.scrub(body);
  audit(ctx.auditPath, { tool: "secret_run", kind: "http", secret: spec.name, host: url.hostname, status, redactions: s.redactions });
  return {
    ok: status >= 200 && status < 300,
    exit_code: null,
    timed_out: timedOut,
    status,
    stdout: s.text,
    stderr: "",
    redactions: s.redactions,
    truncated,
  };
}
