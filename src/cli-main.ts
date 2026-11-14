import { readFileSync } from "node:fs";
import { resolveHome, initHome, homePaths } from "./home.js";
import { loadManifest } from "./manifest.js";
import { createStore } from "./secrets/index.js";
import { serveStdio, Switchboard, VERSION } from "./server.js";
import { HARNESSES, runSetup } from "./installers/index.js";

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
  switchboard search <query>               memory_search from the terminal
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return v;
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
