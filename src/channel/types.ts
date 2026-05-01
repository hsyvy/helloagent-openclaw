/**
 * Per-account monitor context — passed to event handlers so they have a
 * consistent set of dependencies (client, logger, dedup) without each
 * handler re-resolving them.
 */
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";

import type { HaClient } from "../core/ha-client.js";
import type { ResolvedHelloAgentAccount } from "../core/types.js";
import type { MessageDedup } from "../messaging/inbound/dedup.js";

export type MonitorContext = {
  /** Original gateway context — exposes cfg, channelRuntime, log, setStatus. */
  gatewayCtx: ChannelGatewayContext<ResolvedHelloAgentAccount>;
  accountId: string;
  client: HaClient;
  dedup: MessageDedup;
};
