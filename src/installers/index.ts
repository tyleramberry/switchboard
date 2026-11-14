import { existsSync } from "node:fs";
import { Plan, SetupOptions, applyPlan } from "./common.js";
import { planHermes } from "./hermes.js";
import { planClaude } from "./claude.js";
import { planCodex } from "./codex.js";
import { planGrokbot } from "./grokbot.js";
import { planBuzz } from "./buzz.js";
import { homePaths } from "../home.js";

export const HARNESSES: Record<string, (o: SetupOptions) => Plan> = {
  hermes: planHermes,
  "claude-code": planClaude,
  grokbot: planGrokbot,
  buzz: planBuzz,
  codex: planCodex,
};

export async function runSetup(harness: string, opts: SetupOptions): Promise<number> {
  const plan = HARNESSES[harness];
  if (!plan) throw new Error(`unknown harness: ${harness} (known: ${Object.keys(HARNESSES).join(", ")})`);
  if (!existsSync(homePaths(opts.root).agents)) {
    throw new Error(`Home not initialised at ${opts.root}; run \`switchboard init\` first`);
  }
  return applyPlan(plan(opts), opts);
}

export { planHermes, planClaude, planCodex, planGrokbot, planBuzz };
