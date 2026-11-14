import { DatabaseSync } from "node:sqlite";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, realpathSync, lstatSync,
} from "node:fs";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import YAML from "yaml";
import { homePaths } from "./home.js";

export interface MemoryNote {
  path: string; // relative to memory/
  title: string;
  type: string;
  tags: string[];
  date: string;
  body: string;
}

export class PathError extends Error {}

export function splitFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  let meta: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(m[1]);
    if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
  } catch {
    /* treat unparsable frontmatter as body */
    return { meta: {}, body: text };
  }
  return { meta, body: m[2] };
}

function toNote(rel: string, text: string): MemoryNote {
  const { meta, body } = splitFrontmatter(text);
  const tags = Array.isArray(meta.tags) ? meta.tags.map(String) : typeof meta.tags === "string" ? [meta.tags] : [];
  const firstHeading = /^#\s+(.+)$/m.exec(body)?.[1];
  return {
    path: rel,
    title: String(meta.title ?? firstHeading ?? rel.replace(/\.md$/, "")),
    type: String(meta.type ?? "note"),
    tags,
    date: meta.date instanceof Date ? meta.date.toISOString().slice(0, 10) : String(meta.date ?? ""),
    body,
  };
}

/**
 * Resolve `requested` inside `base` and refuse anything that escapes it, including via
 * symlinks. Returns the real absolute path.
 */
export function containedPath(base: string, requested: string): string {
  if (typeof requested !== "string" || !requested || requested.includes("\0")) throw new PathError("invalid path");
  if (isAbsolute(requested)) throw new PathError("absolute paths are not allowed");
  const realBase = realpathSync(base);
  const candidate = resolve(realBase, requested);
  const inside = (p: string) => p === realBase || p.startsWith(realBase + sep);
  if (!inside(candidate)) throw new PathError("path escapes the allowed directory");
  if (!existsSync(candidate)) throw new PathError("not found");
  const real = realpathSync(candidate);
  if (!inside(real)) throw new PathError("path escapes the allowed directory (symlink)");
  return real;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "note"
  );
}

function walkMd(dir: string, base: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walkMd(full, base, out);
    else if (ent.isFile() && ent.name.endsWith(".md")) out.push(relative(base, full));
    // symlinks are skipped on purpose: they could point outside memory/
  }
  return out;
}

export interface SearchHit {
  path: string;
  title: string;
  type: string;
  tags: string[];
  date: string;
  snippet: string;
  score: number;
}

/**
 * Memory store. Markdown under memory/ is the source of truth. The SQLite FTS5 index in
 * .switchboard/index.db is a cache that is re-synced (by mtime+size) before every search,
 * which is what lets one MCP process find notes another process wrote a moment ago.
 */
export class MemoryStore {
  private db: DatabaseSync;
  readonly memDir: string;

  constructor(readonly root: string) {
    const p = homePaths(root);
    this.memDir = p.memory;
    mkdirSync(p.memory, { recursive: true });
    mkdirSync(p.state, { recursive: true });
    this.db = new DatabaseSync(p.index);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, mtime REAL, size INTEGER);
      CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(path UNINDEXED, title, tags, type, date UNINDEXED, body, tokenize='porter unicode61');
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Bring the FTS index in line with the files on disk. Returns counts for diagnostics. */
  sync(): { added: number; updated: number; removed: number } {
    const onDisk = new Map<string, { mtime: number; size: number }>();
    for (const rel of walkMd(this.memDir, this.memDir)) {
      const st = statSync(join(this.memDir, rel));
      onDisk.set(rel, { mtime: st.mtimeMs, size: st.size });
    }
    const known = new Map<string, { mtime: number; size: number }>();
    for (const r of this.db.prepare("SELECT path, mtime, size FROM files").all() as any[]) {
      known.set(r.path, { mtime: r.mtime, size: r.size });
    }
    let added = 0, updated = 0, removed = 0;
    const del = this.db.prepare("DELETE FROM notes WHERE path = ?");
    const delF = this.db.prepare("DELETE FROM files WHERE path = ?");
    const ins = this.db.prepare("INSERT INTO notes(path,title,tags,type,date,body) VALUES (?,?,?,?,?,?)");
    const upF = this.db.prepare("INSERT OR REPLACE INTO files(path,mtime,size) VALUES (?,?,?)");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [rel, st] of onDisk) {
        const k = known.get(rel);
        if (k && k.mtime === st.mtime && k.size === st.size) continue;
        const n = toNote(rel, readFileSync(join(this.memDir, rel), "utf8"));
        del.run(rel);
        ins.run(rel, n.title, n.tags.join(" "), n.type, n.date, n.body);
        upF.run(rel, st.mtime, st.size);
        k ? updated++ : added++;
      }
      for (const rel of known.keys()) {
        if (!onDisk.has(rel)) {
          del.run(rel);
          delF.run(rel);
          removed++;
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { added, updated, removed };
  }

  write(input: { title: string; body: string; type?: string; tags?: string[]; source?: string }): { path: string } {
    const date = new Date().toISOString().slice(0, 10);
    const slug = slugify(input.title);
    let rel = `${date}-${slug}.md`;
    if (existsSync(join(this.memDir, rel))) rel = `${date}-${slug}-${randomBytes(3).toString("hex")}.md`;
    const meta: Record<string, unknown> = {
      title: input.title,
      type: input.type ?? "note",
      tags: input.tags ?? [],
      date,
    };
    if (input.source) meta.source = input.source;
    const text = `---\n${YAML.stringify(meta).trimEnd()}\n---\n\n${input.body.trimEnd()}\n`;
    writeFileSync(join(this.memDir, rel), text, { flag: "wx", mode: 0o644 });
    this.sync();
    return { path: rel };
  }

  read(rel: string): MemoryNote {
    const real = containedPath(this.memDir, rel);
    const lst = lstatSync(real);
    if (!lst.isFile()) throw new PathError("not a file");
    if (!real.endsWith(".md")) throw new PathError("only .md notes can be read");
    return toNote(relative(realpathSync(this.memDir), real), readFileSync(real, "utf8"));
  }

  search(query: string, opts: { limit?: number; type?: string; tag?: string } = {}): SearchHit[] {
    this.sync();
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    // Turn free text into a safe FTS5 query: each word becomes a quoted prefix term, OR'ed.
    const words = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 16);
    if (words.length === 0) return [];
    const fts = words.map((w) => `"${w.replace(/"/g, "")}"*`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT path, title, tags, type, date, snippet(notes, 5, '[', ']', ' … ', 16) AS snip, bm25(notes, 0, 5.0, 3.0, 1.0, 0, 1.0) AS score
         FROM notes WHERE notes MATCH ? ORDER BY score LIMIT ?`,
      )
      .all(fts, limit * 4) as any[];
    return rows
      .filter((r) => !opts.type || r.type === opts.type)
      .filter((r) => !opts.tag || String(r.tags).split(" ").includes(opts.tag))
      .slice(0, limit)
      .map((r) => ({
        path: r.path,
        title: r.title,
        type: r.type,
        tags: r.tags ? String(r.tags).split(" ") : [],
        date: r.date,
        snippet: r.snip,
        score: Number((-r.score).toFixed(3)),
      }));
  }
}
