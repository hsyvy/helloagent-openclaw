/**
 * `gateway.logoutAccount` adapter — invoked by OpenClaw when the user runs
 * `openclaw channels logout --channel helloagent [--account <id>]`.
 *
 * Behavior: stop the live WS session (if any) and delete the credentials
 * file from disk. Returns `{ cleared: true, loggedOut: true }`.
 */
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";

import { deleteCreds } from "../core/auth-store.js";
import { stopAccount } from "../channel/monitor.js";
import type { ResolvedHelloAgentAccount } from "../core/types.js";

type LogoutAccountFn = NonNullable<
  NonNullable<ChannelPlugin<ResolvedHelloAgentAccount>["gateway"]>["logoutAccount"]
>;
type LogoutCtx = Parameters<LogoutAccountFn>[0];
type LogoutResult = Awaited<ReturnType<LogoutAccountFn>>;

export async function logoutHelloAgent(ctx: LogoutCtx): Promise<LogoutResult> {
  const accountId = ctx.accountId;
  ctx.runtime.log(`[helloagent] logout: stopping session for ${accountId}`);
  await stopAccount(accountId);
  await deleteCreds(accountId);
  ctx.runtime.log(`[helloagent] logout: creds removed for ${accountId}`);
  return { cleared: true, loggedOut: true };
}
