/**
 * No-relay smoke test for the new HelloAgent channel plugin.
 *
 * Validates structurally what we just built — without opening a WebSocket,
 * without spawning openclaw, without touching the user's home directory:
 *
 *   1. Plugin shape: every adapter we wired exists at the right path with
 *      the right type (ChannelPlugin literal: id, meta, capabilities,
 *      reload, agentPrompt, pairing, security, configSchema, config, setup,
 *      messaging, threading, outbound, status, gateway, auth).
 *   2. Account list/resolve via cfg+disk merge.
 *   3. Disk creds → account-cache → plugin.config.listAccountIds / .resolveAccount.
 *   4. Cache fires "added" / "removed" events.
 *   5. config-adapter: setAccountEnabled / applyAccountConfig / deleteAccount
 *      mutate cfg correctly for both default and named accounts.
 *   6. security.collectWarnings emits the expected lines for risky configs.
 *   7. MessageDedup filters duplicates and respects TTL.
 *   8. messaging.normalizeTarget / targetResolver behavior.
 *
 * Run:
 *   cd integrations/openclaw-HelloAgent
 *   npm run test:smoke
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as accountCache from "../src/core/account-cache.js";
import {
  CREDS_VERSION,
  deleteCreds,
  writeCreds,
  type HelloAgentCreds,
} from "../src/core/auth-store.js";
import {
  mergeHelloAgentAccountConfig,
  readCfg,
  resolveCfgPath,
  writeCfg,
} from "../src/core/cfg-store.js";
import { helloAgentPlugin } from "../src/channel/plugin.js";
import {
  applyAccountConfig,
  collectHelloAgentSecurityWarnings,
  deleteAccount,
  setAccountEnabled,
} from "../src/channel/config-adapter.js";
import { MessageDedup, isMessageExpired } from "../src/messaging/inbound/dedup.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(label: string): void {
  passed += 1;
  console.log(`  ✅ ${label}`);
}

function fail(label: string, err: unknown): void {
  failed += 1;
  const msg = err instanceof Error ? err.message : String(err);
  failures.push(`${label}: ${msg}`);
  console.log(`  ❌ ${label}: ${msg}`);
}

async function step(label: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n[${label}]`);
  try {
    await fn();
  } catch (err) {
    fail(label, err);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function fakeCreds(handle: string, token = "ha_smoke_" + "0".repeat(48)): HelloAgentCreds {
  const [ownerHandle, agentName] = handle.split("/");
  return {
    version: CREDS_VERSION,
    handle,
    agentName: agentName ?? "agent",
    ownerHandle: ownerHandle ?? "owner",
    token,
    apiUrl: "https://api.helloagent.cc",
    relayWs: "wss://relay.helloagent.cc/v1/ws",
    linkedAt: new Date().toISOString(),
    source: "manual",
  };
}

// ---------------------------------------------------------------------------
// 1. Plugin shape
// ---------------------------------------------------------------------------

async function testPluginShape(): Promise<void> {
  const p = helloAgentPlugin;

  assertEq(p.id, "helloagent", "plugin id");
  ok("plugin.id === 'helloagent'");

  assert(p.meta?.label === "HelloAgent", "meta.label missing");
  assert(typeof p.meta?.blurb === "string", "meta.blurb missing");
  ok("meta.label / .blurb present");

  assert(p.capabilities?.chatTypes?.includes("direct"), "capabilities.chatTypes missing 'direct'");
  assertEq(p.capabilities?.media, false, "capabilities.media");
  assertEq(p.capabilities?.reactions, false, "capabilities.reactions");
  ok("capabilities declared with explicit flags");

  assert(p.reload?.configPrefixes?.includes("channels.helloagent"), "reload prefix missing");
  ok("reload.configPrefixes wired");

  assert(typeof p.agentPrompt?.messageToolHints === "function", "agentPrompt.messageToolHints missing");
  const hints = p.agentPrompt!.messageToolHints!({} as never);
  assert(Array.isArray(hints) && hints.length > 0, "messageToolHints empty");
  ok("agentPrompt.messageToolHints returns hints");

  assert(typeof p.pairing?.notifyApproval === "function", "pairing.notifyApproval missing");
  assertEq(p.pairing?.idLabel, "HelloAgent handle", "pairing.idLabel");
  ok("pairing adapter wired (idLabel + notifyApproval)");

  assert(typeof p.security?.collectWarnings === "function", "security.collectWarnings missing");
  ok("security.collectWarnings wired");

  assert(typeof p.config?.listAccountIds === "function", "config.listAccountIds missing");
  assert(typeof p.config?.resolveAccount === "function", "config.resolveAccount missing");
  assert(typeof p.config?.inspectAccount === "function", "config.inspectAccount missing");
  assert(typeof p.config?.setAccountEnabled === "function", "config.setAccountEnabled missing");
  assert(typeof p.config?.deleteAccount === "function", "config.deleteAccount missing");
  assert(typeof p.config?.resolveAllowFrom === "function", "config.resolveAllowFrom missing");
  ok("config adapter has list/resolve/inspect/enable/delete/allowFrom");

  assert(typeof p.setup?.applyAccountConfig === "function", "setup.applyAccountConfig missing");
  ok("setup.applyAccountConfig wired");

  assert(typeof p.messaging?.normalizeTarget === "function", "messaging.normalizeTarget missing");
  assert(typeof p.messaging?.targetResolver?.looksLikeId === "function", "messaging.targetResolver missing");
  ok("messaging.normalizeTarget + targetResolver wired");

  assert(typeof p.threading?.resolveReplyToMode === "function", "threading.resolveReplyToMode missing");
  ok("threading.resolveReplyToMode wired");

  assert(typeof p.outbound?.sendText === "function", "outbound.sendText missing");
  assertEq(p.outbound?.deliveryMode, "direct", "outbound.deliveryMode");
  ok("outbound.sendText wired (deliveryMode=direct)");

  assert(typeof p.status?.probeAccount === "function", "status.probeAccount missing");
  assert(typeof p.status?.buildAccountSnapshot === "function", "status.buildAccountSnapshot missing");
  ok("status.probeAccount + buildAccountSnapshot wired");

  assert(typeof p.gateway?.startAccount === "function", "gateway.startAccount missing");
  assert(typeof p.gateway?.stopAccount === "function", "gateway.stopAccount missing");
  assert(typeof p.gateway?.logoutAccount === "function", "gateway.logoutAccount missing");
  ok("gateway start/stop/logout wired");

  assert(typeof p.auth?.login === "function", "auth.login missing");
  ok("auth.login wired");
}

// ---------------------------------------------------------------------------
// 2. messaging.normalizeTarget / targetResolver
// ---------------------------------------------------------------------------

async function testMessagingHelpers(): Promise<void> {
  const norm = helloAgentPlugin.messaging!.normalizeTarget!;
  assertEq(norm("alice"), "alice", "plain handle");
  assertEq(norm("@alice"), "alice", "leading @ stripped");
  assertEq(norm("alice/jarvis"), "alice/jarvis", "user/agent");
  assertEq(norm("@alice/jarvis"), "alice/jarvis", "user/agent with leading @");
  assertEq(norm("  bob  "), "bob", "trimmed");
  assertEq(norm(""), undefined, "empty → undefined");
  ok("normalizeTarget handles plain, @, user/agent, whitespace, empty");

  const looks = helloAgentPlugin.messaging!.targetResolver!.looksLikeId;
  assert(looks("alice"), "alice should look like id");
  assert(looks("alice/jarvis"), "alice/jarvis should look like id");
  assert(looks("@alice"), "@alice should look like id");
  assert(!looks("hello world"), "spaces should not look like id");
  ok("targetResolver.looksLikeId distinguishes handles from prose");
}

// ---------------------------------------------------------------------------
// 3. Dedup
// ---------------------------------------------------------------------------

async function testDedup(): Promise<void> {
  const dedup = new MessageDedup({ ttlMs: 100, maxEntries: 3 });
  assertEq(dedup.tryRecord("m1", "a"), true, "first sight");
  assertEq(dedup.tryRecord("m1", "a"), false, "second sight (duplicate)");
  assertEq(dedup.tryRecord("m1", "b"), true, "different account → not duplicate");
  ok("tryRecord dedups on (messageId, accountId) pair");

  // TTL expiry
  await new Promise((r) => setTimeout(r, 120));
  assertEq(dedup.tryRecord("m1", "a"), true, "after TTL → fresh");
  ok("ttl expiry releases entries");

  // LRU eviction
  const lru = new MessageDedup({ ttlMs: 60_000, maxEntries: 2 });
  lru.tryRecord("m1", "a");
  lru.tryRecord("m2", "a");
  lru.tryRecord("m3", "a"); // evicts m1
  assertEq(lru.tryRecord("m1", "a"), true, "m1 should be evicted");
  ok("LRU eviction at capacity");

  // isMessageExpired
  assertEq(isMessageExpired(undefined), false, "undefined ts is not expired");
  assertEq(isMessageExpired(Date.now()), false, "fresh ts is not expired");
  assertEq(isMessageExpired(Date.now() - 11 * 60 * 1000), true, "11-min-old ts is expired");
  ok("isMessageExpired sentinels");
}

// ---------------------------------------------------------------------------
// 4. config-adapter (mutation helpers)
// ---------------------------------------------------------------------------

async function testConfigAdapter(): Promise<void> {
  // setAccountEnabled — default account
  let cfg: { channels?: Record<string, unknown> } = {};
  cfg = setAccountEnabled(cfg, "default", true);
  assertEq((cfg.channels?.helloagent as { enabled?: boolean })?.enabled, true, "default enabled");
  ok("setAccountEnabled writes to top-level for 'default'");

  // setAccountEnabled — named account
  cfg = setAccountEnabled(cfg, "work", true);
  const accounts = (cfg.channels?.helloagent as {
    accounts?: Record<string, { enabled?: boolean }>;
  }).accounts;
  assertEq(accounts?.work?.enabled, true, "work enabled");
  ok("setAccountEnabled writes to accounts.<id> for named");

  // applyAccountConfig — default
  cfg = applyAccountConfig(cfg, "default", { allowFrom: ["alice", "bob"] });
  assertEq(
    (cfg.channels?.helloagent as { allowFrom?: string[] }).allowFrom?.length,
    2,
    "allowFrom.length",
  );
  ok("applyAccountConfig merges patch for 'default'");

  // deleteAccount — named
  cfg = deleteAccount(cfg, "work");
  const accountsAfter = (cfg.channels?.helloagent as {
    accounts?: Record<string, unknown>;
  }).accounts;
  assert(!accountsAfter, "accounts map should be cleared (only entry removed)");
  ok("deleteAccount removes named account");

  // deleteAccount — default with no other accounts → channels.helloagent dropped entirely
  cfg = deleteAccount(cfg, "default");
  assert(!(cfg.channels && "helloagent" in cfg.channels), "channels.helloagent should be gone");
  ok("deleteAccount('default') removes the channels.helloagent section");
}

// ---------------------------------------------------------------------------
// 5. Security warnings
// ---------------------------------------------------------------------------

async function testSecurityWarnings(): Promise<void> {
  // dmPolicy=allow-all → warn
  const cfgPermissive = {
    channels: { helloagent: { dmPolicy: "allow-all" as const } },
  };
  const warns = collectHelloAgentSecurityWarnings({ cfg: cfgPermissive, accountId: "default" });
  assert(
    warns.some((w) => w.includes("allow-all")),
    `expected allow-all warning, got ${JSON.stringify(warns)}`,
  );
  ok("dmPolicy=allow-all triggers warning");

  // allowlist with no entries → no warning (allowlist is the safe default)
  const cfgAllowlist = {
    channels: { helloagent: { dmPolicy: "allowlist" as const, allowFrom: [] } },
  };
  const noWarns = collectHelloAgentSecurityWarnings({ cfg: cfgAllowlist, accountId: "default" });
  assert(
    !noWarns.some((w) => w.includes("allow-all")),
    "allowlist should not trigger allow-all warning",
  );
  ok("dmPolicy=allowlist (default) is silent");

  // allow-all + allowFrom configured → warns about ignored allowFrom
  const cfgConflict = {
    channels: { helloagent: { dmPolicy: "allow-all" as const, allowFrom: ["alice"] } },
  };
  const conflictWarns = collectHelloAgentSecurityWarnings({ cfg: cfgConflict, accountId: "default" });
  assert(
    conflictWarns.some((w) => w.toLowerCase().includes("ignores")),
    `expected 'ignores' warning, got ${JSON.stringify(conflictWarns)}`,
  );
  ok("allow-all with allowFrom triggers conflict warning");
}

// ---------------------------------------------------------------------------
// 6. Disk creds → cache → plugin.config wiring
// ---------------------------------------------------------------------------

async function testDiskCredsWiring(tmpDir: string): Promise<void> {
  process.env.HELLOAGENT_AUTH_DIR = tmpDir;

  // Re-init the cache against the new env var.
  accountCache.dispose();
  accountCache.init();

  const p = helloAgentPlugin.config;
  const initial = p.listAccountIds!({} as never);
  assertEq(initial.length, 0, "cache initially empty");
  ok("cache empty before any creds.json");

  // 1) Add default
  const events: Array<[string, string]> = [];
  const unsubscribe = accountCache.onChange((event, id) => events.push([event, id]));

  await writeCreds(fakeCreds("alice/jarvis", "ha_token_default"), "default");
  accountCache.refreshNow();

  const ids = p.listAccountIds!({} as never);
  assert(ids.includes("default"), `expected default in ids, got ${JSON.stringify(ids)}`);
  ok("disk creds → listAccountIds picks up 'default'");

  // resolveAccount returns the resolved shape with handle + token from disk
  const acct = p.resolveAccount!({} as never, "default");
  assertEq(acct.handle, "alice/jarvis", "handle");
  assertEq(acct.token, "ha_token_default", "token");
  ok("resolveAccount returns ResolvedHelloAgentAccount");

  // inspectAccount: paired + enabled-by-default
  const insp = p.inspectAccount!({} as never, "default") as Record<string, unknown>;
  assertEq(insp.configured, true, "inspectAccount.configured");
  assertEq(insp.enabled, true, "inspectAccount.enabled");
  assertEq(insp.state, "linked", "inspectAccount.state");
  ok("inspectAccount reports linked + enabled");

  await waitFor(() => events.some(([e, id]) => e === "added" && id === "default"), '"added" default');
  ok("cache emits 'added' for default");

  // 2) Multi-account
  events.length = 0;
  await writeCreds(fakeCreds("alice/research", "ha_token_research"), "research");
  accountCache.refreshNow();
  const idsAfter = p.listAccountIds!({} as never).sort();
  assertEq(JSON.stringify(idsAfter), JSON.stringify(["default", "research"]), "ids after second pair");
  await waitFor(() => events.some(([e, id]) => e === "added" && id === "research"), '"added" research');
  ok("multi-account: default + research both visible");

  // 3) inspectAccount on disabled account (cfg override)
  const cfgDisabled = {
    channels: { helloagent: { accounts: { research: { enabled: false } } } },
  };
  const inspDisabled = p.inspectAccount!(cfgDisabled as never, "research") as Record<string, unknown>;
  assertEq(inspDisabled.enabled, false, "research disabled by cfg");
  assertEq(inspDisabled.state, "disabled", "state=disabled");
  ok("cfg.enabled=false reflected in inspectAccount");

  // 4) resolveAccount throws on disabled
  let threwDisabled = false;
  try {
    p.resolveAccount!(cfgDisabled as never, "research");
  } catch (err) {
    threwDisabled = true;
    assert((err as Error).message.includes("disabled"), "expected 'disabled' in error message");
  }
  assert(threwDisabled, "resolveAccount on disabled account should throw");
  ok("resolveAccount throws on disabled with clear message");

  // 5) resolveAccount throws on unpaired with pairing hint
  let threwUnpaired = false;
  try {
    p.resolveAccount!({} as never, "missing");
  } catch (err) {
    threwUnpaired = true;
    assert(
      /openclaw channels login/.test((err as Error).message),
      `expected pairing hint, got: ${(err as Error).message}`,
    );
  }
  assert(threwUnpaired, "resolveAccount on missing should throw");
  ok("resolveAccount throws with pairing hint on unpaired id");

  // 6) Removal → "removed" event
  events.length = 0;
  await deleteCreds("research");
  accountCache.refreshNow();
  await waitFor(() => events.some(([e, id]) => e === "removed" && id === "research"), '"removed" research');
  const idsFinal = p.listAccountIds!({} as never);
  assert(!idsFinal.includes("research"), "research should be gone");
  ok("deleteCreds → cache emits 'removed' + listAccountIds drops it");

  // 7) defaultAccountId
  assertEq(p.defaultAccountId!({} as never), "default", "defaultAccountId");
  ok("defaultAccountId === 'default'");

  unsubscribe();
  accountCache.dispose();
}

// ---------------------------------------------------------------------------
// 7. cfg-store: atomic read/write + mergeHelloAgentAccountConfig
// ---------------------------------------------------------------------------

async function testCfgStore(tmpDir: string): Promise<void> {
  // Repoint the cfg path at a tmp dir so we don't touch the user's profile.
  const cfgDir = path.join(tmpDir, "cfg-store-test");
  process.env.OPENCLAW_STATE_DIR = cfgDir;
  delete process.env.OPENCLAW_CONFIG_PATH;

  const cfgPath = resolveCfgPath();
  assertEq(cfgPath, path.join(cfgDir, "openclaw.json"), "cfg path resolves under STATE_DIR");
  ok("resolveCfgPath honors OPENCLAW_STATE_DIR");

  // 1) reading a non-existent cfg returns {}
  const empty = await readCfg();
  assertEq(JSON.stringify(empty), "{}", "missing file → {}");
  ok("readCfg returns {} for missing file");

  // 2) writeCfg creates the file (and the parent dir)
  await writeCfg({ plugins: { entries: { helloagent: { enabled: true } } } });
  const written = await readCfg();
  assert(
    (written.plugins as { entries?: { helloagent?: { enabled?: boolean } } } | undefined)?.entries
      ?.helloagent?.enabled === true,
    "writeCfg → readCfg roundtrip",
  );
  ok("writeCfg creates file (and parent dir) atomically");

  // 3) mergeHelloAgentAccountConfig adds channels.helloagent for default
  const r1 = await mergeHelloAgentAccountConfig("default", { enabled: true });
  const channels1 = (r1.after.channels as { helloagent?: { enabled?: boolean } } | undefined)
    ?.helloagent;
  assertEq(channels1?.enabled, true, "merge writes channels.helloagent.enabled");
  ok("mergeHelloAgentAccountConfig writes channels.helloagent (default account)");

  // 4) Existing fields are preserved
  const onDisk1 = await readCfg();
  assert(
    (onDisk1.plugins as { entries?: { helloagent?: unknown } } | undefined)?.entries?.helloagent !==
      undefined,
    "plugins.entries.helloagent preserved",
  );
  ok("merge preserves unrelated cfg sections");

  // 5) Named-account merge writes under accounts.<id>
  const r2 = await mergeHelloAgentAccountConfig("work", { enabled: true });
  const accounts = (r2.after.channels as {
    helloagent?: { accounts?: Record<string, { enabled?: boolean }> };
  })?.helloagent?.accounts;
  assertEq(accounts?.work?.enabled, true, "named account written");
  ok("mergeHelloAgentAccountConfig writes channels.helloagent.accounts.<id> for named");

  // 6) Backup file is created on overwrite
  const bakExists = await import("node:fs/promises").then((m) =>
    m.access(`${cfgPath}.bak`).then(
      () => true,
      () => false,
    ),
  );
  assert(bakExists, ".bak should exist after at least one overwrite");
  ok("writeCfg creates .bak rotation on overwrite");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[smoke] HelloAgent channel plugin (new) — pure-function + disk smoke\n");

  const tmp = await mkdtemp(path.join(os.tmpdir(), "ha-helloagent-smoke-"));
  const originalState = process.env.OPENCLAW_STATE_DIR;
  const originalCfgPath = process.env.OPENCLAW_CONFIG_PATH;

  try {
    await step("1. Plugin shape", testPluginShape);
    await step("2. messaging.normalizeTarget / targetResolver", testMessagingHelpers);
    await step("3. MessageDedup + isMessageExpired", testDedup);
    await step("4. config-adapter mutators", testConfigAdapter);
    await step("5. security.collectWarnings", testSecurityWarnings);
    await step("6. Disk creds → cache → plugin.config", () => testDiskCredsWiring(tmp));
    await step("7. cfg-store atomic I/O", () => testCfgStore(tmp));
  } finally {
    if (originalState === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = originalState;
    if (originalCfgPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = originalCfgPath;
    await rm(tmp, { recursive: true, force: true });
  }

  console.log("");
  console.log(`[smoke] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    console.log("[smoke] failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("[smoke] PASS");
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err);
  process.exit(1);
});
