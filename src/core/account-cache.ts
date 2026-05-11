/**
 * Synchronous façade over the on-disk creds directory.
 *
 * The OpenClaw host's `ChannelConfigAdapter.listAccountIds` and
 * `resolveAccount` are SYNCHRONOUS — they're called inside the gateway boot
 * loop and on every status check. Our actual creds live as JSON files on
 * disk, which is async. This module bridges the gap:
 *
 *   - On first config access, `init()` reads every `creds.json` under
 *     `~/.openclaw/credentials/helloagent/<accountId>/`.
 *   - Starts a `fs.watch` on the parent directory (poll fallback at 5s if the
 *     watcher errors).
 *   - Notifies `onChange` listeners with `"added" | "removed"` events.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { credsToAccount } from "./accounts.js";
import {
  CREDS_VERSION,
  type HelloAgentCreds,
  resolveHelloAgentAuthDir,
} from "./auth-store.js";
import type { ResolvedHelloAgentAccount } from "./types.js";

export type AccountCacheEvent = "added" | "removed";
export type AccountCacheListener = (event: AccountCacheEvent, accountId: string) => void;

const accounts = new Map<string, ResolvedHelloAgentAccount>();
const listeners = new Set<AccountCacheListener>();

let initialized = false;
let watcher: fs.FSWatcher | null = null;
let pollHandle: NodeJS.Timeout | null = null;
let refreshScheduled = false;

const POLL_INTERVAL_MS = 5_000;

function emit(event: AccountCacheEvent, accountId: string): void {
  for (const fn of listeners) {
    try {
      fn(event, accountId);
    } catch {
      /* swallow — a bad subscriber must not poison the cache */
    }
  }
}

function readDirIds(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    try {
      fs.accessSync(path.join(dir, ent.name, "creds.json"));
      out.push(ent.name);
    } catch {
      /* missing creds.json — skip silently */
    }
  }
  return out;
}

function readCreds(dir: string, accountId: string): HelloAgentCreds | null {
  try {
    const raw = fs.readFileSync(path.join(dir, accountId, "creds.json"), "utf-8");
    const parsed = JSON.parse(raw) as HelloAgentCreds;
    if (parsed.version !== CREDS_VERSION) return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function refreshSync(): void {
  const dir = resolveHelloAgentAuthDir();
  const idsOnDisk = new Set(readDirIds(dir));

  for (const id of [...accounts.keys()]) {
    if (!idsOnDisk.has(id)) {
      accounts.delete(id);
      emit("removed", id);
    }
  }
  for (const id of idsOnDisk) {
    const creds = readCreds(dir, id);
    if (!creds) continue;
    const account = credsToAccount(id, creds);
    const existing = accounts.get(id);
    if (existing && existing.token === account.token && existing.handle === account.handle) {
      continue;
    }
    accounts.set(id, account);
    if (!existing) emit("added", id);
  }
}

function scheduleRefresh(): void {
  if (refreshScheduled) return;
  refreshScheduled = true;
  queueMicrotask(() => {
    refreshScheduled = false;
    try {
      refreshSync();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[helloagent] cache refresh failed: ${(err as Error).message}`);
    }
  });
}

function startWatcher(): void {
  const dir = resolveHelloAgentAuthDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      startPolling();
      return;
    }
  }
  try {
    watcher = fs.watch(dir, { persistent: false, recursive: true }, () => {
      scheduleRefresh();
    });
    watcher.on("error", () => {
      stopWatcher();
      startPolling();
    });
  } catch {
    startPolling();
  }
}

function stopWatcher(): void {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  }
}

function startPolling(): void {
  if (pollHandle) return;
  pollHandle = setInterval(() => {
    scheduleRefresh();
  }, POLL_INTERVAL_MS);
  pollHandle.unref?.();
}

function stopPolling(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

export function init(): void {
  if (initialized) return;
  initialized = true;
  try {
    refreshSync();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[helloagent] initial cache scan failed: ${(err as Error).message}`);
  }
  startWatcher();
}

export function dispose(): void {
  stopWatcher();
  stopPolling();
  accounts.clear();
  listeners.clear();
  initialized = false;
}

export function listAccountIds(): string[] {
  if (!initialized) init();
  return Array.from(accounts.keys());
}

export function resolveAccount(accountId: string): ResolvedHelloAgentAccount | undefined {
  if (!initialized) init();
  const cached = accounts.get(accountId);
  if (cached) return cached;

  // Cache miss — could be a brand-new creds file that fs.watch hasn't
  // surfaced yet (CLI writes creds, then immediately asks the gateway to
  // start the channel; the watcher tick has not landed). Try a direct disk
  // read to self-heal. If found, prime the cache and emit "added" so any
  // downstream listeners stay in sync.
  const creds = readCreds(resolveHelloAgentAuthDir(), accountId);
  if (!creds) return undefined;
  const account = credsToAccount(accountId, creds);
  accounts.set(accountId, account);
  emit("added", accountId);
  return account;
}

export function onChange(listener: AccountCacheListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function refreshNow(): void {
  if (!initialized) init();
  refreshSync();
}
