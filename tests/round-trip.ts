/**
 * Standalone round-trip test — bypasses the openclaw gateway entirely.
 *
 * Why this exists: openclaw's foreground `gateway` command doesn't auto-load
 * external plugins from cfg.plugins.load.paths in the version we're running
 * against (loaded only the 7 stock plugins; helloagent never registered
 * into the in-memory channel registry → channels.start returned "invalid
 * channels.start channel"). Until we figure out the right openclaw boot
 * mode, we can still exercise the streaming-inbound dispatch end-to-end by
 * driving the SDK Agent directly.
 *
 * What this proves:
 *
 *   1. The paired creds on disk produce a working `Agent` connection to
 *      the live relay (auth handshake binds the handle).
 *   2. Inbound messages from a peer arrive via `Agent.onMessage`.
 *   3. Returning an `AsyncIterable<string>` from the handler streams
 *      chunks back to the peer (one StreamChunk per yield, plus a final
 *      `is_final=true` chunk). This is the same contract our plugin's
 *      `messaging/inbound/dispatch.ts:streamDispatch` relies on — if it
 *      works here, the plugin's queue+AsyncGenerator plumbing is sound.
 *   4. Pairing → live WebSocket → reply round-trip works against the
 *      local relay infrastructure.
 *
 * What this does NOT test:
 *   - The full openclaw assistant pipeline (no LLM call; just an echo).
 *   - The plugin's gateway adapter wiring (`gateway.startAccount`, etc.) —
 *     that needs the gateway to load us, which is the open issue.
 *   - The cfg-write fix (already proven by the pair log line).
 *
 * Run:
 *   cd integrations/openclaw-HelloAgent
 *   # 1. Make sure ha-test profile has paired creds (creds.json exists)
 *   ls $HOME/.openclaw-ha-test/credentials/helloagent/default/creds.json
 *
 *   # 2. Run this in foreground (or background) — listens forever
 *   npm run test:round-trip
 *
 *   # 3. From another terminal, send a peer message:
 *   echo "hello, are you streaming?" | python3 ../../examples/cli_user.py tester test/jarvis-rt2
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { Agent, type IncomingMessage } from "@helloagentai/sdk";

import type { HelloAgentCreds } from "../src/core/auth-store.js";

// ---------------------------------------------------------------------------
// Resolve creds path
// ---------------------------------------------------------------------------

function resolveCredsPath(): string {
  const explicit = process.env.HELLOAGENT_CREDS_PATH?.trim();
  if (explicit) return explicit;
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw-ha-test");
  return path.join(stateDir, "credentials", "helloagent", "default", "creds.json");
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString().substring(11, 23);
}

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${ts()}] ${line}`);
}

// ---------------------------------------------------------------------------
// Streaming reply handler — yields 3 chunks ~500ms apart so we can SEE the
// streaming working on the peer side (cli_user.py prints stream_chunk bodies
// without newlines until is_final).
// ---------------------------------------------------------------------------

async function* streamingReply(
  msg: IncomingMessage,
  selfHandle: string,
): AsyncGenerator<string, void, unknown> {
  yield `Echo from @${selfHandle} — chunk 1/3 of "${msg.text}"\n`;
  await new Promise((r) => setTimeout(r, 600));

  yield `\nChunk 2/3 — proving streaming-inbound dispatch works ` +
    `(3 chunks, ~600ms apart).\n`;
  await new Promise((r) => setTimeout(r, 600));

  const arrivedAt = new Date().toISOString();
  yield `\nChunk 3/3 — round-trip OK. Inbound length=${msg.text.length} chars. ` +
    `Replied at ${arrivedAt}.`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const credsPath = resolveCredsPath();
  log(`[round-trip] reading creds from ${credsPath}`);

  let creds: HelloAgentCreds;
  try {
    creds = JSON.parse(await readFile(credsPath, "utf-8")) as HelloAgentCreds;
  } catch (err) {
    log(
      `[round-trip] FATAL: could not read creds at ${credsPath}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    log(
      `[round-trip] hint: pair first with ` +
        `\`HELLOAGENT_API_URL=http://localhost:8080 HELLOAGENT_PAIR_MODE=device ` +
        `npx openclaw --profile ha-test channels login --channel helloagent\``,
    );
    process.exit(1);
  }

  log(`[round-trip] handle=${creds.handle}  relay=${creds.relayWs}`);

  let messageCount = 0;
  const exitAfterMessages = parseInt(process.env.EXIT_AFTER_MESSAGES ?? "1", 10);

  const agent = new Agent({
    token: creds.token,
    relayUrl: creds.relayWs,
    onAuthFailed: (err) => {
      log(`[round-trip] AUTH FAILED: ${err.detail}`);
      process.exit(2);
    },
  });

  agent.onMessage((msg) => {
    messageCount += 1;
    log(`← inbound #${messageCount} from ${msg.fromHandle}: "${msg.text}"`);
    log(`→ streaming 3 chunks back...`);

    // Schedule a teardown a few seconds after the last expected reply
    // chunk completes, so the harness exits cleanly when the test passes.
    if (messageCount >= exitAfterMessages) {
      setTimeout(() => {
        log(`[round-trip] ✅ ${messageCount} message(s) handled — shutting down`);
        agent.stop();
        process.exit(0);
      }, 4000);
    }

    return streamingReply(msg, creds.handle);
  });

  log(`[round-trip] connecting to relay...`);
  log(
    `[round-trip] from another terminal, send a peer message:\n` +
      `    echo "hello, are you streaming?" | python3 ` +
      path.resolve(import.meta.dirname, "../../../examples/cli_user.py") +
      ` tester ${creds.handle}`,
  );

  // Run forever (until process.exit above).
  await agent.run();
}

main().catch((err) => {
  log(`[round-trip] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
