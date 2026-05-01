/**
 * Configuration merge helpers for HelloAgent account management.
 *
 * Mirrors Lark's config-adapter.ts: centralises the pattern of merging a
 * partial configuration patch into the HelloAgent section of the top-level
 * OpenClaw config, handling both the default account (top-level fields) and
 * named accounts (nested under `accounts`).
 *
 * Plus: `collectHelloAgentSecurityWarnings` produces user-facing warnings
 * for the channel plugin's `security.collectWarnings` adapter.
 */
import { DEFAULT_ACCOUNT_ID } from "../core/auth-store.js";
import { getAccount, listAccountIds } from "../core/accounts.js";
import type {
  HelloAgentChannelAccountConfig,
  HelloAgentChannelConfig,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Generic cfg merge
// ---------------------------------------------------------------------------

function readSection(cfg: unknown): HelloAgentChannelConfig | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels;
  const raw = channels?.helloagent;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as HelloAgentChannelConfig;
}

function withSection<T extends Record<string, unknown>>(
  cfg: T,
  next: HelloAgentChannelConfig,
): T {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels ?? {};
  return {
    ...cfg,
    channels: {
      ...channels,
      helloagent: next,
    },
  };
}

function mergeAccountPatch<T extends Record<string, unknown>>(
  cfg: T,
  accountId: string,
  patch: HelloAgentChannelAccountConfig,
): T {
  const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;
  const section = readSection(cfg) ?? {};

  if (isDefault) {
    const next: HelloAgentChannelConfig = { ...section, ...patch };
    return withSection(cfg, next);
  }

  const accounts = section.accounts ?? {};
  const next: HelloAgentChannelConfig = {
    ...section,
    accounts: {
      ...accounts,
      [accountId]: { ...accounts[accountId], ...patch },
    },
  };
  return withSection(cfg, next);
}

// ---------------------------------------------------------------------------
// Public API — used from src/channel/plugin.ts
// ---------------------------------------------------------------------------

export function setAccountEnabled<T extends Record<string, unknown>>(
  cfg: T,
  accountId: string,
  enabled: boolean,
): T {
  return mergeAccountPatch(cfg, accountId, { enabled });
}

export function applyAccountConfig<T extends Record<string, unknown>>(
  cfg: T,
  accountId: string,
  patch: HelloAgentChannelAccountConfig,
): T {
  return mergeAccountPatch(cfg, accountId, patch);
}

export function deleteAccount<T extends Record<string, unknown>>(
  cfg: T,
  accountId: string,
): T {
  const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;
  const section = readSection(cfg);
  if (!section) return cfg;

  if (isDefault) {
    // Drop everything under channels.helloagent EXCEPT the named-accounts map
    // (so a multi-account setup keeps its other entries when the default is
    // removed).
    const accounts = section.accounts;
    const remaining = accounts && Object.keys(accounts).length > 0 ? { accounts } : undefined;
    if (!remaining) {
      const channels = ((cfg as { channels?: Record<string, unknown> }).channels ?? {}) as Record<
        string,
        unknown
      >;
      const { helloagent: _drop, ...rest } = channels;
      return { ...cfg, channels: rest } as T;
    }
    return withSection(cfg, remaining);
  }

  const accounts = { ...(section.accounts ?? {}) };
  delete accounts[accountId];
  const next: HelloAgentChannelConfig = {
    ...section,
    accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
  };
  return withSection(cfg, next);
}

// ---------------------------------------------------------------------------
// Security warnings
// ---------------------------------------------------------------------------

/**
 * Produce user-facing security warnings for a HelloAgent account.
 * Surfaced through the channel plugin's `security.collectWarnings`.
 *
 * MVP rules:
 *   - dmPolicy="allow-all" with no allowFrom → warn (anyone can DM the agent).
 *   - allowFrom configured with dmPolicy="allow-all" → warn (allowFrom is ignored).
 */
export function collectHelloAgentSecurityWarnings(params: {
  cfg: unknown;
  accountId: string;
}): string[] {
  const account = getAccount(params.cfg, params.accountId);
  const warnings: string[] = [];

  const policy = account.config.dmPolicy ?? "allowlist";
  const allowFrom = account.config.allowFrom ?? [];

  if (policy === "allow-all") {
    warnings.push(
      `- HelloAgent[${account.accountId}]: dmPolicy="allow-all" lets ANY HelloAgent peer ` +
        `DM the agent. Set dmPolicy="allowlist" and list peer handles in ` +
        `channels.helloagent.allowFrom to restrict access.`,
    );
  }

  if (policy === "allow-all" && allowFrom.length > 0) {
    warnings.push(
      `- HelloAgent[${account.accountId}]: allowFrom is configured but dmPolicy="allow-all" ignores it. ` +
        `Switch to dmPolicy="allowlist" or remove the entries.`,
    );
  }

  // Multi-account isolation hint — fire only on first account so we don't repeat.
  const allIds = listAccountIds(params.cfg);
  if (allIds.length > 1 && (allIds[0] === params.accountId || account.accountId === allIds[0])) {
    warnings.push(
      `- HelloAgent: ${allIds.length} accounts configured. Each shares one disk credential ` +
        `directory under ~/.openclaw/credentials/helloagent/<accountId>/. Verify policies ` +
        `per-account if any tenant boundary matters.`,
    );
  }

  return warnings;
}
