/**
 * ChannelOutboundAdapter for HelloAgent.
 *
 * Receives `sendText` calls from OpenClaw (proactive sends from the
 * assistant; OpenClaw composer messages) and routes them through the
 * HelloAgent relay session via `messaging/outbound/send.ts`.
 *
 * Inbound replies — i.e. responses to a peer's incoming message — flow back
 * via `messaging/inbound/dispatch.ts` (an AsyncIterable<string> that the
 * SDK turns into StreamChunks), NOT through this adapter.
 *
 * MVP scope:
 *   - `sendText`  ✅
 *   - `sendMedia` ❌ (throws; deferred — relay does not yet ship media)
 *   - `sendPayload` ❌ (throws; deferred — no rich-payload support yet)
 *
 * Conventions:
 *   - `deliveryMode: "direct"` — we own the WebSocket; no gateway hop.
 *   - Throws on failure; OpenClaw's send-result helpers convert thrown
 *     errors into delivery-failure records.
 */
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/core";

import { haLogger } from "../../core/ha-logger.js";
import { sendText } from "./send.js";

const log = haLogger("messaging/outbound/outbound");

const CHANNEL_ID = "helloagent";

export const helloAgentOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",

  async sendText(ctx) {
    if (!ctx.accountId) {
      throw new Error("helloagent: missing accountId on outbound ctx");
    }
    if (!ctx.to) {
      throw new Error("helloagent: missing recipient handle (ctx.to) on outbound ctx");
    }

    log.info(`sendText: account=${ctx.accountId} to=${ctx.to} len=${ctx.text.length}`);

    const result = sendText({
      accountId: ctx.accountId,
      toHandle: ctx.to,
      text: ctx.text,
    });
    if (!result.delivered) {
      throw new Error(`helloagent: outbound failed: ${result.reason}`);
    }
    return {
      channel: CHANNEL_ID,
      messageId: result.providerMessageId,
    };
  },

  async sendMedia() {
    throw new Error(
      "helloagent: sendMedia is not implemented yet — the relay does not ship media in MVP",
    );
  },

  async sendPayload() {
    throw new Error(
      "helloagent: sendPayload is not implemented yet — no rich-payload (channelData) support in MVP",
    );
  },
};
