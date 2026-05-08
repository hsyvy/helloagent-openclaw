/**
 * Per-account managed HelloAgent SDK client.
 *
 * One `HaClient` wraps one `Agent` from `@helloagentai/sdk` plus the lifecycle
 * state needed to expose it through the channel plugin's status surface
 * (starting / ready / needs_repairing / stopped).
 *
 * Replaces the role of the old `session-manager.ts` by reorganising along
 * Lark's structure: a `HaClient` is to HelloAgent what `LarkClient` is to
 * Feishu — the per-account handle that lifecycle, outbound, and probe code
 * all share.
 */
import { Agent, AuthFailedError, type IncomingMessage } from "@helloagentai/sdk";

import type { ResolvedHelloAgentAccount } from "./types.js";
import { haLogger } from "./ha-logger.js";

const log = haLogger("core/ha-client");

export type ClientStatus = "starting" | "ready" | "needs_repairing" | "stopped";

export type ClientStatusListener = (
  accountId: string,
  status: ClientStatus,
  detail?: string,
) => void;

export type IncomingHandler = (msg: IncomingMessage) => string | Promise<string> | AsyncIterable<string>;

export type HaClientOptions = {
  account: ResolvedHelloAgentAccount;
  onStatus?: ClientStatusListener;
  onIncoming?: IncomingHandler;
};

/** Module-level registry — one client per accountId. */
const clients = new Map<string, HaClient>();

export class HaClient {
  readonly account: ResolvedHelloAgentAccount;
  readonly accountId: string;
  readonly agent: Agent;
  readonly ready: Promise<void>;

  status: ClientStatus = "starting";
  detail?: string;

  private readonly onStatus?: ClientStatusListener;

  constructor(opts: HaClientOptions) {
    this.account = opts.account;
    this.accountId = opts.account.accountId;
    this.onStatus = opts.onStatus;

    this.agent = new Agent({
      token: opts.account.token,
      relayUrl: opts.account.relayWs,
      onAuthFailed: (err: AuthFailedError) => this.handleAuthFailed(err),
    });

    if (opts.onIncoming) {
      this.agent.onMessage(opts.onIncoming);
    }

    this.ready = this.waitForHandle();

    // Long-lived run loop — exceptions surface via reconnect/log paths.
    this.agent.run().catch(() => {
      /* terminal — stop() ends the run loop cleanly */
    });

    this.emitStatus("starting");
  }

  // -------------------------------------------------------------------------
  // Outbound helper — used by messaging/outbound/send.ts.
  // -------------------------------------------------------------------------

  send(toHandle: string, text: string, conversationId?: string): string {
    if (this.status !== "ready") {
      throw new Error(`helloagent[${this.accountId}]: not ready (status=${this.status})`);
    }
    return this.agent.send(toHandle, text, conversationId);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  stop(): void {
    if (this.status === "stopped") return;
    try {
      this.agent.stop();
    } catch {
      /* swallow — agent may already be torn down */
    }
    this.status = "stopped";
    this.emitStatus("stopped");
    if (clients.get(this.accountId) === this) {
      clients.delete(this.accountId);
    }
  }

  private handleAuthFailed(err: AuthFailedError): void {
    this.status = "needs_repairing";
    this.detail = err.detail;
    this.emitStatus("needs_repairing", err.detail);
  }

  private async waitForHandle(): Promise<void> {
    const deadlineMs = 10_000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < deadlineMs) {
      if (this.agent.handle === this.account.handle) {
        if (this.status === "starting") {
          this.status = "ready";
          this.emitStatus("ready");
        }
        return;
      }
      if (this.status === "needs_repairing") {
        throw new Error(
          `helloagent[${this.accountId}]: pairing required: ${this.detail ?? "auth failed"}`,
        );
      }
      if (this.status === "stopped") {
        throw new Error(`helloagent[${this.accountId}]: stopped before ready`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`helloagent[${this.accountId}]: handle not resolved within ${deadlineMs}ms`);
  }

  private emitStatus(status: ClientStatus, detail?: string): void {
    log.info(`status: ${this.accountId} → ${status}${detail ? ` (${detail})` : ""}`);
    this.onStatus?.(this.accountId, status, detail);
  }
}

// ---------------------------------------------------------------------------
// Module-level registry — start/get/stop by accountId
// ---------------------------------------------------------------------------

export function startClient(opts: HaClientOptions): HaClient {
  const existing = clients.get(opts.account.accountId);
  if (existing) existing.stop();

  const client = new HaClient(opts);
  clients.set(opts.account.accountId, client);
  return client;
}

/** Returns the client iff it is `ready` — outbound callers should fail closed otherwise. */
export function getReadyClient(accountId: string): HaClient | undefined {
  const client = clients.get(accountId);
  if (!client || client.status !== "ready") return undefined;
  return client;
}

export function getClient(accountId: string): HaClient | undefined {
  return clients.get(accountId);
}

export function stopClient(accountId: string): void {
  const client = clients.get(accountId);
  if (!client) return;
  client.stop();
}

export function stopAllClients(): void {
  for (const client of [...clients.values()]) {
    client.stop();
  }
  clients.clear();
}

export function listClientIds(): string[] {
  return [...clients.keys()];
}
