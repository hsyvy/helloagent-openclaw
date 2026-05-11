/**
 * `auth.login` adapter for the HelloAgent channel — invoked by OpenClaw when
 * the user runs `openclaw channels login --channel helloagent`.
 *
 * Default mode is **import** (method 1: paste an existing ha_* token). Other
 * pairing modes stay reachable via the `HELLOAGENT_PAIR_MODE` env var:
 *
 *   HELLOAGENT_PAIR_MODE=import     (default) paste an existing ha_* token
 *   HELLOAGENT_PAIR_MODE=oauth      browser OAuth + PKCE (method 2)
 *   HELLOAGENT_PAIR_MODE=device     device-code flow (headless)
 *
 * Persistence is handled inside the pairing helpers (writeCreds → disk).
 * The host's `reconcileGatewayRuntimeAfterLocalLogin` fires `channels.start`
 * automatically once we resolve.
 */
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";

import { importHelloAgentToken } from "../auth/import-token.js";
import { pairHelloAgentWithDeviceCode } from "../auth/login-device.js";
import { pairHelloAgent } from "../auth/login.js";
import { readCreds } from "../core/auth-store.js";
import { mergeHelloAgentAccountConfig } from "../core/cfg-store.js";
import type { ResolvedHelloAgentAccount } from "../core/types.js";

type LoginFn = NonNullable<
  NonNullable<ChannelPlugin<ResolvedHelloAgentAccount>["auth"]>["login"]
>;
type LoginParams = Parameters<LoginFn>[0];
type RuntimeEnv = LoginParams["runtime"];

const DEFAULT_API_URL = "https://api.helloagent.cc";
const DEFAULT_WEB_URL = "https://app.helloagent.cc";
const DEFAULT_RELAY_WS = "wss://api.helloagent.cc/v1/ws";
const DEFAULT_CLIENT_ID = "openclaw";
const DEFAULT_AGENT_NAME = "jarvis";

type PairMode = "oauth" | "device" | "import";

function envOr(key: string, fallback: string): string {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : fallback;
}

function resolvePairMode(): PairMode {
  const raw = process.env.HELLOAGENT_PAIR_MODE?.trim().toLowerCase();
  if (raw === "oauth" || raw === "device" || raw === "import") return raw;
  if (raw) {
    throw new Error(
      `helloagent: unknown HELLOAGENT_PAIR_MODE=${JSON.stringify(raw)} (expected import|oauth|device)`,
    );
  }
  // Method 1 first: paste an existing ha_* token. OAuth (method 2) is opt-in
  // until we wire that up with browser auto-open.
  return "import";
}

/** Build the URL we point the user at to create a new agent + grab its ha_* token. */
function tokenIssueUrl(webUrl: string): string {
  // Trailing slashes folded; web app exposes /app/agents/new for the
  // create-agent flow that prints the one-time ha_* token.
  return `${webUrl.replace(/\/+$/, "")}/app/agents/new`;
}

async function readTokenFromStdin(
  runtime: RuntimeEnv,
  hint: { issueUrl: string },
): Promise<string> {
  if (!input.isTTY) {
    // Piped: still print the URL so users running `echo $TOKEN | openclaw …`
    // know where it should have come from in case of paste mistakes.
    runtime.log(`[helloagent] expecting an ha_* token on stdin`);
    runtime.log(`[helloagent] (create one at ${hint.issueUrl})`);
    let buf = "";
    for await (const chunk of input) buf += chunk;
    const token = buf.trim();
    if (!token) {
      throw new Error("helloagent: no token received on stdin");
    }
    return token;
  }
  const rl = createInterface({ input, output });
  try {
    runtime.log("");
    runtime.log("Link this assistant to a HelloAgent account:");
    runtime.log("");
    runtime.log(`  1. Open ${hint.issueUrl}`);
    runtime.log("  2. Create an agent and copy its token (starts with \"ha_\")");
    runtime.log("  3. Paste the token below");
    runtime.log("");
    const token = (await rl.question("Token: ")).trim();
    if (!token) throw new Error("helloagent: empty token");
    return token;
  } finally {
    rl.close();
  }
}

export async function loginHelloAgent(params: LoginParams): Promise<void> {
  const accountId = params.accountId?.trim() || "default";
  const runtime = params.runtime;
  const log = (line: string) => runtime.log(line);

  // For URLs we resolve in this order: env override → existing creds on disk
  // (so re-pairing against a local relay doesn't suddenly hit prod) → bake-in
  // defaults. The existing-creds tier matters when the user already paired
  // once (e.g. against http://localhost:8080) and wants to refresh the token.
  const existing = await readCreds(accountId).catch(() => null);
  const apiUrl = envOr("HELLOAGENT_API_URL", existing?.apiUrl ?? DEFAULT_API_URL);
  const webUrl = envOr("HELLOAGENT_WEB_URL", DEFAULT_WEB_URL);
  const relayWs = envOr("HELLOAGENT_RELAY_WS_URL", existing?.relayWs ?? DEFAULT_RELAY_WS);
  const clientId = envOr("HELLOAGENT_OAUTH_CLIENT_ID", DEFAULT_CLIENT_ID);
  const agentName = envOr("HELLOAGENT_AGENT_NAME", DEFAULT_AGENT_NAME);
  const mode = resolvePairMode();

  if (mode === "oauth") {
    const creds = await pairHelloAgent({
      agentName,
      clientId,
      apiUrl,
      webUrl,
      accountId,
      onProgress: log,
    });
    await persistChannelEnabled(accountId, log);
    log(`Linked as @${creds.handle}.`);
    return;
  }

  if (mode === "device") {
    const creds = await pairHelloAgentWithDeviceCode({
      agentName,
      clientId,
      apiUrl,
      accountId,
      onProgress: log,
    });
    await persistChannelEnabled(accountId, log);
    log(`Linked as @${creds.handle}.`);
    return;
  }

  // mode === "import" (manual token paste).
  const token = await readTokenFromStdin(runtime, { issueUrl: tokenIssueUrl(webUrl) });
  const creds = await importHelloAgentToken({
    token,
    apiUrl,
    relayWs,
    accountId,
  });
  await persistChannelEnabled(accountId, log);
  log(`Linked as @${creds.handle}.`);
}

/**
 * Write `cfg.channels.helloagent.enabled = true` (or
 * `cfg.channels.helloagent.accounts.<id>.enabled = true` for named accounts)
 * to the OpenClaw config file.
 *
 * Best-effort: a write failure here doesn't fail the pair (creds are already
 * on disk), but the user will need to run `openclaw config set
 * channels.helloagent.enabled true` manually before `channels list` shows
 * the channel.
 */
async function persistChannelEnabled(
  accountId: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await mergeHelloAgentAccountConfig(accountId, { enabled: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(
      `Warning: could not update cfg automatically (${msg}). ` +
        `Pairing succeeded; run \`openclaw config set channels.helloagent.enabled true\` to make the channel visible.`,
    );
  }
}
