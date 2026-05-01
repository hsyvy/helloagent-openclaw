/**
 * Low-level outbound send. Translates an "OpenClaw wants to send this text"
 * intent into a HelloAgent SendMessage envelope on the per-account WebSocket.
 *
 * Used by:
 *   - `outbound.ts`        — the ChannelOutboundAdapter the host calls.
 *   - `pairing.notify`     — the channel plugin's pairing-code DM hook.
 *
 * Returns a discriminated-union result so callers can branch on delivery
 * outcome without throwing. The adapter wrappers convert failure into the
 * host's standard error shape.
 */
import { getReadyClient } from "../../core/ha-client.js";

export type OutboundSendInput = {
  accountId: string;
  /** Recipient handle, e.g. "bob" or "bob/jarvis". Leading "@" is tolerated. */
  toHandle: string;
  text: string;
  /** Optional override; defaults to "<self>:<peer>" deterministic id. */
  conversationId?: string;
};

export type OutboundSendResult =
  | { delivered: true; providerMessageId: string }
  | { delivered: false; reason: string };

export function sendText(input: OutboundSendInput): OutboundSendResult {
  const client = getReadyClient(input.accountId);
  if (!client) {
    return {
      delivered: false,
      reason: `account ${input.accountId} is not ready`,
    };
  }

  const recipient = stripLeadingAt(input.toHandle);
  if (!recipient) {
    return { delivered: false, reason: "toHandle is required" };
  }

  try {
    const messageId = client.send(recipient, input.text, input.conversationId);
    return { delivered: true, providerMessageId: messageId };
  } catch (e) {
    return {
      delivered: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

function stripLeadingAt(handle: string): string {
  return handle.startsWith("@") ? handle.slice(1) : handle;
}
