/**
 * Manual fallback for advanced/headless users: paste an existing HelloAgent
 * ha_* agent token, validate it by completing one WebSocket auth handshake,
 * then persist it under OpenClaw's HelloAgent credential directory.
 */
import { Agent, AuthFailedError } from "@helloagent/sdk";

import {
  CREDS_VERSION,
  DEFAULT_ACCOUNT_ID,
  type HelloAgentCreds,
  writeCreds,
} from "../core/auth-store.js";

export type ImportTokenOptions = {
  token: string;
  apiUrl: string;
  relayWs: string;
  accountId?: string;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
};

export async function importHelloAgentToken(
  opts: ImportTokenOptions,
): Promise<HelloAgentCreds> {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const log = opts.onProgress ?? ((s: string) => console.log(s));
  const handle = await resolveAgentHandleFromToken(opts.token, opts.relayWs, opts.timeoutMs);
  const { ownerHandle, agentName } = splitHandle(handle);

  const creds: HelloAgentCreds = {
    version: CREDS_VERSION,
    handle,
    agentName,
    ownerHandle,
    token: opts.token,
    apiUrl: opts.apiUrl,
    relayWs: opts.relayWs,
    linkedAt: new Date().toISOString(),
    source: "manual",
  };
  await writeCreds(creds, accountId);
  log(`[helloagent] imported token for @${creds.handle}`);
  return creds;
}

async function resolveAgentHandleFromToken(
  token: string,
  relayWs: string,
  timeoutMs = 30_000,
): Promise<string> {
  if (!token.startsWith("ha_")) {
    throw new Error("helloagent: expected an ha_* agent token");
  }

  let authFailure: AuthFailedError | undefined;
  const debug = process.env.HELLOAGENT_DEBUG_IMPORT === "1";
  const dbg = (m: string) => { if (debug) process.stderr.write(`[import-token] ${m}\n`); };
  dbg(`creating Agent (relay=${relayWs})`);
  const agent = new Agent({
    token,
    relayUrl: relayWs,
    reconnect: { initialMs: 100, maxMs: 100 },
    logger: debug
      ? {
          info: (...a) => process.stderr.write(`[sdk-info] ${a.join(" ")}\n`),
          warn: (...a) => process.stderr.write(`[sdk-warn] ${a.join(" ")}\n`),
          error: (...a) => process.stderr.write(`[sdk-err] ${a.join(" ")}\n`),
        }
      : { warn: () => undefined, error: () => undefined },
    onAuthFailed: (err) => {
      authFailure = err;
      dbg(`onAuthFailed: ${err.detail}`);
    },
  });
  dbg(`calling agent.run()`);
  const run = agent.run();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (agent.handle) {
        dbg(`got handle=${agent.handle} after ${Date.now() - (deadline - timeoutMs)}ms`);
        return agent.handle;
      }
      if (authFailure) {
        throw new Error(`helloagent: token rejected by relay: ${authFailure.detail}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    dbg(`TIMEOUT — handle=${agent.handle ?? "(unset)"} authFailure=${authFailure?.detail ?? "(none)"}`);
    throw new Error("helloagent: token validation timed out");
  } finally {
    agent.stop();
    await Promise.race([
      run.catch(() => undefined),
      new Promise((r) => setTimeout(r, 250)),
    ]);
  }
}

function splitHandle(handle: string): { ownerHandle: string; agentName: string } {
  const idx = handle.indexOf("/");
  if (idx < 0) {
    return { ownerHandle: "", agentName: handle };
  }
  return {
    ownerHandle: handle.slice(0, idx),
    agentName: handle.slice(idx + 1),
  };
}
