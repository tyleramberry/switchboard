import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** dist/src/cli.js, resolved from this compiled file's location (dist/<dir>/mcp-client.js). */
export const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

export interface Connected {
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  close: () => Promise<void>;
  pid: number | null;
}

/** Spawn `switchboard mcp` as a separate process and connect an MCP client to it over stdio. */
export async function connect(env: Record<string, string>, clientName = "switchboard-test"): Promise<Connected> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: clientName, version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    pid: transport.pid,
    call: async (name, args = {}) => {
      const r: any = await client.callTool({ name, arguments: args });
      return { text: r.content?.map((c: any) => c.text).join("\n") ?? "", isError: !!r.isError };
    },
    close: () => client.close(),
  };
}
