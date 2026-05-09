/**
 * Streaming inbound dispatch.
 *
 * The SDK's `Agent.onMessage` handler can return an `AsyncIterable<string>`;
 * each yielded value becomes a separate `StreamChunk` back to the peer (final
 * chunk with `is_final=true`). The OpenClaw reply dispatcher emits a
 * `deliver(payload)` call per text block; we forward each one as a yield.
 *
 * The plumbing is a small producer/consumer queue: `dispatchInboundDirectDmWithRuntime`
 * runs in the background and pushes `{type:"chunk"|"end"|"error"}` items;
 * the AsyncGenerator drains them and yields strings.
 */
import type { IncomingMessage } from "@helloagentai/sdk";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";

import type { ResolvedHelloAgentAccount } from "../../core/types.js";
import { haLogger } from "../../core/ha-logger.js";

const log = haLogger("messaging/inbound/dispatch");

const CHANNEL_ID = "helloagent";
const CHANNEL_LABEL = "HelloAgent";

type QueueItem =
  | { type: "chunk"; text: string }
  | { type: "end" }
  | { type: "error"; err: unknown };

class StreamQueue {
  private readonly buf: QueueItem[] = [];
  private waiter: ((item: QueueItem) => void) | null = null;

  push(item: QueueItem): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
      return;
    }
    this.buf.push(item);
  }

  next(): Promise<QueueItem> {
    if (this.buf.length > 0) return Promise.resolve(this.buf.shift() as QueueItem);
    return new Promise<QueueItem>((resolve) => {
      this.waiter = resolve;
    });
  }
}

/**
 * Build the dispatcher hooked into `HaClient.onIncoming`. Closes over the
 * gateway `ctx` so each dispatch sees the current cfg/runtime.
 *
 * Returns the IncomingMessage handler signature expected by `Agent.onMessage`.
 */
export function makeInboundDispatcher(
  ctx: ChannelGatewayContext<ResolvedHelloAgentAccount>,
): (msg: IncomingMessage) => AsyncIterable<string> {
  return (msg) => streamDispatch(ctx, msg);
}

async function* streamDispatch(
  ctx: ChannelGatewayContext<ResolvedHelloAgentAccount>,
  msg: IncomingMessage,
): AsyncGenerator<string, void, unknown> {
  const channelRuntime = ctx.channelRuntime;
  if (!channelRuntime) {
    log.warn(`channelRuntime missing; suppressing reply for ${msg.messageId}`);
    return;
  }

  // The plugin-sdk types `channelRuntime` as the minimal ChannelRuntimeSurface
  // for forward-compat, but the actual object is the full
  // createPluginRuntime().channel surface — cast to expose the wider shape
  // dispatchInboundDirectDmWithRuntime expects.
  const runtime = {
    channel: channelRuntime as unknown as Parameters<
      typeof dispatchInboundDirectDmWithRuntime
    >[0]["runtime"]["channel"],
  };

  const account = ctx.account;
  const queue = new StreamQueue();

  // Background producer. Runs the SDK dispatch and pushes chunks to the queue.
  void (async () => {
    try {
      await dispatchInboundDirectDmWithRuntime({
        cfg: ctx.cfg,
        runtime: { channel: runtime.channel },
        channel: CHANNEL_ID,
        channelLabel: CHANNEL_LABEL,
        accountId: account.accountId,
        peer: { kind: "direct", id: msg.fromHandle },
        senderId: msg.fromHandle,
        senderAddress: msg.fromHandle,
        recipientAddress: account.handle,
        conversationLabel: msg.fromHandle,
        rawBody: msg.text,
        messageId: msg.messageId,
        timestamp: Date.now(),
        provider: CHANNEL_ID,
        surface: CHANNEL_ID,
        deliver: async (payload) => {
          if (typeof payload.text === "string" && payload.text.length > 0) {
            queue.push({ type: "chunk", text: payload.text });
          }
        },
        onRecordError: (err) => {
          log.warn(`failed to record inbound session for ${msg.messageId}`, {
            err: err instanceof Error ? err.message : String(err),
          });
        },
        onDispatchError: (err, info) => {
          log.error(`dispatch error (${info.kind}) for ${msg.messageId}`, {
            err: err instanceof Error ? err.message : String(err),
          });
        },
      });
      queue.push({ type: "end" });
    } catch (err) {
      queue.push({ type: "error", err });
    }
  })();

  // Consumer — yield as chunks arrive.
  while (true) {
    const item = await queue.next();
    if (item.type === "chunk") {
      yield item.text;
      continue;
    }
    if (item.type === "end") return;
    log.error(`dispatch threw for ${msg.messageId}`, {
      err: item.err instanceof Error ? item.err.message : String(item.err),
    });
    return;
  }
}
