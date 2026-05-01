/**
 * Persisted-auth presence probe. OpenClaw calls this to decide whether to
 * surface "Needs pairing" vs "Linked" in the channel status panel.
 *
 * Reads ~/.openclaw/credentials/helloagent/<accountId>/creds.json — present
 * for any accountId means "linked". Override the auth dir via
 * HELLOAGENT_AUTH_DIR / OPENCLAW_OAUTH_DIR / OPENCLAW_STATE_DIR (in that
 * order of precedence; see core/auth-store.ts).
 */
import { listLinkedAccountIds } from "../core/auth-store.js";

export async function hasAnyHelloAgentAuth(): Promise<boolean> {
  const ids = await listLinkedAccountIds();
  return ids.length > 0;
}
