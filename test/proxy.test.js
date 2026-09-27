// node --test: dsh-lazy-mcp end-to-end against fixtures/fake-server.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const proxyBin = join(root, "bin/dsh-lazy-mcp.js");
const fake = join(root, "fixtures/fake-server.js");

let stateDir, logDir;
before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "lazymcp-state-"));
  logDir = mkdtempSync(join(tmpdir(), "lazymcp-logs-"));
});
after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(logDir, { recursive: true, force: true }); });

// Start a proxy; returns a tiny client with request()/notify()/close() and child introspection.
function startProxy({ name = "t", idleMin = 0, env = {}, fakeEnv = "" } = {}) {
  const p = spawn(process.execPath, [proxyBin, "--name", name, "--idle-timeout-min", String(idleMin), "--",
    process.execPath, fake], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DSH_LAZY_MCP_STATE_DIR: stateDir, DSH_LAZY_MCP_LOG_DIR: logDir, ...env },
  });
  p.stderr.on("data", () => {}); // proxy's own stderr (should be empty)
  const rl = createInterface({ input: p.stdout, terminal: false });
  const pending = new Map();
  const notes = [];
  let nextId = 1;
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else notes.push(msg);
  });
  const request = (method, params, id = nextId++) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  const close = () => { p.stdin.end(); return new Promise((r) => p.on("exit", r)); };
  return { p, request, notify, close, notes };
}

const initParams = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };

test("cold cache: initialize spawns server synchronously and fills cache", async () => {
  const c = startProxy({ name: "cold" });
  const res = await c.request("initialize", initParams);
  assert.equal(res.result.serverInfo.name, "fake");
  c.notify("notifications/initialized");
  const tools = await c.request("tools/list"); // live on cold start, fills the list cache
  assert.deepEqual(tools.result.tools.map((t) => t.name), ["alpha", "beta"]);
  assert.ok(existsSync(join(stateDir, "cold.json")), "cache file written");
  const cached = JSON.parse(readFileSync(join(stateDir, "cold.json"), "utf8"));
  assert.equal(cached.responses.initialize.serverInfo.name, "fake");
  assert.ok(cached.responses["tools/list"], "tools/list cached");
  await c.close();
});

test("warm cache: initialize + tools/list answered without spawning child", async (t) => {
  const logFile = join(logDir, "cold.log");
  const beforeLen = existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0;
  const c = startProxy({ name: "cold" }); // same name -> cache hit
  t.after(() => { try { c.p.kill("SIGKILL"); } catch {} });
  const t0 = Date.now();
  const res = await c.request("initialize", initParams);
  assert.ok(Date.now() - t0 < 500, "cached initialize is fast");
  assert.equal(res.result.serverInfo.name, "fake");
  c.notify("notifications/initialized");
  const tools = await c.request("tools/list");
  assert.deepEqual(tools.result.tools.map((t) => t.name), ["alpha", "beta"]);
  await new Promise((r) => setTimeout(r, 300));
  const fresh = readFileSync(logFile, "utf8").slice(beforeLen);
  assert.ok(!fresh.includes("spawn"), "no spawn after warm start:\n" + fresh);
  await c.close();
});

test("lazy spawn on first tools/call, forwarding and respawn after idle kill", async () => {
  const c = startProxy({ name: "cold" });
  await c.request("initialize", initParams);
  c.notify("notifications/initialized");
  await c.request("tools/list");
  const r1 = await c.request("tools/call", { name: "alpha", arguments: {} });
  assert.equal(r1.result.content[0].text, "ok:alpha");
  const r2 = await c.request("tools/call", { name: "beta", arguments: {} });
  assert.equal(r2.result.content[0].text, "ok:beta");
  await c.close();
});

test("live tools/list drift emits notifications/tools/list_changed", async (t) => {
  // Pre-seed cache with a stale tool list.
  const stale = { responses: { initialize: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1.0.0" } },
    "tools/list": { tools: [{ name: "old", description: "stale", inputSchema: { type: "object" } }] } } };
  writeFileSync(join(stateDir, "drift.json"), JSON.stringify(stale));
  const c = startProxy({ name: "drift", env: { FAKE_TOOLS: "new1,new2" } });
  t.after(() => { try { c.p.kill("SIGKILL"); } catch {} });
  const got = await c.request("tools/list");
  assert.equal(got.result.tools[0].name, "old", "cache served first");
  // First live call triggers spawn; proxy forwards live tools/list through cache refresh on any live list.
  await c.request("tools/call", { name: "x", arguments: {} });
  // ask live list explicitly; refresh + drift notification expected
  await c.request("tools/list");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(c.notes.some((n) => n.method === "notifications/tools/list_changed"), "list_changed emitted");
  const cacheNow = JSON.parse(readFileSync(join(stateDir, "drift.json"), "utf8"));
  assert.equal(cacheNow.responses["tools/list"].tools[0].name, "new1", "cache refreshed");
  await c.close();
});

test("idle timeout kills child; next call respawns", async () => {
  const c = startProxy({ name: "idle", idleMin: 0.02 }); // ~1.2s
  await c.request("initialize", initParams);
  c.notify("notifications/initialized");
  await c.request("tools/call", { name: "alpha", arguments: {} });
  await new Promise((r) => setTimeout(r, 2500)); // idle fires
  const logText = readFileSync(join(logDir, "idle.log"), "utf8");
  assert.ok(/idle .* kill child/.test(logText), "idle kill logged");
  const r2 = await c.request("tools/call", { name: "beta", arguments: {} });
  assert.equal(r2.result.content[0].text, "ok:beta", "respawned and answered");
  const log2 = readFileSync(join(logDir, "idle.log"), "utf8");
  assert.ok((log2.match(/spawn #/g) || []).length >= 2, "second spawn happened");
  await c.close();
});

test("stdin EOF kills child and proxy exits; no orphan survives", async () => {
  const c = startProxy({ name: "orphan" });
  await c.request("initialize", initParams);
  c.notify("notifications/initialized");
  await c.request("tools/call", { name: "alpha", arguments: {} });
  const logText = () => readFileSync(join(logDir, "orphan.log"), "utf8");
  const m = logText().match(/spawn #1 pid=(\d+)/);
  assert.ok(m, "child spawned");
  const childPid = Number(m[1]);
  assert.doesNotThrow(() => process.kill(childPid, 0), "child alive before EOF");
  await c.close(); // stdin EOF
  await new Promise((r) => setTimeout(r, 800));
  assert.throws(() => process.kill(childPid, 0), /ESRCH/, "child reaped after proxy exit");
});

test("slow upstream does not block warm startup (cached lists while server boots)", async () => {
  writeFileSync(join(stateDir, "slow.json"), JSON.stringify({ responses: {
    initialize: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1.0.0" } },
    "tools/list": { tools: [{ name: "cached", description: "", inputSchema: { type: "object" } }] } } }));
  const c = startProxy({ name: "slow", env: { FAKE_STARTUP_MS: "4000" } });
  const t0 = Date.now();
  const res = await c.request("initialize", initParams);
  const tools = await c.request("tools/list");
  assert.ok(Date.now() - t0 < 1000, "warm start not gated by 4s upstream boot");
  assert.equal(tools.result.tools[0].name, "cached");
  // And a real call waits for the server and still succeeds.
  const r = await c.request("tools/call", { name: "cached", arguments: {} });
  assert.equal(r.result.content[0].text, "ok:cached");
  await c.close();
}, { timeout: 20000 });
