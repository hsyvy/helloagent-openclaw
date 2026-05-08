# @helloagentai/openclaw

OpenClaw channel plugin for HelloAgent — relay-backed messaging through OpenClaw's plugin API. Built on top of [`@helloagentai/sdk`](https://www.npmjs.com/package/@helloagentai/sdk).

```bash
npm install @helloagentai/openclaw
```

## Features

- **`security.dm`** policy adapter (allowlist / allow-all / deny-all)
- **`pairing`** adapter for pairing-code DM approval
- **`status`** snapshot + relay probe
- **Streaming inbound** — `deliver` callback writes chunks live instead of
  collecting and returning a single string at the end
- **Inbound dedup** with TTL + LRU
- **`auth.login` writes cfg directly** — after a successful pair, the plugin
  writes `channels.helloagent.enabled=true` to `openclaw.json` itself, so
  the channel shows up in `channels list` and auto-starts on next gateway
  boot regardless of whether the host's reconciler can reach the running
  gateway. (See [src/core/cfg-store.ts](src/core/cfg-store.ts) for why this
  matters when running with `--profile`, custom gateway port, or no daemon.)
- Plain `register(api)` entry shape (no `defineChannelPluginEntry` wrapper)
- Cleaned manifest (`openclaw.plugin.json` follows the Lark minimal shape)

## Layout

```
.
├── openclaw.plugin.json         minimal manifest
├── package.json                 npm packaging + openclaw.channel block
├── index.ts                     plain register(api) plugin entry
└── src/
    ├── channel/
    │   ├── plugin.ts            ChannelPlugin<HelloAgentAccount> literal
    │   ├── monitor.ts           per-account WS lifecycle (replaces session-manager)
    │   ├── event-handlers.ts    IncomingMessage → dispatch
    │   ├── config-adapter.ts    set/apply/delete account config helpers
    │   ├── probe.ts             relay reachability probe
    │   └── types.ts             MonitorContext, MonitorOpts
    ├── core/
    │   ├── accounts.ts          cfg-aware account list/resolve + credsToAccount
    │   ├── account-cache.ts     sync façade over disk creds (copied)
    │   ├── auth-store.ts        creds.json I/O (copied)
    │   ├── cfg-store.ts         atomic openclaw.json read/write
    │   ├── ha-client.ts         per-account managed Agent
    │   ├── ha-logger.ts         namespaced logger factory
    │   └── types.ts             HelloAgentAccount, ResolvedHelloAgentAccount
    ├── messaging/
    │   ├── inbound/
    │   │   ├── dedup.ts         TTL + LRU dedup
    │   │   └── dispatch.ts      streaming dispatchInboundDirectDmWithRuntime
    │   └── outbound/
    │       ├── outbound.ts      ChannelOutboundAdapter
    │       └── send.ts          low-level send via ha-client
    ├── auth/
    │   ├── login.ts             OAuth + PKCE pairing (copied)
    │   ├── login-oauth.ts       code exchange + link (copied)
    │   ├── login-device.ts      device-code flow (copied)
    │   ├── import-token.ts      manual ha_* import (copied)
    │   └── presence.ts          hasAnyHelloAgentAuth probe (copied)
    └── commands/
        ├── auth-login.ts        auth.login adapter (channels login)
        └── auth-logout.ts       gateway.logoutAccount adapter
```

## What this MVP does NOT include (deferred)

- `actions: ChannelMessageActionAdapter` — only `outbound.sendText` for now.
- Media / payloads / cards. `outbound.sendMedia` and `sendPayload` are stubs
  that throw "not implemented".
- `directory` adapter (peer/group enumeration).
- `setup` wizard adapter (no `openclaw setup` integration; pairing is via
  `openclaw channels login --channel helloagent`).
- HelloAgent-specific tools (`helloagent_send`, search-handle, etc.).
- Skills directory.
- CLI diagnostics (`helloagent doctor`, `helloagent diagnose`).
- Reactions, typing indicator, edit/delete.

These are the next wave once the MVP compiles and pairs cleanly.

## Local development

```sh
npm install
npm run typecheck
npm run build
npm run test:smoke
```

## License

MIT
