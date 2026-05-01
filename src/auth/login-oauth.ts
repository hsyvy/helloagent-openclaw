/**
 * OAuth code exchange + channel link + persistence. Takes the authorization
 * code captured by the loopback server (./login.ts), trades it for a scoped
 * access token, calls /v1/channels/openclaw/link, and persists the returned
 * ha_* token to disk.
 */
import {
  HelloAgentApiError,
  linkChannel,
  oauthExchangeToken,
} from "@helloagent/sdk";

import {
  CREDS_VERSION,
  DEFAULT_ACCOUNT_ID,
  type HelloAgentCreds,
  writeCreds,
} from "../core/auth-store.js";

export type ExchangeAndPersistOptions = {
  code: string;
  agentName: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier?: string;
  redirectUri: string;
  apiUrl: string;
  accountId?: string;
};

export async function exchangeAndPersist(
  opts: ExchangeAndPersistOptions,
): Promise<HelloAgentCreds> {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;

  const tokenResp = await oauthExchangeToken({
    code: opts.code,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    codeVerifier: opts.codeVerifier,
    redirectUri: opts.redirectUri,
    apiUrl: opts.apiUrl,
  });

  const linkResp = await linkChannel({
    provider: "openclaw",
    token: tokenResp.access_token,
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
    source: "oauth",
  };
  await writeCreds(creds, accountId);
  return creds;
}

export { HelloAgentApiError };
