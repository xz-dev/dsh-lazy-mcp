# dsh-lazy-mcp

Lazy-start MCP stdio proxy for DSH (works with any newline-delimited JSON-RPC MCP host).

DSH's `@deepseek-ai/dsh-mcp-client` waits for **every** configured stdio server to
connect and answer `tools/list` before the plugin activates, so a slow server
(seconds of startup) gates the TUI input box. `dsh-lazy-mcp` sits between the host
and each server: it answers `initialize` and `tools/list` instantly from a
per-server metadata cache and only spawns the real server on the first request
that actually needs it (`tools/call`, …).

Same idea as pi-mcp-adapter's default `lifecycle: lazy`: cached metadata keeps
listing working without live connections; idle servers are shut down and respawned
on demand.

## Usage

```
dsh-lazy-mcp --name <server> [--idle-timeout-min N] -- <command> [args...]
```

DSH `cordis.patch.yml` MCP row example:

```yaml
- id: mcp-serena
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: serena
    transport: stdio
    command: !!js "process.env.HOME + '/Code/ai/dsh-ports/dsh-lazy-mcp/bin/dsh-lazy-mcp.js'"
    args: ['--name', 'serena', '--', 'serena', 'start-mcp-server', '--context=codex', '--project-from-cwd', '--enable-web-dashboard=false', '--open-web-dashboard=false']
```

## Behaviour

- `initialize`, `tools/list`, `prompts/list`, `resources/list`,
  `resources/templates/list` are served from
  `~/.local/share/dsh/state/lazy-mcp/<name>.json` without spawning the server.
- Cold cache (first run ever): the server is spawned synchronously once and the
  cache is populated; later launches are fast.
- First non-cacheable request spawns the server, performs the MCP initialize
  handshake (reusing the host's protocol version), then forwards requests,
  responses, notifications and cancellations transparently (ids untouched).
- While the live server is up, list requests go to it (authoritative). If the
  live tool list differs from the cached one, the cache is refreshed and
  `notifications/tools/list_changed` is emitted to the host.
- Idle timeout (default 10 min, `0` disables) kills the server; it respawns on
  the next request.
- Server stderr is appended to `~/.local/share/dsh/state/mcp-logs/<name>.log`
  (replaces wrappers like `mcp-quiet`).
- stdin EOF, SIGTERM or SIGINT kills the whole process group; no orphans.
- Logs contain method names and timings only, never request payloads.

State/log dirs can be overridden with `DSH_LAZY_MCP_STATE_DIR` / `DSH_LAZY_MCP_LOG_DIR`.

## Tests

```
npm test
```

Seven end-to-end tests against `fixtures/fake-server.js`: cold cache fill, warm
start without spawn, lazy spawn + forwarding, `list_changed` on drift, idle
kill/respawn, orphan cleanup, and slow-upstream warm start.

## Licence

MIT, Copyright (c) 2026 Xiangzhe.
