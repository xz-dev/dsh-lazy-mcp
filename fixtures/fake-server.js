#!/usr/bin/env node
// Fake MCP stdio server for tests. Behaviour driven by env:
//   FAKE_TOOLS      comma-separated tool names (default "alpha,beta")
//   FAKE_DELAY_MS   delay before answering initialize (default 0)
//   FAKE_STARTUP_MS sleep before reading stdin (default 0)
//   FAKE_DRIFT      after N forwarded tool calls, swap tool list (tests list_changed refresh)
// Logs lifecycle to stderr (proxy redirects it).
import { createInterface } from "node:readline";

const tools = (process.env.FAKE_TOOLS || "alpha,beta").split(",").map((n) => ({
  name: n, description: `fake tool ${n}`, inputSchema: { type: "object", properties: {} },
}));
const delay = Number(process.env.FAKE_DELAY_MS || 0);
const startup = Number(process.env.FAKE_STARTUP_MS || 0);
const calls = { n: 0 };

if (startup) await new Promise((r) => setTimeout(r, startup));
console.error(`fake-server pid=${process.pid} up`);

const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification
  const reply = (result) => out({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      setTimeout(() => reply({
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fake", version: "1.0.0" },
        instructions: "fake server",
      }), delay);
      break;
    case "tools/list": reply({ tools }); break;
    case "prompts/list": reply({ prompts: [] }); break;
    case "resources/list": reply({ resources: [] }); break;
    case "tools/call":
      calls.n++;
      console.error(`fake call #${calls.n} ${msg.params?.name}`);
      reply({ content: [{ type: "text", text: `ok:${msg.params?.name}` }] });
      break;
    case "ping": reply({}); break;
    default: out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
  }
});
process.on("SIGTERM", () => { console.error("fake got SIGTERM"); process.exit(0); });
