/**
 * Atomic read/write for the OpenClaw config file (`openclaw.json`).
 *
 * Used by `auth.login` to write `channels.helloagent.enabled=true` directly
 * after pairing, so the channel becomes visible to `channels list` and
 * auto-starts on next gateway boot — regardless of whether the host's
 * post-login reconciler can reach the running gateway (it skips the cfg
 * update when the gateway is down or running with a URL override that
 * requires explicit credentials).
 *
 * Path resolution:
 *   1. `OPENCLAW_CONFIG_PATH` env var if set (fully qualified path).
 *   2. `${OPENCLAW_STATE_DIR}/openclaw.json` if state dir is set.
 *   3. `~/.openclaw/openclaw.json`.
 *
 * Atomic write: temp file + rename + `.bak` rotation.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyAccountConfig } from "../channel/config-adapter.js";
import type { HelloAgentChannelAccountConfig } from "./types.js";

const CONFIG_FILENAME = "openclaw.json";

/**
 * Resolve the active openclaw.json path. Mirrors the host's resolution so
 * we read/write the same file the rest of OpenClaw is using, including
 * profile-aware `--profile <name>` invocations (which set
 * `OPENCLAW_STATE_DIR=~/.openclaw-<name>` before plugin code runs).
 */
export function resolveCfgPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return explicit;
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, CONFIG_FILENAME);
}

/**
 * Read the cfg file. Returns `{}` if the file doesn't exist (fresh profile).
 * Throws on JSON parse errors so we don't silently overwrite a corrupt
 * but non-empty file.
 */
export async function readCfg(): Promise<Record<string, unknown>> {
  const p = resolveCfgPath();
  try {
    const raw = await fs.readFile(p, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Write the cfg file atomically. Creates a `.bak` of the existing file
 * before replacing it. Permissions match the existing file when possible
 * (default 0644 — host CLI uses non-secret cfg).
 */
export async function writeCfg(cfg: Record<string, unknown>): Promise<void> {
  const p = resolveCfgPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify(cfg, null, 2) + "\n";
  await fs.writeFile(tmp, payload);

  // Roll the existing file into <p>.bak before replacing it.
  try {
    const existing = await fs.readFile(p);
    await fs.writeFile(`${p}.bak`, existing);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  await fs.rename(tmp, p);
}

/**
 * High-level convenience: read cfg → apply our `channels.helloagent`
 * patch via the existing `applyAccountConfig` helper → write cfg back.
 *
 * Used from `auth-login.ts` after each successful pairing mode so the
 * channel is immediately visible to `channels list` and auto-starts on
 * the next gateway boot.
 *
 * Best-effort: callers should catch errors and fall back to logging a
 * "run `openclaw config set` manually" hint. The pairing succeeded
 * regardless — creds are on disk.
 */
export async function mergeHelloAgentAccountConfig(
  accountId: string,
  patch: HelloAgentChannelAccountConfig,
): Promise<{ path: string; before: Record<string, unknown>; after: Record<string, unknown> }> {
  const before = await readCfg();
  const after = applyAccountConfig(before, accountId, patch);
  await writeCfg(after);
  return { path: resolveCfgPath(), before, after };
}
