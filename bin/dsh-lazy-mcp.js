#!/usr/bin/env node
// dsh-lazy-mcp — lazy-start MCP stdio proxy (newline-delimited JSON-RPC).
//
// Usage: dsh-lazy-mcp --name <server> [--idle-timeout-min N] -- <command> [args...]
//
// Behaviour (pi-mcp-adapter `lifecycle: lazy` semantics):
// - initialize / tools/list / prompts/list / resources/list are answered from a
//   per-server metadata cache without spawning the real server.
// - Cold cache: spawn the server synchronously once and populate the cache.
// - First request that needs the live server spawns it, performs the initialize
//   handshake, then forwards everything transparently (ids untouched).
// - Live tools/list refreshes the cache; drift emits notifications/tools/list_changed.
// - Idle timeout (default 10 min, 0 disables) kills the child; respawn on next call.
// - Child stderr goes to ~/.local/share/dsh/state/mcp-logs/<name>.log.
// - stdin EOF / SIGTERM / SIGINT kills the whole process group; no orphans.
// - Logs only method names and timings, never payloads.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- args ----------
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) {
  console.error("usage: dsh-lazy-mcp --name <server> [--idle-timeout-min N] -- <command> [args...]");
  process.exit(2);
}
let name = null;
let idleMin = 10;
for (let i = 0; i < sep; i++) {
  if (argv[i] === "--name") name = argv[++i];
  else if (argv[i] === "--idle-timeout-min") idleMin = Number(argv[++i]);
}
if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
  console.error("dsh-lazy-mcp: --name is required (letters, digits, . _ -)");
  process.exit(2);
}
const [cmd, ...cmdArgs] = argv.slice(sep + 1);

// ---------- paths / logging ----------
const stateDir = process.env.DSH_LAZY_MCP_STATE_DIR || join(homedir(), ".local/share/dsh/state/lazy-mcp");
const logDir = process.env.DSH_LAZY_MCP_LOG_DIR || join(homedir(), ".local/share/dsh/state/mcp-logs");
mkdirSync(stateDir, { recursive: true });
mkdirSync(logDir, { recursive: true });
const cachePath = join(stateDir, `${name}.json`);
const log = createWriteStream(join(logDir, `${name}.log`), { flags: "a" });
const say = (msg) => log.write(`[${new Date().toISOString()}] ${msg}\n`);

// ---------- cache ----------
const CACHEABLE = ["initialize", "tools/list", "prompts/list", "resources/list", "resources/templates/list"];
function loadCache() {
  try {
    const c = JSON.parse(readFileSync(cachePath, "utf8"));
    if (c && c.responses && c.responses.initialize) return c;
  } catch {}
  return null;
}
let cache = loadCache();
function saveCache() {
  const tmp = cachePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(cache, null, 1));
  renameSync(tmp, cachePath);
}

// ---------- downstream (host) stdio ----------
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const rl = createInterface({ input: process.stdin, terminal: false });

// ---------- upstream (real server) ----------
let child = null;
let childReady = false;
let handshake = null; // Promise for spawn+initialize in flight
const pending = new Map(); // id -> original downstream msg (requests awaiting upstream reply)
let idleTimer = null;
let spawnCount = 0;
const t0 = Date.now();

function armIdle() {
  if (!(idleMin > 0)) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0 && child) {
      say(`idle ${idleMin}min -> kill child pid=${child.pid}`);
      killChild();
    }
  }, idleMin * 60 * 1000);
  idleTimer.unref?.();
}

function killChild() {
  clearTimeout(idleTimer);
  const c = child;
  child = null;
  childReady = false;
  if (!c) return;
  try { process.kill(-c.pid, "SIGTERM"); } catch { try { c.kill("SIGTERM"); } catch {} }
  setTimeout(() => { try { process.kill(-c.pid, "SIGKILL"); } catch {} }, 3000).unref();
}

function spawnChild() {
  spawnCount++;
  const c = spawn(cmd, cmdArgs, { stdio: ["pipe", "pipe", "pipe"], detached: true });
  child = c;
  childReady = false;
  say(`spawn #${spawnCount} pid=${c.pid} cmd=${cmd}`);
  c.stderr.on("data", (d) => log.write(d)); // child stderr -> per-server log
  const crl = createInterface({ input: c.stdout, terminal: false });
  crl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { say(`unparsable child stdout line dropped (${line.length}b)`); return; }
    onUpstreamMessage(msg);
  });
  c.on("exit", (code, sig) => {
    say(`child exit code=${code} sig=${sig} pending=${pending.size}`);
    const err = { jsonrpc: "2.0", error: { code: -32000, message: `MCP server '${name}' exited (code=${code} sig=${sig})` } };
    for (const [id, orig] of pending) out({ ...err, id: orig.id ?? id });
    pending.clear();
    if (c === child) { child = null; childReady = false; }
  });
  c.on("error", (e) => say(`child error: ${e.message}`));
  return c;
}

function sendUpstream(msg) {
  armIdle();
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function ensureServer() {
  if (child && childReady) return Promise.resolve();
  if (handshake) return handshake;
  handshake = (async () => {
    if (!child) spawnChild();
    // own initialize handshake; id 0 is ours, never forwarded
    const initReq = { jsonrpc: "2.0", id: 0, method: "initialize", params: cache?.clientParams || {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "dsh-lazy-mcp", version: "0.1.0" },
    } };
    const result = await new Promise((resolve, reject) => {
      pending.set(0, { id: 0, method: "initialize", _handshake: { resolve, reject } });
      sendUpstream(initReq);
    });
    sendUpstream({ jsonrpc: "2.0", method: "notifications/initialized" });
    childReady = true;
    say(`handshake done in ${Date.now() - t0}ms`);
    return result;
  })().finally(() => { handshake = null; });
  return handshake;
}

function refreshCacheFromLive(method, result) {
  if (!CACHEABLE.includes(method) || !result) return;
  cache = cache || { responses: {}, clientParams: cache?.clientParams };
  cache.responses = cache.responses || {};
  const prev = method === "tools/list" ? cache.responses["tools/list"] : null;
  cache.responses[method] = result;
  saveCache();
  if (method === "tools/list") {
    const a = JSON.stringify(prev?.tools?.map((t) => t.name) ?? []);
    const b = JSON.stringify(result.tools?.map((t) => t.name) ?? []);
    if (prev && a !== b) out({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }
}

function onUpstreamMessage(msg) {
  const isResponse = msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined);
  if (isResponse && pending.has(msg.id)) {
    const orig = pending.get(msg.id);
    pending.delete(msg.id);
    if (orig._handshake) {
      msg.error ? orig._handshake.reject(new Error(msg.error.message)) : orig._handshake.resolve(msg.result);
      return;
    }
    if (msg.result !== undefined) refreshCacheFromLive(orig.method, msg.result);
    out(msg);
    armIdle();
    return;
  }
  // server-initiated request or notification -> forward downstream untouched
  out(msg);
}

// ---------- downstream request handling ----------
async function onDownstreamLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { say("unparsable host line dropped"); return; }
  const isRequest = msg.method !== undefined && msg.id !== undefined;

  if (isRequest && msg.method === "initialize") {
    cache = cache || { responses: {} };
    cache.clientParams = msg.params; // remember host protocol version for later handshakes
    if (cache.responses.initialize) {
      say(`initialize <- cache (${Date.now() - t0}ms)`);
      out({ jsonrpc: "2.0", id: msg.id, result: cache.responses.initialize });
      saveCache();
      return;
    }
  }
  // Cache answers only while the live server is down; once it is up, lists go to it
  // (authoritative) so refreshCacheFromLive can detect drift.
  if (isRequest && CACHEABLE.includes(msg.method) && cache?.responses?.[msg.method] && msg.method !== "initialize" && !childReady) {
    say(`${msg.method} <- cache`);
    out({ jsonrpc: "2.0", id: msg.id, result: cache.responses[msg.method] });
    return;
  }
  if (!isRequest && msg.method === "notifications/initialized") {
    // Host finished its handshake with us. Nothing to do unless child already up.
    if (child && childReady) sendUpstream(msg);
    return;
  }

  // needs live server (or cold-cache fill)
  const cold = !cache?.responses?.initialize;
  try {
    await ensureServer();
  } catch (e) {
    say(`ensureServer failed: ${e.message}`);
    if (isRequest) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: `lazy-mcp upstream failed: ${e.message}` } });
    return;
  }
  if (cold) say(`cold cache filled (${Date.now() - t0}ms)`);
  if (isRequest) pending.set(msg.id, msg);
  sendUpstream(msg);
}

rl.on("line", (line) => { onDownstreamLine(line).catch((e) => say(`handler error: ${e.message}`)); });

// ---------- shutdown: no orphans ----------
function shutdown(sig) {
  say(`shutdown: ${sig}`);
  killChild();
  setTimeout(() => process.exit(0), 200).unref();
}
rl.on("close", () => shutdown("stdin EOF"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

say(`proxy start name=${name} idle=${idleMin}min cache=${cache ? "hit" : "cold"}`);
armIdle();
