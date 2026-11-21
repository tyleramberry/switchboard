import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolveHome, initHome, homePaths } from "./home.js";
import { loadManifest, writeManifestPin } from "./manifest.js";
import { runDoctor, formatFindings, DoctorFinding } from "./doctor.js";
import { createStore } from "./secrets/index.js";
import { serveStdio, Switchboard, VERSION } from "./server.js";
import { HARNESSES, runSetup } from "./installers/index.js";
import { InboxCard, InboxView } from "./inbox.js";

const USAGE = `switchboard ${VERSION}

Usage:
  switchboard init                         create Home at $SWITCHBOARD_HOME (default ~/agent-home)
  switchboard mcp                          run the MCP server on stdio
  switchboard setup <harness> [options]    wire a harness to Home
      harnesses: ${Object.keys(HARNESSES).join(", ")}
      --dry-run              print the diff, change nothing
      --config-dir <dir>     target config dir (default: the harness's own, e.g. ~/.hermes)
  switchboard secret list                  names, purposes, present?  (never values)
  switchboard secret set <NAME>            store a value read from stdin into the Keychain
  switchboard secret delete <NAME>
  switchboard pin                          pin the secrets manifest (sha256); tampering then fails closed
  switchboard doctor                       lint the secrets manifest (over-broad allowlists, interpreters, pin state)
  switchboard search <query>               memory_search from the terminal
  switchboard ui [--port N] [--no-open]    local web UI on 127.0.0.1 (default port 7337)
  switchboard inbox <command> [--json]     agent decision inbox (CLI only, no MCP tools)
      submit --title T --summary S --option A --option B [--option ...] --harness H
             [--agent A] [--project P] [--priority p0|p1|p2|p3] [--blocks N]
             [--artifact /abs/shot.png:caption]
      list [--view open|snoozed|resolved] [--harness H]
      status <id>
      decide <id> --decision 1|"free text" [--feedback F] [--save-rule]
      snooze <id> --until 2h|tomorrow|ISO
      poll [--harness H] [--agent A] [--ack]
      distill-export [--mark-distilled]
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}

function multi(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let v = flag(args, name); v !== undefined; v = flag(args, name)) out.push(v);
  return out;
}

/** `/abs/shot.png:caption` (caption optional; the path ends at the image extension). */
function artifactArg(s: string): { path: string; caption: string } {
  const m = /^(.+?\.(?:png|jpe?g|gif|webp))(?::([\s\S]*))?$/i.exec(s);
  return m ? { path: m[1], caption: (m[2] ?? "").replace(/^"|"$/g, "") } : { path: s, caption: "" };
}

function cardLine(c: InboxCard): string {
  const when = c.status === "resolved" ? `decided ${c.decidedAt} -> ${c.decisionLabel}` : c.snoozedUntil ? `snoozed until ${c.snoozedUntil}` : `created ${c.createdAt}`;
  return `${c.id}  ${c.priority}  blocks ${c.blockingCount}  ${c.harness}${c.agent ? "/" + c.agent : ""}  ${c.title}\n    ${when}`;
}

async function inbox(root: string, args: string[]): Promise<number> {
  const sub = args.shift();
  const json = bool(args, "--json");
  const out = (data: unknown, human: string) => console.log(json ? JSON.stringify(data, null, 2) : human);
  const id = () => {
    const v = args.shift();
    if (!v || v.startsWith("--")) throw new Error(`inbox ${sub} needs a card id`);
    return v;
  };
  const sb = new Switchboard({ root });
  try {
    switch (sub) {
      case "submit": {
        const blocks = flag(args, "--blocks");
        const c = await sb.inboxSubmit({
          title: flag(args, "--title") ?? "",
          summary: flag(args, "--summary") ?? "",
          options: multi(args, "--option"),
          harness: flag(args, "--harness") ?? "",
          agent: flag(args, "--agent"),
          project: flag(args, "--project"),
          priority: flag(args, "--priority"),
          blockingCount: blocks === undefined ? undefined : Number(blocks),
          artifacts: multi(args, "--artifact").map(artifactArg),
        });
        out({ id: c.id, status: c.status }, `${c.id} open`);
        return 0;
      }
      case "list": {
        const view = (flag(args, "--view") ?? "open") as InboxView;
        const harness = flag(args, "--harness");
        const pruned = sb.inbox.prune(30);
        const cards = sb.inbox.list(view, { harness });
        out({ view, pruned: pruned.removed, cards }, cards.length ? cards.map(cardLine).join("\n") : `no ${view} cards`);
        return 0;
      }
      case "status": {
        const c = sb.inbox.get(id());
        out(c, `${cardLine(c)}${c.feedback ? `\n    feedback: ${c.feedback}` : ""}`);
        return 0;
      }
      case "decide": {
        const cardId = id();
        const decision = flag(args, "--decision");
        if (!decision) throw new Error("inbox decide needs --decision");
        const r = await sb.inboxDecide(cardId, { decision, feedback: flag(args, "--feedback"), saveRule: bool(args, "--save-rule"), source: "switchboard-cli" });
        out(r, `${r.card.id} resolved -> ${r.card.decisionLabel}${r.rule ? `\n    rule saved: memory/${r.rule.path}` : ""}`);
        return 0;
      }
      case "snooze": {
        const cardId = id();
        const until = flag(args, "--until");
        if (!until) throw new Error("inbox snooze needs --until");
        const c = sb.inbox.snooze(cardId, until);
        out(c, `${c.id} snoozed until ${c.snoozedUntil}`);
        return 0;
      }
      case "poll": {
        const cards = sb.inbox.poll({ harness: flag(args, "--harness"), agent: flag(args, "--agent"), ack: bool(args, "--ack") });
        out({ cards }, cards.length ? cards.map(cardLine).join("\n") : "no new decisions");
        return 0;
      }
      case "distill-export": {
        const cards = sb.inbox.distillExport({ markDistilled: bool(args, "--mark-distilled") });
        out({ cards }, cards.length ? cards.map(cardLine).join("\n") : "nothing to distill");
        return 0;
      }
      default:
        console.error(`unknown inbox command: ${sub ?? ""}\n\n${USAGE}`);
        return 2;
    }
  } finally {
    sb.close();
  }
}

function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const cmd = args.shift();
  const root = resolveHome();
  try {
    switch (cmd) {
      case "init": {
        const r = initHome(root);
        console.log(`Home: ${r.root}`);
        for (const c of r.created) console.log(`  created  ${c}`);
        for (const e of r.existing) console.log(`  exists   ${e}`);
        return 0;
      }
      case "mcp":
      case "serve":
        initHome(root);
        await serveStdio(root);
        return 0;
      case "setup": {
        const dryRun = bool(args, "--dry-run");
        const configDir = flag(args, "--config-dir");
        const harness = args.shift();
        if (!harness) throw new Error("setup needs a harness name");
        return await runSetup(harness, { root, configDir, dryRun, log: (s) => console.log(s) });
      }
      case "doctor": {
        const p = homePaths(root).manifest;
        const findings: DoctorFinding[] = runDoctor(p);
        console.log(`switchboard doctor — ${p}`);
        const lines = formatFindings(findings);
        if (lines.length) console.log(lines.join("\n").trimStart());
        else console.log("no findings");
        const errors = findings.filter((f) => f.severity === "error").length;
        const warnings = findings.filter((f) => f.severity === "warning").length;
        console.log(`\n${errors} error(s), ${warnings} warning(s), ${findings.length} finding(s)`);
        return errors ? 1 : 0;
      }
      case "pin": {
        const p = homePaths(root).manifest;
        if (!existsSync(p)) throw new Error(`no manifest at ${p}; run \`switchboard init\` first`);
        const digest = writeManifestPin(p);
        console.log(`pinned ${p}\nsha256 ${digest}\n(manifest tampering now fails closed; re-run \`switchboard pin\` after an intentional edit)`);
        return 0;
      }
      case "secret": {
        const sub = args.shift();
        const m = loadManifest(homePaths(root).manifest);
        if (sub === "list") {
          const sb = new Switchboard({ root });
          console.log(JSON.stringify(await sb.secretList(), null, 2));
          sb.close();
          return 0;
        }
        const name = args.shift();
        const spec = m.secrets.find((s) => s.name === name);
        if (!spec) throw new Error(`unknown secret ${name}; add it to ${homePaths(root).manifest} first`);
        const store = createStore(spec.store);
        const ref = { name: spec.name, service: spec.service, account: spec.account };
        if (sub === "set") {
          if (process.stdin.isTTY) process.stderr.write(`value for ${spec.name} (then Ctrl-D): `);
          const value = readFileSync(0, "utf8").replace(/\r?\n$/, "");
          if (value.length < 4) throw new Error("value too short (min 4 chars)");
          await store.set(ref, value);
          console.log(`stored ${spec.name} in ${store.kind}`);
          return 0;
        }
        if (sub === "delete") {
          console.log((await store.delete(ref)) ? `deleted ${spec.name}` : `${spec.name} not found`);
          return 0;
        }
        throw new Error("secret: use list | set <NAME> | delete <NAME>");
      }
      case "ui": {
        const noOpen = bool(args, "--no-open");
        const portArg = flag(args, "--port");
        const port = portArg === undefined ? 7337 : Number(portArg);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer 0-65535");
        if (!existsSync(homePaths(root).agents)) throw new Error(`Home not initialised at ${root}; run \`switchboard init\` first`);
        const { startUi } = await import("./ui/server.js");
        const ui = await startUi({ root, port });
        console.log(`Switchboard UI for ${root}`);
        console.log(`  ${ui.url}`);
        console.log("Bound to 127.0.0.1 only. The token in the URL is per launch. Ctrl-C to stop.");
        if (!noOpen) spawn("/usr/bin/open", [ui.url], { stdio: "ignore", detached: true }).unref();
        return await new Promise<number>((done) => {
          const stop = () => ui.close().then(() => done(0));
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
      }
      case "inbox":
        return await inbox(root, args);
      case "search": {
        const sb = new Switchboard({ root });
        console.log(JSON.stringify(sb.memory.search(args.join(" ")), null, 2));
        sb.close();
        return 0;
      }
      case undefined:
      case "-h":
      case "--help":
      case "help":
        console.log(USAGE);
        return 0;
      case "--version":
        console.log(VERSION);
        return 0;
      default:
        console.error(`unknown command: ${cmd}\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    console.error(`switchboard: ${(e as Error).message}`);
    return 1;
  }
}
