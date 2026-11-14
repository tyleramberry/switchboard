#!/usr/bin/env node
// Silence only node:sqlite's ExperimentalWarning so MCP stderr stays clean.
const origEmit = process.emitWarning;
process.emitWarning = function (warning: string | Error, ...rest: any[]) {
  const msg = typeof warning === "string" ? warning : warning?.message;
  if (typeof msg === "string" && msg.includes("SQLite is an experimental feature")) return;
  return (origEmit as any).call(process, warning, ...rest);
} as typeof process.emitWarning;

const { main } = await import("./cli-main.js");
process.exitCode = await main(process.argv.slice(2));
