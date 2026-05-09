/**
 * HelloAgent account resolution.
 *
 * Combines two sources:
 *
 *   1. **On-disk creds** under `~/.openclaw/credentials/helloagent/<id>/creds.json`
 *      — the source of truth for the long-lived `ha_*` token. Surfaced via
 *      [account-cache.ts] (sync façade with fs.watch).
 *
 *   2. **OpenClaw cfg** at `cfg.channels.helloagent.accounts.<id>` — per-account
 *      knobs the user can edit via `openclaw config` (`enabled`, `name`,
 *      `apiUrl` override, `relayWs` override, `dmPolicy`, `allowFrom`).
 *
 * The merge produces a `HelloAgentAccount` view with both sides — host
 * surfaces (status, security, listing) get a uniform shape regardless of
 * whether an entry is paired-but-disabled, configured-but-unpaired, etc.
 */
import {
  DEFAULT_ACCOUNT_ID,
  type HelloAgentCreds,
} from "./auth-store.js";
import * as accountCache from "./account-cache.js";
import type {
  HelloAgentAccount,
  HelloAgentChannelAccountConfig,
  HelloAgentChannelConfig,
  ResolvedHelloAgentAccount,
} from "./types.js";

// ---------------------------------------------------------------------------
// Disk → ResolvedHelloAgentAccount
// ---------------------------------------------------------------------------

export function credsToAccount(
  accountId: string,
  creds: HelloAgentCreds,
): ResolvedHelloAgentAccount {
  return {
    accountId,
    handle: creds.handle,
    ownerHandle: creds.ownerHandle,
    agentName: creds.agentName,
    token: creds.token,
    apiUrl: creds.apiUrl,
    relayWs: creds.relayWs,
  };
}

// ---------------------------------------------------------------------------
// cfg helpers
// ---------------------------------------------------------------------------

function readChannelSection(cfg: unknown): HelloAgentChannelConfig | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels;
  const raw = channels?.helloagent;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as HelloAgentChannelConfig;
}

function readAccountConfig(
  section: HelloAgentChannelConfig | undefined,
  accountId: string,
): HelloAgentChannelAccountConfig {
  if (!section) return {};
  const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;
  if (isDefault) {
    const { accounts: _ignored, ...base } = section;
    return base;
  }
  return section.accounts?.[accountId] ?? {};
}

// ---------------------------------------------------------------------------
// Public API: account list + resolve
// ---------------------------------------------------------------------------

/**
 * List all HelloAgent account ids known to this plugin. Combines:
 *   - paired creds on disk (the canonical "configured" set)
 *   - any account ids referenced under cfg.channels.helloagent.accounts
 *     (so a user can pre-declare a future-paired account and see it in
 *     `openclaw config show`).
 *
 * Disabled accounts are still listed; the host filters at start time using
 * `isEnabled`.
 */
export function listAccountIds(cfg: unknown): string[] {
  const fromDisk = accountCache.listAccountIds();
  const section = readChannelSection(cfg);
  const fromCfg = section?.accounts ? Object.keys(section.accounts) : [];
  const combined = new Set<string>([...fromDisk, ...fromCfg]);

  // If neither source has anything but the user has set top-level cfg
  // (channels.helloagent.enabled etc.), expose `default` so the host can
  // still surface "Needs pairing".
  if (combined.size === 0 && section) combined.add(DEFAULT_ACCOUNT_ID);
  return [...combined];
}

/**
 * Resolve a single account by merging disk creds with cfg overrides. The
 * resolved view is what host status/security/lifecycle code consumes.
 *
 * Returns `configured: false` when no creds.json exists for this id.
 * Returns `enabled: false` when cfg explicitly disables the account.
 */
export function getAccount(cfg: unknown, accountId?: string | null): HelloAgentAccount {
  const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const section = readChannelSection(cfg);
  const accountCfg = readAccountConfig(section, id);

  const resolved = accountCache.resolveAccount(id);
  const configured = Boolean(resolved);
  const enabled = accountCfg.enabled ?? configured;

  // Apply per-account cfg overrides on top of disk values when both exist.
  const finalResolved: ResolvedHelloAgentAccount | undefined = resolved
    ? {
        ...resolved,
        apiUrl: accountCfg.apiUrl ?? resolved.apiUrl,
        relayWs: accountCfg.relayWs ?? resolved.relayWs,
      }
    : undefined;

  return {
    accountId: id,
    enabled,
    configured,
    name: accountCfg.name,
    resolved: finalResolved,
    config: accountCfg,
  };
}

