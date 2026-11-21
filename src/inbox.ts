/**
 * Agent decision inbox: a short-term operational queue in .switchboard/inbox.db.
 *
 * Cards are small on purpose (title <= 100, summary <= 600, 2 to 4 options, option 1 is the
 * recommended default). Resolved cards are pruned after 30 days; durable lessons belong in
 * memory/, not here. This module does no secret scanning: callers (Switchboard.inboxSubmit,
 * the UI API) run memoryLeakReason() before anything reaches submit().
 */
import { DatabaseSync } from "node:sqlite";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { homePaths } from "./home.js";
import { containedPath, PathError } from "./memory.js";

/** Bad input (caps, unknown card, wrong state). The UI maps it to 400/404/409. */
export class InboxError extends Error {
  constructor(message: string, readonly code: "invalid" | "not_found" | "conflict" = "invalid") {
    super(message);
  }
}

export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type Priority = (typeof PRIORITIES)[number];
export type InboxView = "open" | "snoozed" | "resolved";

export const LIMITS = {
  title: 100,
  summary: 600,
  option: 80,
  minOptions: 2,
  maxOptions: 4,
  name: 64,
  decision: 200,
  feedback: 2000,
  caption: 200,
  artifacts: 4,
  artifactBytes: 10 * 1024 * 1024,
  maxBlocks: 1000,
} as const;

export interface InboxOption {
  key: string;
  label: string;
}

export interface InboxArtifact {
  /** File name inside .switchboard/inbox-artifacts/<id>/ */
  file: string;
  caption: string;
}

export interface InboxCard {
  id: string;
  title: string;
  summary: string;
  harness: string;
  agent: string;
  project: string;
  priority: Priority;
  blockingCount: number;
  status: "open" | "resolved";
  options: InboxOption[];
  artifacts: InboxArtifact[];
  createdAt: string;
  snoozedUntil: string | null;
  decision: string | null;
  /** Label of the chosen option, or the free-text override itself. */
  decisionLabel: string | null;
  feedback: string | null;
  decidedAt: string | null;
  pickedUpAt: string | null;
  distilledAt: string | null;
  savedAsRule: boolean;
}

export interface SubmitInput {
  title: string;
  summary: string;
  options: string[];
  harness: string;
  agent?: string;
  project?: string;
  priority?: string;
  blockingCount?: number;
  artifacts?: { path: string; caption?: string }[];
}

const ID_RE = /^ib_[0-9a-f]{12}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ARTIFACT_FILE_RE = /^[0-9]-[a-z0-9-]{1,60}\.(png|jpg|gif|webp)$/;
const DAY = 86_400_000;

/** Magic bytes for the image types a card may carry. Extension alone is not trusted. */
const IMAGE_MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  webp: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

export const ARTIFACT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function assertCardId(id: string): void {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new PathError("invalid card id");
}

/** `2h`, `30m`, `3d`, `tomorrow` (9am local) or an ISO timestamp; must be in the future. */
export function parseUntil(spec: string, now: Date): Date {
  const s = String(spec ?? "").trim().toLowerCase();
  let t: Date | null = null;
  const rel = /^(\d{1,4})(m|h|d)$/.exec(s);
  if (rel) t = new Date(now.getTime() + Number(rel[1]) * { m: 60_000, h: 3_600_000, d: DAY }[rel[2] as "m" | "h" | "d"]);
  else if (s === "tomorrow") {
    t = new Date(now);
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0, 0, 0);
  } else if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const ms = Date.parse(spec.trim());
    if (!Number.isNaN(ms)) t = new Date(ms);
  }
  if (!t) throw new InboxError("snooze needs 30m, 2h, 3d, tomorrow, or an ISO timestamp");
  if (t.getTime() <= now.getTime()) throw new InboxError("snooze time must be in the future");
  return t;
}

function text(v: unknown, field: string, max: number, required = true): string {
  const s = typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim();
  if (required && !s) throw new InboxError(`${field} is required`);
  if (s.length > max) throw new InboxError(`${field} is too long (${s.length} > ${max} chars)`);
  if (s.includes("\0")) throw new InboxError(`${field} contains a NUL byte`);
  return s;
}

function name(v: unknown, field: string, required: boolean): string {
  const s = text(v, field, LIMITS.name, required);
  if (s && !NAME_RE.test(s)) throw new InboxError(`${field} must be letters, digits, . _ - (max 64)`);
  return s;
}

function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";
}

function sniff(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(16);
    readSync(fd, b, 0, 16, 0);
    return b;
  } finally {
    closeSync(fd);
  }
}

function rowToCard(r: any): InboxCard {
  const options: InboxOption[] = JSON.parse(r.options_json);
  const decision: string | null = r.decision ?? null;
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    harness: r.harness,
    agent: r.agent,
    project: r.project,
    priority: r.priority,
    blockingCount: Number(r.blocking_count),
    status: r.status,
    options,
    artifacts: JSON.parse(r.artifacts_json),
    createdAt: r.created_at,
    snoozedUntil: r.snoozed_until ?? null,
    decision,
    decisionLabel: decision === null ? null : (options.find((o) => o.key === decision)?.label ?? decision),
    feedback: r.feedback ?? null,
    decidedAt: r.decided_at ?? null,
    pickedUpAt: r.picked_up_at ?? null,
    distilledAt: r.distilled_at ?? null,
    savedAsRule: Number(r.saved_as_rule) === 1,
  };
}

const SCHEMA = `
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS inbox_cards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    harness TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'p2',
    blocking_count INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open',
    options_json TEXT NOT NULL,
    artifacts_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    snoozed_until TEXT,
    decision TEXT,
    feedback TEXT,
    decided_at TEXT,
    picked_up_at TEXT,
    distilled_at TEXT,
    saved_as_rule INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_open ON inbox_cards(status, priority, blocking_count DESC, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_inbox_poll ON inbox_cards(status, harness, picked_up_at);
  CREATE INDEX IF NOT EXISTS idx_inbox_distill ON inbox_cards(status, distilled_at);
`;

export class InboxStore {
  private db: DatabaseSync;
  readonly artifactsDir: string;
  private readonly now: () => Date;

  constructor(readonly root: string, opts: { now?: () => Date } = {}) {
    const p = homePaths(root);
    this.artifactsDir = p.inboxArtifacts;
    this.now = opts.now ?? (() => new Date());
    mkdirSync(p.state, { recursive: true });
    this.db = new DatabaseSync(p.inboxDb);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Validate and normalise a submission without touching disk. */
  validate(input: SubmitInput) {
    const title = text(input?.title, "title", LIMITS.title);
    const summary = text(input?.summary, "summary", LIMITS.summary);
    const rawOptions = Array.isArray(input?.options) ? input.options : [];
    if (rawOptions.length < LIMITS.minOptions || rawOptions.length > LIMITS.maxOptions) {
      throw new InboxError(`a card needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} options (got ${rawOptions.length})`);
    }
    const options = rawOptions.map((o, i) => ({ key: String(i + 1), label: text(o, `option ${i + 1}`, LIMITS.option) }));
    const harness = name(input?.harness, "harness", true);
    const agent = name(input?.agent, "agent", false);
    const project = name(input?.project, "project", false);
    const priority = (input?.priority ?? "p2").toString().trim().toLowerCase();
    if (!(PRIORITIES as readonly string[]).includes(priority)) throw new InboxError("priority must be p0, p1, p2 or p3");
    const blockingCount = input?.blockingCount ?? 1;
    if (!Number.isInteger(blockingCount) || blockingCount < 0 || blockingCount > LIMITS.maxBlocks) {
      throw new InboxError(`blocks must be an integer 0 to ${LIMITS.maxBlocks}`);
    }
    const rawArtifacts = Array.isArray(input?.artifacts) ? input.artifacts : [];
    if (rawArtifacts.length > LIMITS.artifacts) throw new InboxError(`at most ${LIMITS.artifacts} artifacts per card`);
    const artifacts = rawArtifacts.map((a, i) => {
      const src = String(a?.path ?? "");
      if (!src || !isAbsolute(src) || src.includes("\0")) throw new InboxError(`artifact ${i + 1}: path must be absolute`);
      let ext = extname(src).toLowerCase().slice(1);
      if (ext === "jpeg") ext = "jpg";
      if (!IMAGE_MAGIC[ext]) throw new InboxError(`artifact ${i + 1}: only png, jpg, gif or webp images are allowed`);
      if (!existsSync(src)) throw new InboxError(`artifact ${i + 1}: file not found`);
      const st = statSync(src);
      if (!st.isFile()) throw new InboxError(`artifact ${i + 1}: not a regular file`);
      if (st.size > LIMITS.artifactBytes) throw new InboxError(`artifact ${i + 1}: larger than 10 MB`);
      if (!IMAGE_MAGIC[ext](sniff(src))) throw new InboxError(`artifact ${i + 1}: file content is not a ${ext} image`);
      const caption = text(a?.caption, `artifact ${i + 1} caption`, LIMITS.caption, false);
      return { src, file: `${i + 1}-${slug(basename(src, extname(src)))}.${ext}`, caption };
    });
    return { title, summary, options, harness, agent, project, priority: priority as Priority, blockingCount, artifacts };
  }

  submit(input: SubmitInput): InboxCard {
    const v = this.validate(input);
    const id = `ib_${randomBytes(6).toString("hex")}`;
    const dir = join(this.artifactsDir, id);
    if (v.artifacts.length) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const a of v.artifacts) copyFileSync(a.src, join(dir, a.file));
    }
    try {
      this.db
        .prepare(
          `INSERT INTO inbox_cards(id,title,summary,harness,agent,project,priority,blocking_count,status,options_json,artifacts_json,created_at)
           VALUES (?,?,?,?,?,?,?,?,'open',?,?,?)`,
        )
        .run(
          id, v.title, v.summary, v.harness, v.agent, v.project, v.priority, v.blockingCount,
          JSON.stringify(v.options), JSON.stringify(v.artifacts.map(({ file, caption }) => ({ file, caption }))), this.iso(),
        );
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    return this.get(id);
  }

  get(id: string): InboxCard {
    assertCardId(id);
    const r = this.db.prepare("SELECT * FROM inbox_cards WHERE id = ?").get(id);
    if (!r) throw new InboxError(`card ${id} not found`, "not_found");
    return rowToCard(r);
  }

  list(view: InboxView = "open", opts: { harness?: string } = {}): InboxCard[] {
    const now = this.iso();
    const where: string[] = [];
    const args: string[] = [];
    let order: string;
    if (view === "open") {
      where.push("status = 'open'", "(snoozed_until IS NULL OR snoozed_until <= ?)");
      args.push(now);
      order = "priority ASC, blocking_count DESC, created_at ASC, rowid ASC";
    } else if (view === "snoozed") {
      where.push("status = 'open'", "snoozed_until > ?");
      args.push(now);
      order = "snoozed_until ASC, rowid ASC";
    } else if (view === "resolved") {
      where.push("status = 'resolved'");
      order = "decided_at DESC, rowid DESC";
    } else throw new InboxError("view must be open, snoozed or resolved");
    if (opts.harness) {
      where.push("harness = ?");
      args.push(opts.harness);
    }
    return this.db
      .prepare(`SELECT * FROM inbox_cards WHERE ${where.join(" AND ")} ORDER BY ${order}`)
      .all(...args)
      .map(rowToCard);
  }

  counts(): { open: number; snoozed: number; resolved: number } {
    const now = this.iso();
    const r = this.db
      .prepare(
        `SELECT
           SUM(status = 'open' AND (snoozed_until IS NULL OR snoozed_until <= ?)) AS open,
           SUM(status = 'open' AND snoozed_until > ?) AS snoozed,
           SUM(status = 'resolved') AS resolved
         FROM inbox_cards`,
      )
      .get(now, now) as any;
    return { open: Number(r?.open ?? 0), snoozed: Number(r?.snoozed ?? 0), resolved: Number(r?.resolved ?? 0) };
  }

  private openCard(id: string): InboxCard {
    const c = this.get(id);
    if (c.status !== "open") throw new InboxError(`card ${id} is already resolved`, "conflict");
    return c;
  }

  /** `decision` is an option key ("1" to "4") or a short free-text override. */
  decide(id: string, input: { decision: string; feedback?: string }): InboxCard {
    const decision = text(input?.decision, "decision", LIMITS.decision);
    const feedback = text(input?.feedback, "feedback", LIMITS.feedback, false);
    return this.tx(() => {
      this.openCard(id);
      this.db
        .prepare("UPDATE inbox_cards SET status = 'resolved', decision = ?, feedback = ?, decided_at = ?, snoozed_until = NULL WHERE id = ?")
        .run(decision, feedback || null, this.iso(), id);
      return this.get(id);
    });
  }

  snooze(id: string, until: string): InboxCard {
    const t = parseUntil(until, this.now());
    this.openCard(id);
    this.db.prepare("UPDATE inbox_cards SET snoozed_until = ? WHERE id = ?").run(t.toISOString(), id);
    return this.get(id);
  }

  markSavedAsRule(id: string): InboxCard {
    this.get(id);
    this.db.prepare("UPDATE inbox_cards SET saved_as_rule = 1 WHERE id = ?").run(id);
    return this.get(id);
  }

  /** Resolved cards nobody has picked up yet. With `ack`, stamp them so the next poll skips them. */
  poll(opts: { harness?: string; agent?: string; ack?: boolean } = {}): InboxCard[] {
    const where = ["status = 'resolved'", "picked_up_at IS NULL"];
    const args: string[] = [];
    if (opts.harness) {
      where.push("harness = ?");
      args.push(opts.harness);
    }
    if (opts.agent) {
      where.push("agent = ?");
      args.push(opts.agent);
    }
    return this.tx(() => {
      const rows = this.db.prepare(`SELECT * FROM inbox_cards WHERE ${where.join(" AND ")} ORDER BY decided_at ASC, rowid ASC`).all(...args);
      if (!opts.ack) return rows.map(rowToCard);
      const stamp = this.iso();
      const up = this.db.prepare("UPDATE inbox_cards SET picked_up_at = ? WHERE id = ?");
      for (const r of rows as any[]) up.run(stamp, r.id);
      return rows.map((r: any) => rowToCard({ ...r, picked_up_at: stamp }));
    });
  }

  /** Delete resolved cards decided more than `days` ago, plus their artifact dirs. */
  prune(days = 30): { removed: number } {
    const cutoff = new Date(this.now().getTime() - days * DAY).toISOString();
    const ids = (this.db.prepare("SELECT id FROM inbox_cards WHERE status = 'resolved' AND decided_at < ?").all(cutoff) as any[]).map((r) => String(r.id));
    if (!ids.length) return { removed: 0 };
    this.tx(() => {
      const del = this.db.prepare("DELETE FROM inbox_cards WHERE id = ?");
      for (const id of ids) del.run(id);
    });
    for (const id of ids) {
      if (!ID_RE.test(id)) continue;
      const dir = join(this.artifactsDir, id);
      if (existsSync(dir) && lstatSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true });
    }
    return { removed: ids.length };
  }

  /** Resolved cards not yet distilled into memory/. `markDistilled` stamps them. */
  distillExport(opts: { markDistilled?: boolean } = {}): InboxCard[] {
    return this.tx(() => {
      const rows = this.db.prepare("SELECT * FROM inbox_cards WHERE status = 'resolved' AND distilled_at IS NULL ORDER BY decided_at ASC, rowid ASC").all();
      if (!opts.markDistilled) return rows.map(rowToCard);
      const stamp = this.iso();
      const up = this.db.prepare("UPDATE inbox_cards SET distilled_at = ? WHERE id = ?");
      for (const r of rows as any[]) up.run(stamp, r.id);
      return rows.map((r: any) => rowToCard({ ...r, distilled_at: stamp }));
    });
  }

  /** Real path of one card's artifact. Refuses bad ids, unlisted names, traversal and symlinks. */
  artifactPath(id: string, file: string): string {
    assertCardId(id);
    if (typeof file !== "string" || !ARTIFACT_FILE_RE.test(file)) throw new PathError("invalid artifact name");
    const r = this.db.prepare("SELECT artifacts_json FROM inbox_cards WHERE id = ?").get(id) as any;
    const listed: InboxArtifact[] = r ? JSON.parse(r.artifacts_json) : [];
    if (!listed.some((a) => a.file === file)) throw new PathError("not found");
    if (!existsSync(this.artifactsDir)) throw new PathError("not found");
    const real = containedPath(this.artifactsDir, join(id, file));
    if (!lstatSync(real).isFile()) throw new PathError("not a file");
    return real;
  }
}
