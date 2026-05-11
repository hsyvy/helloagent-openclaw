/**
 * Headless pairing flow for machines where the OpenClaw daemon cannot open a
 * local browser. The daemon prints a short code; the user signs into
 * HelloAgent on any browser, approves the code, and this process polls until
 * it receives a scoped channel-link token.
 */
import {
  HelloAgentApiError,
  linkChannel,
  oauthPollDeviceToken,
  oauthStartDeviceAuthorization,
} from "@helloagentai/sdk";

import {
  CREDS_VERSION,
  DEFAULT_ACCOUNT_ID,
  type HelloAgentCreds,
  writeCreds,
} from "../core/auth-store.js";

export type DevicePairOptions = {
  agentName: string;
  clientId: string;
  apiUrl: string;
  accountId?: string;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export async function pairHelloAgentWithDeviceCode(
  opts: DevicePairOptions,
): Promise<HelloAgentCreds> {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const log = opts.onProgress ?? ((s: string) => console.log(s));

  const device = await oauthStartDeviceAuthorization({
    clientId: opts.clientId,
    apiUrl: opts.apiUrl,
  });

  log(`[helloagent] open ${device.verification_uri}`);
  log(`[helloagent] enter code: ${device.user_code}`);

  const deadline = Date.now() + Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, device.expires_in * 1000);
  const intervalMs = Math.max(device.interval, 1) * 1000;
  let accessToken = "";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const tokenResp = await oauthPollDeviceToken({
        clientId: opts.clientId,
        deviceCode: device.device_code,
        apiUrl: opts.apiUrl,
      });
      accessToken = tokenResp.access_token;
      break;
    } catch (e) {
      if (e instanceof HelloAgentApiError && e.code === "authorization_pending") {
        continue;
      }
      throw e;
    }
  }

  if (!accessToken) {
    throw new Error("helloagent: device authorization timed out");
  }

  const linkResp = await linkChannel({
    provider: "openclaw",
    token: accessToken,
    agentName: opts.agentName,
    apiUrl: opts.apiUrl,
  });

  const creds: HelloAgentCreds = {
    version: CREDS_VERSION,
    handle: linkResp.handle,
    agentName: linkResp.agent_name,
    ownerHandle: linkResp.user_handle,
    token: linkResp.token,
    apiUrl: opts.apiUrl,
    relayWs: linkResp.relay_ws,
    linkedAt: new Date().toISOString(),
    source: "device",
  };
  await writeCreds(creds, accountId);
  return creds;
}
