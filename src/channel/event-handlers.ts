/**
 * Event handlers for the per-account HelloAgent client.
 *
 * Mirrors Lark's channel/event-handlers.ts: per-event functions that receive
 * a `MonitorContext` and pre-filter (dedup, expiry) before handing off to
 * the inbound dispatcher.
 *
 * MVP scope: only `handleIncomingMessage`. Reactions, comment events,
 * card actions, and bot membership changes are not part of HelloAgent's
 * relay protocol yet.
 */
import type { IncomingMessage } from "@helloagent/sdk";

import { haLogger } from "../core/ha-logger.js";
import { isMessageExpired } from "../messaging/inbound/dedup.js";
import { makeInboundDispatcher } from "../messaging/inbound/dispatch.js";
import type { MonitorContext } from "./types.js";

const log = haLogger("channel/event-handlers");

/**
 * Build the IncomingMessage handler that the SDK Agent will call. Filters
 * duplicates / stale messages before delegating to the streaming dispatcher.
 *
 * Returns an `(msg) => AsyncIterable<string> | string` that the Agent uses
 * as its onMessage handler — the AsyncIterable form streams chunks back to
 * the peer.
 */
export function makeMessageHandler(
  ctx: MonitorContext,
): (msg: IncomingMessage) => AsyncIterable<string> | string {
  const dispatcher = makeInboundDispatcher(ctx.gatewayCtx);

  return (msg) => {
    // Dedup — avoid double-dispatching after relay reconnects.
    if (!ctx.dedup.tryRecord(msg.messageId, ctx.accountId)) {
      log.info(`duplicate message ${msg.messageId}, skipping`, {
        accountId: ctx.accountId,
      });
      return ""; // SDK still emits a final empty chunk so the peer un-pends.
    }

    // Stale messages (e.g. very old replays) are dropped silently.
    const ts = (msg as IncomingMessage & { timestamp?: number }).timestamp;
    if (isMessageExpired(ts)) {
      log.info(`message ${msg.messageId} expired, discarding`, {
        accountId: ctx.accountId,
      });
      return "";
    }

    return dispatcher(msg);
  };
}
