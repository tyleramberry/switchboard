/**
 * Nightly inbox distillation.
 *
 * Reads resolved inbox cards that have not been distilled yet, drops the ones that teach
 * nothing new (already saved as a rule, or the recommended default accepted with no
 * feedback), and prints a compact bundle of feedback and overrides for a model or a human
 * to turn into durable `preference` notes in Home/memory/. No model is called here, so an
 * idle day costs $0: with nothing to distill the script prints `idle` and exits 0.
 *
 * It also checks each extracted decision against existing inbox rules in memory/. When a
 * new decision picks something different from a saved rule for the same question, it opens
 * a conflict card back into inbox.db so Tyler settles it once.
 *
 * Usage: npm run distill [-- --json] [-- --dry-run]
 *   --json     machine-readable bundle on stdout
 *   --dry-run  peek only: do not mark cards distilled and do not open conflict cards
 */
import { fileURLToPath } from "node:url";
import type { Switchboard } from "../src/server.js";
import type { InboxCard } from "../src/inbox.js";

export interface DistillItem {
  id: string;
  kind: "feedback" | "override";
  question: string;
  context: string;
  chosen: string;
  notChosen: string[];
  feedback: string | null;
  harness: string;
  agent: string;
  project: string;
  decidedAt: string | null;
}

export interface DistillConflict {
  cardId: string;
  notePath: string;
  question: string;
  memoryChoice: string;
  newChoice: string;
  conflictCardId: string;
}

export interface DistillBundle {
  status: "idle" | "ready";
  generatedAt: string;
  exported: number;
  items: DistillItem[];
  skipped: { id: string; reason: "saved_as_rule" | "accepted_default" | "conflict_card" }[];
  conflicts: DistillConflict[];
  errors: string[];
  instructions: string;
}

export const DISTILL_INSTRUCTIONS =
  "Each item is a resolved inbox decision where Tyler overrode the recommended option or gave feedback. " +
  "Write a memory note (type preference, tags inbox-distilled plus the project) only for patterns that are " +
  "likely to repeat; skip one-off choices. Merge with an existing note instead of duplicating it. " +
  "Never copy secret values into memory.";

const DISTILL_AGENT = "distill";

function norm(s: string): string {
  return s.toLowerCase().replace(/\(recommended\)/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function words(s: string): Set<string> {
  return new Set(norm(s).split(" ").filter((w) => w.length > 2));
}

/** Same question if the normalised titles match or share most of their words. */
function sameQuestion(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true;
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  return both / (wa.size + wb.size - both) >= 0.75;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3).trimEnd() + "...";
}

function toItem(c: InboxCard): DistillItem {
  const chosen = c.decisionLabel ?? c.decision ?? "";
  const override = c.decision !== "1";
  return {
    id: c.id,
    kind: override ? "override" : "feedback",
    question: c.title,
    context: c.summary,
    chosen,
    notChosen: c.options.filter((o) => o.key !== c.decision).map((o) => o.label),
    feedback: c.feedback,
    harness: c.harness,
    agent: c.agent,
    project: c.project,
    decidedAt: c.decidedAt,
  };
}

/** `- Question: X` / `- Chosen: Y` lines from a rule note written by ruleNote(). */
function parseRule(body: string): { question: string; chosen: string } | null {
  const q = /^- Question: (.+)$/m.exec(body);
  const c = /^- Chosen: (.+)$/m.exec(body);
  return q && c ? { question: q[1].trim(), chosen: c[1].trim() } : null;
}

async function findConflict(sb: Switchboard, item: DistillItem) {
  for (const hit of sb.memory.search(item.question, { limit: 10, type: "preference" })) {
    let body: string;
    try {
      body = sb.memory.read(hit.path).body;
    } catch {
      continue;
    }
    const rule = parseRule(body);
    if (!rule || !sameQuestion(rule.question, item.question)) continue;
    if (norm(rule.chosen) === norm(item.chosen)) continue;
    return { notePath: hit.path, memoryChoice: rule.chosen };
  }
  return null;
}

export async function distillInbox(sb: Switchboard, opts: { dryRun?: boolean } = {}): Promise<DistillBundle> {
  const cards = sb.inbox.distillExport({ markDistilled: !opts.dryRun });
  const bundle: DistillBundle = {
    status: cards.length ? "ready" : "idle",
    generatedAt: new Date().toISOString(),
    exported: cards.length,
    items: [],
    skipped: [],
    conflicts: [],
    errors: [],
    instructions: DISTILL_INSTRUCTIONS,
  };
  for (const c of cards) {
    if (c.savedAsRule) bundle.skipped.push({ id: c.id, reason: "saved_as_rule" });
    else if (c.agent === DISTILL_AGENT && c.harness === "switchboard") bundle.skipped.push({ id: c.id, reason: "conflict_card" });
    else if (c.decision === "1" && !c.feedback) bundle.skipped.push({ id: c.id, reason: "accepted_default" });
    else bundle.items.push(toItem(c));
  }
  if (opts.dryRun) return bundle;
  for (const item of bundle.items) {
    const hit = await findConflict(sb, item);
    if (!hit) continue;
    try {
      const card = await sb.inboxSubmit({
        title: clip(`Conflict: ${item.question}`, 100),
        summary: clip(
          `A new decision disagrees with a saved rule. Rule (${hit.notePath}) says: ${clip(hit.memoryChoice, 120)}. ` +
            `Card ${item.id} chose: ${clip(item.chosen, 120)}.` +
            (item.feedback ? ` Feedback: ${clip(item.feedback, 150)}` : ""),
          600,
        ),
        options: ["Keep new decision (Recommended)", "Keep existing rule", "Both apply (context differs)"],
        harness: "switchboard",
        agent: DISTILL_AGENT,
        project: item.project || undefined,
        priority: "p1",
        blockingCount: 1,
      });
      bundle.conflicts.push({ cardId: item.id, notePath: hit.notePath, question: item.question, memoryChoice: hit.memoryChoice, newChoice: item.chosen, conflictCardId: card.id });
    } catch (e) {
      bundle.errors.push(`conflict card for ${item.id}: ${(e as Error).message}`);
    }
  }
  return bundle;
}

function human(b: DistillBundle): string {
  if (b.status === "idle") return "idle: no new resolved decisions to distill";
  const lines = [`${b.exported} resolved card(s): ${b.items.length} to distill, ${b.skipped.length} skipped, ${b.conflicts.length} conflict(s)`];
  for (const i of b.items) lines.push(`  ${i.id} [${i.kind}] ${i.question} -> ${i.chosen}${i.feedback ? ` (feedback: ${i.feedback})` : ""}`);
  for (const k of b.conflicts) lines.push(`  conflict ${k.conflictCardId}: ${k.question} (rule ${k.notePath}: ${k.memoryChoice}; new: ${k.newChoice})`);
  for (const e of b.errors) lines.push(`  error: ${e}`);
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  // Silence only node:sqlite's ExperimentalWarning, as src/cli.ts does.
  const origEmit = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: any[]) {
    const msg = typeof warning === "string" ? warning : warning?.message;
    if (typeof msg === "string" && msg.includes("SQLite is an experimental feature")) return;
    return (origEmit as any).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  const { resolveHome } = await import("../src/home.js");
  const { Switchboard } = await import("../src/server.js");
  const sb = new Switchboard({ root: resolveHome() });
  try {
    const b = await distillInbox(sb, { dryRun: argv.includes("--dry-run") });
    console.log(argv.includes("--json") ? JSON.stringify(b, null, 2) : human(b));
    return b.errors.length ? 1 : 0;
  } catch (e) {
    console.error(`distill failed: ${(e as Error).message}`);
    return 1;
  } finally {
    sb.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
