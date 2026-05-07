/**
 * Per-account state held in memory by the plugin runtime. Materialised by
 * core/auth-store reading the persisted creds.json on disk.
 */
export type ResolvedHelloAgentAccount = {
  accountId: string;
  /** Bound HelloAgent handle, e.g. "alice/jarvis". */
  handle: string;
  /** Owner's user handle, e.g. "alice". */
  ownerHandle: string;
  /** User-chosen suffix, e.g. "jarvis". */
  agentName: string;
  /** Long-lived ha_* token. */
  token: string;
  /** REST base, e.g. https://api.helloagent.cc. */
  apiUrl: string;
  /** Relay WebSocket URL, e.g. wss://relay.helloagent.cc/v1/ws. */
  relayWs: string;
};

/**
 * Lark-style "account view" returned by config.resolveAccount. Combines the
 * disk-resident creds with the host-managed enabled/configured flags so the
 * status panel can describe an account that is paired but disabled, or
 * referenced in cfg but not yet paired.
 */
export type HelloAgentAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  /** Display name, if cfg supplies one. */
  name?: string;
  /** Present iff configured (i.e. creds.json exists for this id). */
  resolved?: ResolvedHelloAgentAccount;
  /** Per-account cfg snapshot from cfg.channels.helloagent.accounts.<id>. */
  config: HelloAgentChannelAccountConfig;
};

/** Mirrors the JSON-schema shape declared in openclaw.plugin.json. */
export type HelloAgentChannelAccountConfig = {
  enabled?: boolean;
  name?: string;
  apiUrl?: string;
  relayWs?: string;
  /** DM allowlist — user handles allowed to message this agent. */
  allowFrom?: string[];
  /** DM policy — see security adapter. */
  dmPolicy?: "allowlist" | "allow-all" | "deny-all" | "pairing";
};

/** Top-level cfg shape under cfg.channels.helloagent. */
export type HelloAgentChannelConfig = HelloAgentChannelAccountConfig & {
  accounts?: Record<string, HelloAgentChannelAccountConfig>;
};
