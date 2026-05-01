/**
 * Per-account WebSocket monitor — replaces the role of the old
 * `session-manager.ts` and aligns with Lark's `channel/monitor.ts` shape.
 *
 * `startAccount(ctx)` is what the gateway adapter (`gateway.startAccount` in
 * src/channel/plugin.ts) hands off to. It:
 *
 *   1. Builds a MonitorContext (dedup + dispatcher).
 *   2. Constructs the HaClient (which opens the WS, starts auth handshake,
 *      and runs the long-lived run loop).
 *   3. Wires the Agent's onMessage handler to the streaming dispatcher.
 *   4. Forwards lifecycle status changes through to `ctx.setStatus`.
 *   5. Awaits `gatewayCtx.abortSignal` — does NOT return early. The host's
 *      channel-runtime treats `startAccount` resolution as "channel exited"
 *      and schedules an auto-restart, which crashes if its internal logger
 *      is undefined (server.impl-hNr66nDN.js:2073). Lark's monitor follows
 *      the same long-running-promise contract.
 *
 * `stopAccount(accountId)` tears down the live client.
 */
import type { IncomingMessage } from "@helloagent/sdk";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";

import { haLogger } from "../core/ha-logger.js";
import {
  type ClientStatus,
  startClient,
  stopClient as stopClientById,
  stopAllClients as stopAllClientsImpl,
} from "../core/ha-client.js";
import type { ResolvedHelloAgentAccount } from "../core/types.js";
import { MessageDedup } from "../messaging/inbound/dedup.js";
import { makeMessageHandler } from "./event-handlers.js";
import type { MonitorContext } from "./types.js";

const log = haLogger("channel/monitor");

// ---------------------------------------------------------------------------
// Status snapshot helper — what `ctx.setStatus` consumes.
// ---------------------------------------------------------------------------

function snapshot(
  accountId: string,
  status: ClientStatus,
  detail: string | undefined,
): { accountId: string; state: string; detail?: string } {
  return {
    accountId,
    state: status, // "starting" | "ready" | "needs_repairing" | "stopped"
    ...(detail ? { detail } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API — gateway adapter glue
// ---------------------------------------------------------------------------

export async function startAccount(
  gatewayCtx: ChannelGatewayContext<ResolvedHelloAgentAccount>,
): Promise<void> {
  const accountId = gatewayCtx.accountId;
  const account = gatewayCtx.account;
  const dedup = new MessageDedup();

  log.info(`starting account ${accountId}`, { handle: account.handle });

  // Forward status to the host's status panel + log.
  const onStatus = (id: string, status: ClientStatus, detail?: string) => {
    const snap = snapshot(id, status, detail);
    gatewayCtx.log?.info?.(
      `helloagent: account ${id} → ${status}${detail ? ` (${detail})` : ""}`,
    );
    try {
      gatewayCtx.setStatus(snap as Parameters<typeof gatewayCtx.setStatus>[0]);
    } catch (err) {
      gatewayCtx.log?.warn?.(
        `helloagent: setStatus failed for ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // Build the inbound handler before the client starts so the first message
  // doesn't race against a not-yet-attached onMessage handler. We close
  // over a `monitorCtx` that fills in once `startClient` returns; messages
  // that race that gap are rare (the relay won't deliver inbound until
  // auth_response succeeds) and we drop them defensively.
  let monitorCtx: MonitorContext | undefined;
  const incomingHandler = (msg: IncomingMessage): AsyncIterable<string> | string => {
    if (!monitorCtx) {
      log.warn("inbound message arrived before monitor context was set up; dropping");
      return "";
    }
    return makeMessageHandler(monitorCtx)(msg);
  };

  const client = startClient({
    account,
    onStatus,
    onIncoming: incomingHandler,
  });

  monitorCtx = {
    gatewayCtx,
    accountId,
    client,
    dedup,
  };

  // Wait for the relay to bind the handle. If the token is bad, this rejects
  // with a clear message; the host logs the failure but keeps the daemon up.
  await client.ready;
  log.info(`account ${accountId} ready (handle=${client.account.handle})`);

  // Block until the host signals shutdown. If we resolve earlier, the host's
  // channel-runtime interprets that as "channel exited" and enters its
  // auto-restart machinery — which has a bug
  // (server.impl-hNr66nDN.js:2073: log.info?.() on undefined log) that
  // crashes the entire gateway. Mirror Lark's `await lark.startWS({...})`
  // pattern: stay pending until abort, then clean up.
  await new Promise<void>((resolve) => {
    if (gatewayCtx.abortSignal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      gatewayCtx.abortSignal.removeEventListener("abort", onAbort);
      resolve();
    };
    gatewayCtx.abortSignal.addEventListener("abort", onAbort, { once: true });
  });

  log.info(`account ${accountId} shutting down (abort signal received)`);
  stopClientById(accountId);
}

export async function stopAccount(accountId: string): Promise<void> {
  log.info(`stopping account ${accountId}`);
  stopClientById(accountId);
}

export async function stopAllAccounts(): Promise<void> {
  log.info(`stopping all accounts`);
  stopAllClientsImpl();
}
