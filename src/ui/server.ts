/**
 * `switchboard ui`: a local control panel over the same modules the MCP server uses.
 *
 * Guardrails (see docs/decisions.md):
 * - bound to 127.0.0.1 only; Host must be 127.0.0.1:PORT or localhost:PORT (DNS rebinding);
 *   a cross-origin Origin is refused (CSRF).
 * - every /api call needs the random per-launch token in the `x-switchboard-token` header.
 * - no endpoint returns a secret value. Values are write-only (set/rotate) and every JSON
 *   response passes through the scrubber built from every stored value.
 * - Home git commits happen only through POST /api/commit (the "Commit changes" button).
 * - inbox artifacts are served only for names listed on the card, from inside
 *   .switchboard/inbox-artifacts/<id>/, and only after a scrub check of the raw bytes.
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { Switchboard } from "../server.js";
import { SecretStore } from "../secrets/store.js";
import { loadManifest, parseManifest, writeManifestPin, verifyManifestPin, pinPathFor, ManifestError } from "../manifest.js";
import { runDoctor, lintManifest, DoctorFinding } from "../doctor.js";
import { HARNESSES } from "../installers/index.js";
import { unifiedDiff, applyPlan, Plan } from "../installers/common.js";
import { PathError } from "../memory.js";
import { InboxError, InboxView, ARTIFACT_MIME } from "../inbox.js";
import { SKILL_NAME } from "../skills.js";
import { PolicyError } from "../secret-run.js";
import { TOKEN_PATTERNS, REDACTED, Scrubber } from "../scrub.js";

export interface UiOptions {
  root: string;
  port?: number;
  store?: SecretStore;
  /** Per-harness config dir overrides (tests point these at temp dirs). */
  harnessDirs?: Record<string, string>;
}

export interface UiHandle {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

/** Repo root: dist/src/ui/server.js -> ../../.. ; src/ui/server.ts (ts-node) -> ../.. */
function packageRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(d, "package.json")) && existsSync(join(d, "ui", "public"))) return d;
    d = dirname(d);
  }
  throw new Error("cannot locate ui/public next to package.json");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function maskTokens(s: string): string {
  let out = s;
  for (const re of TOKEN_PATTERNS) out = out.replace(new RegExp(re.source, "g"), REDACTED);
  return out;
}

function git(root: string, args: string[]) {
  return spawnSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

export function gitStatus(root: string): { repo: boolean; clean: boolean; changes: { status: string; path: string }[] } {
  const r = git(root, ["status", "--porcelain"]);
  if (r.status !== 0) return { repo: false, clean: true, changes: [] };
  const changes = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3) }));
  return { repo: true, clean: changes.length === 0, changes };
}

export function pinState(manifestPath: string): "pinned" | "unpinned" | "tampered" | "missing" {
  if (!existsSync(manifestPath)) return "missing";
  if (!existsSync(pinPathFor(manifestPath))) return "unpinned";
  try {
    verifyManifestPin(manifestPath);
    return "pinned";
  } catch {
    return "tampered";
  }
}

/** Title words with dates and filler removed, for near-duplicate detection. */
function titleKey(t: string): Set<string> {
  const stop = new Set(["the", "a", "an", "and", "of", "to", "for", "on", "in", "is"]);
  return new Set(
    t
      .toLowerCase()
      .replace(/\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !stop.has(w)),
  );
}

export function nearDuplicates(notes: { path: string; title: string }[]): { a: string; b: string; titleA: string; titleB: string }[] {
  const keys = notes.map((n) => titleKey(n.title));
  const out = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const A = keys[i], B = keys[j];
      if (A.size === 0 || B.size === 0) continue;
      let inter = 0;
      for (const w of A) if (B.has(w)) inter++;
      const jac = inter / (A.size + B.size - inter);
      if (jac >= 0.75) out.push({ a: notes[i].path, b: notes[j].path, titleA: notes[i].title, titleB: notes[j].title });
    }
  }
  return out;
}

interface EntryInput {
  name: string;
  purpose?: string;
  env?: string;
  store?: string;
  service?: string;
  account?: string;
  hosts?: string[];
  http?: { header: string; template: string } | null;
  commands?: { program: string; args?: string[] }[];
  timeout_sec?: number;
}

function cleanList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

export class UiApi {
  readonly sb: Switchboard;
  constructor(readonly opts: UiOptions) {
    this.sb = new Switchboard({ root: opts.root, store: opts.store });
  }

  private dirFor(harness: string): string | undefined {
    return this.opts.harnessDirs?.[harness];
  }

  claudeDir(): string {
    return this.dirFor("claude-code") ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  }
  hermesDir(): string {
    return this.dirFor("hermes") ?? process.env.HERMES_HOME ?? join(homedir(), ".hermes");
  }
  codexDir(): string {
    return this.dirFor("codex") ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  }

  // ---------------- dashboard ----------------
  async dashboard() {
    const p = this.sb.paths;
    const findings = runDoctor(p.manifest);
    const notes = this.sb.memory.list();
    const skills = this.sb.skills.list();
    let secrets: any[] = [];
    let secretsError: string | null = null;
    try {
      secrets = await this.sb.secretList();
    } catch (e) {
      secretsError = (e as Error).message;
    }
    const harnesses = this.harnesses();
    const attention: { kind: string; message: string; target?: string }[] = [];
    for (const d of nearDuplicates(notes)) {
      attention.push({ kind: "duplicate", message: `Possible duplicate notes: "${d.titleA}" and "${d.titleB}"`, target: d.a });
    }
    for (const s of secrets) {
      if (s.present !== true) attention.push({ kind: "secret", message: `Secret ${s.name} has no value in ${s.store}`, target: s.name });
    }
    for (const s of this.skillsVisibility(skills.map((s) => s.name))) {
      if (!s.claude) attention.push({ kind: "skill", message: `Skill ${s.name} has no Claude Code symlink in ${join(this.claudeDir(), "skills")}`, target: s.name });
    }
    for (const h of harnesses) {
      if (h.state === "out of sync") attention.push({ kind: "harness", message: `${h.label} is out of sync with Home`, target: h.id });
    }
    if (secretsError) attention.push({ kind: "manifest", message: `Manifest not loadable: ${secretsError}` });
    const inbox = this.sb.inbox.counts();
    if (inbox.open) attention.unshift({ kind: "inbox", message: `${inbox.open} decision${inbox.open === 1 ? "" : "s"} waiting in the Inbox` });
    return {
      inboxOpenCount: inbox.open,
      home: p.root,
      doctor: findings,
      pin: pinState(p.manifest),
      git: gitStatus(p.root),
      counts: {
        notes: notes.length,
        handoffs: notes.filter((n) => n.type === "handoff").length,
        skills: skills.length,
        secrets: secrets.length,
        harnesses: harnesses.filter((h) => h.state === "installed").length,
        inbox: inbox.open,
      },
      attention,
    };
  }

  // ---------------- inbox ----------------
  inboxList(view: string, harness?: string) {
    const v = (view || "open") as InboxView;
    if (!["open", "snoozed", "resolved"].includes(v)) throw new HttpError(400, "view must be open, snoozed or resolved");
    const pruned = this.sb.inbox.prune(30).removed;
    return { view: v, pruned, counts: this.sb.inbox.counts(), cards: this.sb.inbox.list(v, { harness }) };
  }

  async inboxDecide(id: string, b: any) {
    const decision = typeof b?.decision === "string" || typeof b?.decision === "number" ? String(b.decision) : "";
    const feedback = b?.feedback === undefined || b?.feedback === null ? undefined : String(b.feedback);
    return this.sb.inboxDecide(id, { decision, feedback, saveRule: b?.save_rule === true, source: "switchboard-ui" });
  }

  inboxSnooze(id: string, b: any) {
    return this.sb.inbox.snooze(id, String(b?.until ?? ""));
  }

  // ---------------- memory ----------------
  memoryList(q?: string, type?: string, tag?: string) {
    if (q && q.trim()) return { mode: "search", results: this.sb.memory.search(q, { limit: 50, type, tag }) };
    const notes = this.sb.memory
      .list()
      .filter((n) => !type || n.type === type)
      .filter((n) => !tag || n.tags.includes(tag))
      .map(({ body, ...rest }) => ({ ...rest, excerpt: body.replace(/\s+/g, " ").trim().slice(0, 180) }));
    return { mode: "list", results: notes };
  }

  private async guardText(parts: string[]): Promise<void> {
    const reason = await this.sb.memoryLeakReason(parts.join("\n"));
    if (reason) throw new HttpError(422, `refused: ${reason}`);
  }

  private noteInput(b: any) {
    const title = String(b?.title ?? "").trim();
    const body = String(b?.body ?? "");
    if (!title || title.length > 200) throw new HttpError(400, "title is required (max 200 chars)");
    if (!body.trim() || body.length > 100_000) throw new HttpError(400, "body is required (max 100000 chars)");
    const tags = cleanList(b?.tags).slice(0, 20);
    const type = b?.type ? String(b.type).slice(0, 40) : undefined;
    const source = b?.source !== undefined ? String(b.source).slice(0, 80) : undefined;
    return { title, body, tags, type, source };
  }

  async memoryCreate(b: any) {
    const n = this.noteInput(b);
    await this.guardText([n.title, n.body, ...n.tags, n.source ?? ""]);
    return this.sb.memory.write({ ...n, source: n.source || "switchboard-ui" });
  }

  async memoryUpdate(path: string, b: any) {
    const n = this.noteInput(b);
    await this.guardText([n.title, n.body, ...n.tags, n.source ?? ""]);
    return this.sb.memory.update(path, n);
  }

  handoffs() {
    return this.sb.memory
      .list()
      .filter((n) => n.type === "handoff" || n.tags.includes("handoff"))
      .map((n) => ({ ...n, resolved: n.tags.includes("resolved") }));
  }

  async handoffResolve(path: string, resolved: boolean) {
    const n = this.sb.memory.read(path);
    const tags = n.tags.filter((t) => t !== "resolved");
    if (resolved) tags.push("resolved");
    return this.sb.memory.update(path, { title: n.title, body: n.body, type: n.type, tags });
  }

  // ---------------- skills ----------------
  skillsVisibility(names: string[]) {
    const home = this.sb.paths.skills;
    let hermes = false;
    try {
      const cfg = YAML.parse(readFileSync(join(this.hermesDir(), "config.yaml"), "utf8"));
      const ext = cfg?.skills?.external_dirs;
      hermes = Array.isArray(ext) && ext.some((d: unknown) => resolve(String(d)) === resolve(home));
    } catch {
      hermes = false;
    }
    const linked = (dir: string, name: string) => {
      const link = join(dir, "skills", name);
      try {
        const st = lstatSync(link);
        return st.isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === join(home, name);
      } catch {
        return false;
      }
    };
    return names.map((name) => ({ name, hermes, claude: linked(this.claudeDir(), name), codex: linked(this.codexDir(), name) }));
  }

  skillsList() {
    const list = this.sb.skills.list();
    const vis = new Map(this.skillsVisibility(list.map((s) => s.name)).map((v) => [v.name, v]));
    return list.map((s) => ({ ...s, visibility: vis.get(s.name) }));
  }

  async skillPut(name: string, b: any) {
    const file = String(b?.file ?? "SKILL.md");
    const content = String(b?.content ?? "");
    if (content.length > 200_000) throw new HttpError(400, "content too large");
    await this.guardText([content]);
    return this.sb.skills.put(name, file, content);
  }

  async skillCreate(b: any) {
    const name = String(b?.name ?? "").trim();
    const description = String(b?.description ?? "").trim();
    if (!SKILL_NAME.test(name)) throw new HttpError(400, "skill name must be lowercase letters, digits, . _ - (max 64)");
    if (!description) throw new HttpError(400, "description is required");
    await this.guardText([name, description, String(b?.body ?? "")]);
    return this.sb.skills.create(name, description, b?.body ? String(b.body) : undefined);
  }

  // ---------------- secrets ----------------
  private manifestText(): string {
    return existsSync(this.sb.paths.manifest) ? readFileSync(this.sb.paths.manifest, "utf8") : "version: 1\nsecrets: []\n";
  }

  async secrets() {
    const p = this.sb.paths.manifest;
    const findings = runDoctor(p);
    let list: any[] = [];
    let entries: any[] = [];
    let error: string | null = null;
    try {
      list = await this.sb.secretList();
      entries = this.sb.manifest().secrets.map((s) => ({
        name: s.name, purpose: s.purpose, env: s.env, store: s.store, service: s.service, account: s.account,
        hosts: s.hosts, http: s.http ?? null, commands: s.commands, timeout_sec: s.timeout_sec,
        unsafe_allow_interpreter: s.unsafe_allow_interpreter,
      }));
    } catch (e) {
      error = (e as Error).message;
    }
    return { pin: pinState(p), findings, secrets: list, entries, error };
  }

  /** Build the candidate manifest text with one entry added/replaced. Never touches disk. */
  private candidate(entry: EntryInput, mode: "create" | "update"): { text: string; findings: DoctorFinding[]; errors: string[] } {
    const name = String(entry?.name ?? "").trim();
    const doc = YAML.parseDocument(this.manifestText());
    if (doc.errors.length) return { text: "", findings: [], errors: [`manifest YAML: ${doc.errors[0].message}`] };
    const js: any = doc.toJSON() ?? {};
    const list: any[] = Array.isArray(js.secrets) ? js.secrets : [];
    const idx = list.findIndex((s) => s?.name === name);
    if (mode === "create" && idx !== -1) return { text: "", findings: [], errors: [`${name} already exists`] };
    if (mode === "update" && idx === -1) return { text: "", findings: [], errors: [`${name} does not exist`] };
    const prev = idx === -1 ? {} : list[idx];
    const obj: Record<string, unknown> = { name, purpose: String(entry.purpose ?? "").trim() };
    obj.store = entry.store?.trim() || prev.store || "keychain";
    obj.service = entry.service?.trim() || prev.service || "switchboard";
    obj.account = entry.account?.trim() || prev.account || name;
    obj.env = entry.env?.trim() || prev.env || name;
    obj.hosts = cleanList(entry.hosts).map((h) => h.toLowerCase());
    if (entry.http && (entry.http.header || entry.http.template)) obj.http = { header: String(entry.http.header).trim(), template: String(entry.http.template) };
    obj.commands = (Array.isArray(entry.commands) ? entry.commands : [])
      .filter((c) => c && String(c.program ?? "").trim())
      .map((c) => ({ program: String(c.program).trim(), args: cleanList(c.args) }));
    if (entry.timeout_sec !== undefined && entry.timeout_sec !== null && String(entry.timeout_sec) !== "") obj.timeout_sec = Number(entry.timeout_sec);
    else if (prev.timeout_sec !== undefined) obj.timeout_sec = prev.timeout_sec;
    // The form cannot turn the interpreter escape hatch on; an existing opt-in is preserved.
    if (prev.unsafe_allow_interpreter === true) obj.unsafe_allow_interpreter = true;
    if (!doc.has("secrets") || !YAML.isSeq(doc.get("secrets"))) doc.set("secrets", doc.createNode([]));
    const seq = doc.get("secrets") as YAML.YAMLSeq;
    if (idx === -1) seq.add(doc.createNode(obj));
    else seq.set(idx, doc.createNode(obj));
    const text = String(doc);
    try {
      const m = parseManifest(text);
      const findings = lintManifest(m).filter((f) => !f.secret || f.secret === name);
      const errors = findings.filter((f) => f.severity === "error").map((f) => f.message);
      return { text, findings, errors };
    } catch (e) {
      if (e instanceof ManifestError || e instanceof SyntaxError) return { text, findings: [], errors: [(e as Error).message] };
      throw e;
    }
  }

  validateEntry(entry: EntryInput, mode: "create" | "update") {
    const c = this.candidate(entry, mode);
    return { ok: c.errors.length === 0, errors: c.errors, findings: c.findings };
  }

  /** Refuse to re-pin over a manifest that changed behind the owner's back. */
  private assertNotTampered() {
    if (pinState(this.sb.paths.manifest) === "tampered") {
      throw new HttpError(409, "the manifest changed since it was pinned. Review `git diff` in Home and run `switchboard pin` before editing here.");
    }
  }

  saveEntry(entry: EntryInput, mode: "create" | "update") {
    if (!entry || typeof entry.name !== "string") throw new HttpError(400, "entry.name is required");
    this.assertNotTampered();
    const c = this.candidate(entry, mode);
    if (c.errors.length) throw new HttpError(422, `rejected by doctor: ${c.errors.join("; ")}`);
    writeFileSync(this.sb.paths.manifest, c.text);
    const digest = writeManifestPin(this.sb.paths.manifest);
    return { ok: true, name: entry.name, pinned: digest.slice(0, 12), findings: c.findings };
  }

  async deleteEntry(name: string) {
    this.assertNotTampered();
    const spec = this.sb.manifest().secrets.find((s) => s.name === name);
    if (!spec) throw new HttpError(404, `unknown secret ${name}`);
    const doc = YAML.parseDocument(this.manifestText());
    const seq = doc.get("secrets") as YAML.YAMLSeq;
    const idx = (doc.toJSON().secrets as any[]).findIndex((s) => s?.name === name);
    seq.delete(idx);
    const text = String(doc);
    parseManifest(text);
    let valueDeleted = false;
    try {
      valueDeleted = await this.sb.storeFor(spec).delete({ name: spec.name, service: spec.service, account: spec.account });
    } catch {
      valueDeleted = false;
    }
    writeFileSync(this.sb.paths.manifest, text);
    writeManifestPin(this.sb.paths.manifest);
    return { ok: true, name, valueDeleted };
  }

  /** Write-only. The value is never logged, echoed or returned. */
  async setValue(name: string, value: unknown) {
    if (typeof value !== "string" || value.length < 4 || value.length > 16_384) throw new HttpError(400, "value must be 4 to 16384 characters");
    const spec = this.sb.manifest().secrets.find((s) => s.name === name);
    if (!spec) throw new HttpError(404, `unknown secret ${name}`);
    await this.sb.storeFor(spec).set({ name: spec.name, service: spec.service, account: spec.account }, value);
    return { ok: true, name, present: true };
  }

  // ---------------- harnesses ----------------
  private plan(id: string): Plan {
    const fn = HARNESSES[id];
    if (!fn) throw new HttpError(404, `unknown harness ${id}`);
    return fn({ root: this.sb.paths.root, configDir: this.dirFor(id), dryRun: true, log: () => {} });
  }

  harnesses() {
    const labels: Record<string, string> = { hermes: "Hermes", "claude-code": "Claude Code", codex: "Codex", grokbot: "Grokbot", buzz: "Buzz" };
    return Object.keys(HARNESSES).map((id) => {
      try {
        const p = this.plan(id);
        const changed = p.files.filter((f) => f.before !== f.after);
        let state: string;
        if (p.status === "manual") state = "manual";
        else if (changed.length === 0 && p.links.length === 0) state = "installed";
        else if (p.files.every((f) => f.before === null || !f.before.includes("switchboard"))) state = "not installed";
        else state = "out of sync";
        return { id, label: labels[id] ?? id, tested: p.status, state, changedFiles: changed.map((f) => f.path), newLinks: p.links.length, notes: p.notes };
      } catch (e) {
        return { id, label: labels[id] ?? id, tested: "UNTESTED", state: "error", changedFiles: [], newLinks: 0, notes: [(e as Error).message] };
      }
    });
  }

  harnessDiff(id: string) {
    const p = this.plan(id);
    const files = p.files
      .filter((f) => f.before !== f.after)
      // harness configs (e.g. ~/.claude.json) can hold unrelated credentials: mask token shapes too
      .map((f) => ({ path: f.path, isNew: f.before === null, diff: maskTokens(unifiedDiff(f.path, f.before, f.after)) }));
    return { id, tested: p.status, files, links: p.links, notes: p.notes };
  }

  harnessApply(id: string) {
    const p = this.plan(id);
    const lines: string[] = [];
    applyPlan(p, { root: this.sb.paths.root, configDir: this.dirFor(id), dryRun: false, log: (s) => lines.push(s) });
    return { id, log: lines };
  }

  harnessTest(id: string): Promise<{ id: string; ok: boolean; command: string; output: string }> {
    const cmds: Record<string, string[]> = {
      hermes: ["hermes", "mcp", "test", "switchboard"],
      "claude-code": ["claude", "mcp", "get", "switchboard"],
    };
    const argv = cmds[id];
    if (!argv) return Promise.resolve({ id, ok: false, command: "", output: `no quick test for ${id} (untested or manual harness)` });
    return new Promise((done) => {
      const env = { ...process.env };
      if (id === "hermes" && this.dirFor(id)) env.HERMES_HOME = this.dirFor(id);
      if (id === "claude-code" && this.dirFor(id)) env.CLAUDE_CONFIG_DIR = this.dirFor(id);
      const child = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const t = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", (e) => {
        clearTimeout(t);
        done({ id, ok: false, command: argv.join(" "), output: `could not run ${argv[0]}: ${e.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(t);
        done({ id, ok: code === 0, command: argv.join(" "), output: out.slice(-8000) });
      });
    });
  }

  // ---------------- git ----------------
  commit(message: unknown) {
    const msg = String(message ?? "").trim();
    if (!msg || msg.length > 200) throw new HttpError(400, "commit message is required (max 200 chars)");
    const st = gitStatus(this.sb.paths.root);
    if (!st.repo) throw new HttpError(409, "Home is not a git repository (run `git init` in Home first)");
    if (st.clean) throw new HttpError(409, "nothing to commit");
    const add = git(this.sb.paths.root, ["add", "-A"]);
    if (add.status !== 0) throw new HttpError(500, `git add failed: ${add.stderr.trim()}`);
    const c = git(this.sb.paths.root, ["commit", "-m", msg]);
    if (c.status !== 0) throw new HttpError(500, `git commit failed: ${(c.stderr || c.stdout).trim()}`);
    const head = git(this.sb.paths.root, ["rev-parse", "--short", "HEAD"]).stdout.trim();
    return { ok: true, commit: head, git: gitStatus(this.sb.paths.root) };
  }

  close() {
    this.sb.close();
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

export async function startUi(opts: UiOptions): Promise<UiHandle> {
  const api = new UiApi(opts);
  const token = randomBytes(24).toString("hex");
  const tokenBuf = Buffer.from(token);
  const pub = join(packageRoot(), "ui", "public");
  let port = opts.port ?? 7337;

  const scrubberSafe = async () => {
    // Scrubbing must keep working when the manifest is tampered or broken: read it without the
    // pin check (values are only collected to redact them, never returned).
    try {
      return new Scrubber(await api.sb.allValues(loadManifest(api.sb.paths.manifest, { verifyPin: false })));
    } catch {
      return null;
    }
  };

  const send = async (res: ServerResponse, status: number, body: unknown) => {
    const sc = await scrubberSafe();
    let text = JSON.stringify(body);
    if (sc) text = sc.scrub(text).text;
    else if (status < 400) {
      // cannot build a scrubber: fail closed rather than return unscrubbed data
      status = 500;
      text = JSON.stringify({ error: "could not load secrets to scrub the response; check secrets.manifest.yaml" });
    }
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(text);
  };

  /** Raw image bytes, never JSON. Refused if the bytes contain any encoding of a stored value. */
  const sendArtifact = async (res: ServerResponse, id: string, file: string) => {
    const real = api.sb.inbox.artifactPath(id, file);
    const bytes = readFileSync(real);
    const sc = await scrubberSafe();
    if (!sc) throw new HttpError(500, "could not load secrets to check the artifact; check secrets.manifest.yaml");
    if (sc.contains(bytes.toString("latin1"))) throw new HttpError(422, "refused: artifact contains a stored secret value");
    res.writeHead(200, {
      "content-type": ARTIFACT_MIME[extname(real).toLowerCase()] ?? "application/octet-stream",
      "content-length": bytes.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    res.end(bytes);
  };

  const route = async (req: IncomingMessage, url: URL): Promise<[number, unknown]> => {
    const m = req.method ?? "GET";
    const path = url.pathname;
    const q = (k: string) => url.searchParams.get(k) ?? "";
    const seg = path.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
    const is = (method: string, p: string) => m === method && path === p;

    if (is("GET", "/api/dashboard")) return [200, await api.dashboard()];
    if (is("GET", "/api/git")) return [200, gitStatus(api.sb.paths.root)];
    if (is("POST", "/api/commit")) return [200, api.commit((await readJson(req)).message)];

    if (is("GET", "/api/inbox")) return [200, api.inboxList(q("view"), q("harness") || undefined)];
    if (seg[1] === "inbox" && seg.length === 4 && m === "POST") {
      if (seg[3] === "decide") return [200, await api.inboxDecide(seg[2], await readJson(req))];
      if (seg[3] === "snooze") return [200, api.inboxSnooze(seg[2], await readJson(req))];
    }

    if (is("GET", "/api/memory")) return [200, api.memoryList(q("q"), q("type") || undefined, q("tag") || undefined)];
    if (is("POST", "/api/memory")) return [201, await api.memoryCreate(await readJson(req))];
    if (path === "/api/memory/note") {
      if (m === "GET") return [200, { note: api.sb.memory.read(q("path")) }];
      if (m === "PUT") return [200, await api.memoryUpdate(q("path"), await readJson(req))];
      if (m === "DELETE") {
        api.sb.memory.remove(q("path"));
        return [200, { ok: true }];
      }
    }
    if (is("GET", "/api/handoffs")) return [200, api.handoffs()];
    if (is("POST", "/api/handoffs/resolve")) {
      const b = await readJson(req);
      return [200, await api.handoffResolve(String(b.path ?? ""), b.resolved !== false)];
    }

    if (is("GET", "/api/skills")) return [200, api.skillsList()];
    if (is("POST", "/api/skills")) return [201, await api.skillCreate(await readJson(req))];
    if (seg[1] === "skills" && seg.length === 3) {
      if (m === "GET") return [200, api.sb.skills.get(seg[2], q("file") || "SKILL.md")];
      if (m === "PUT") return [200, await api.skillPut(seg[2], await readJson(req))];
    }

    if (is("GET", "/api/secrets")) return [200, await api.secrets()];
    if (is("POST", "/api/secrets/validate")) {
      const b = await readJson(req);
      return [200, api.validateEntry(b.entry, b.mode === "update" ? "update" : "create")];
    }
    if (is("POST", "/api/secrets/entry")) return [201, api.saveEntry((await readJson(req)).entry, "create")];
    if (is("PUT", "/api/secrets/entry")) return [200, api.saveEntry((await readJson(req)).entry, "update")];
    if (is("DELETE", "/api/secrets/entry")) return [200, await api.deleteEntry(q("name"))];
    if (is("POST", "/api/secrets/value")) {
      const b = await readJson(req);
      return [200, await api.setValue(String(b.name ?? ""), b.value)];
    }

    if (is("GET", "/api/harnesses")) return [200, api.harnesses()];
    if (seg[1] === "harnesses" && seg.length === 4) {
      if (m === "GET" && seg[3] === "diff") return [200, api.harnessDiff(seg[2])];
      if (m === "POST" && seg[3] === "apply") return [200, api.harnessApply(seg[2])];
      if (m === "POST" && seg[3] === "test") return [200, await api.harnessTest(seg[2])];
    }
    throw new HttpError(404, "not found");
  };

  const server = createServer(async (req, res) => {
    try {
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const host = (req.headers.host ?? "").toLowerCase();
      if (!allowedHosts.includes(host)) {
        res.writeHead(421, { "content-type": "text/plain" });
        return res.end("bad host");
      }
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedHosts.map((h) => `http://${h}`).includes(origin.toLowerCase())) {
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("cross-origin request refused");
      }
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname.startsWith("/api/")) {
        const got = Buffer.from(String(req.headers["x-switchboard-token"] ?? ""));
        if (got.length !== tokenBuf.length || !timingSafeEqual(got, tokenBuf)) {
          return await send(res, 401, { error: "missing or bad token; open the URL printed by `switchboard ui`" });
        }
        try {
          const seg = url.pathname.split("/").filter(Boolean);
          if (req.method === "GET" && seg[1] === "inbox" && seg[2] === "artifact") {
            if (seg.length !== 5) throw new PathError("invalid artifact path");
            return await sendArtifact(res, decodeURIComponent(seg[3]), decodeURIComponent(seg[4]));
          }
          const [status, body] = await route(req, url);
          return await send(res, status, body);
        } catch (e) {
          const status =
            e instanceof HttpError ? e.status
            : e instanceof PathError ? 400
            : e instanceof InboxError ? ({ invalid: 400, not_found: 404, conflict: 409 } as const)[e.code]
            : e instanceof PolicyError ? 422
            : e instanceof ManifestError ? 422
            : 500;
          return await send(res, status, { error: (e as Error).message });
        }
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        return res.end();
      }
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) {
        res.writeHead(404);
        return res.end("not found");
      }
      const file = join(pub, name);
      if (!existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, {
        "content-type": MIME[extname(name)] ?? "application/octet-stream",
        "content-security-policy": CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : readFileSync(file));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok());
  });
  const addr = server.address();
  if (addr && typeof addr === "object") port = addr.port;
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  return {
    url,
    port,
    token,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections?.();
        server.close(() => {
          api.close();
          ok();
        });
      }),
  };
}
