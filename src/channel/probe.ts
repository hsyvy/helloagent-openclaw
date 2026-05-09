/**
 * Health probe for the HelloAgent channel.
 *
 * The host's `status.probeAccount` calls this to decide whether the channel
 * is reachable for a given account.
 *
 * Strategy:
 *   - If a HaClient is registered and ready → ok=true (we know the WS is up).
 *   - If a HaClient is registered but `needs_repairing` → ok=false with the
 *     stored auth-failed detail.
 *   - Otherwise → run a one-shot REST hit against `<apiUrl>/healthz` (best-
 *     effort; tolerates 404 since not all relay deployments serve it).
 *
 * Returning ok=false here surfaces in the host's status panel as
 * "Needs attention" without crashing the daemon.
 */
import { getClient } from "../core/ha-client.js";
import type { ResolvedHelloAgentAccount } from "../core/types.js";

export type ProbeResult = {
  ok: boolean;
  detail?: string;
  /** Bound handle (if known) — handy for the status panel. */
  handle?: string;
  /** When the probe ran. */
  checkedAt: string;
};

export async function probeHelloAgent(
  account: ResolvedHelloAgentAccount,
): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString();

  // Live-client check — fastest path.
  const client = getClient(account.accountId);
  if (client) {
    if (client.status === "ready") {
      return { ok: true, handle: client.account.handle, checkedAt };
    }
    if (client.status === "needs_repairing") {
      return {
        ok: false,
        detail: `pairing required: ${client.detail ?? "auth failed"}`,
        checkedAt,
      };
    }
    if (client.status === "starting") {
      return { ok: false, detail: "still starting", checkedAt };
    }
  }

  // No live client — try REST healthz as a last resort.
  try {
    const res = await fetch(new URL("/healthz", account.apiUrl).toString(), {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      return { ok: true, detail: "relay reachable; no live session", checkedAt };
    }
    if (res.status === 404) {
      return {
        ok: true,
        detail: "relay reached (no /healthz endpoint); no live session",
        checkedAt,
      };
    }
    return {
      ok: false,
      detail: `relay /healthz returned ${res.status}`,
      checkedAt,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      checkedAt,
    };
  }
}
