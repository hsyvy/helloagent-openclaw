/**
 * End-to-end verification that the auth-login fix works without requiring
 * a real device-code human-approval round-trip.
 *
 * Simulates exactly what `loginHelloAgent` does post-pair:
 *   1. Confirm cfg.channels.helloagent is absent (matches "fresh pair" state).
 *   2. Call `persistChannelEnabled` (extracted from auth-login.ts).
 *   3. Confirm cfg.channels.helloagent.enabled = true is now on disk.
 *   4. Confirm reading the cfg back yields the same shape openclaw expects.
 *
 * Intentionally targets ~/.openclaw-ha-test (set via OPENCLAW_STATE_DIR)
 * so we can manually inspect with `openclaw --profile ha-test channels list`
 * after this script runs.
 */
import { mergeHelloAgentAccountConfig, readCfg, resolveCfgPath } from "../src/core/cfg-store.js";

async function main(): Promise<void> {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? "(unset)";
  console.log(`[e2e] OPENCLAW_STATE_DIR=${stateDir}`);
  console.log(`[e2e] cfg path: ${resolveCfgPath()}`);

  const before = await readCfg();
  const beforeChannels = (before.channels as Record<string, unknown> | undefined) ?? {};
  console.log(
    `[e2e] BEFORE: channels.helloagent =`,
    JSON.stringify(beforeChannels.helloagent ?? null),
  );

  if (beforeChannels.helloagent != null) {
    console.log(
      "[e2e] WARNING: channels.helloagent already present; the fix would still work but the test is less interesting.",
    );
  }

  console.log("[e2e] simulating post-pair cfg write (mergeHelloAgentAccountConfig)...");
  const result = await mergeHelloAgentAccountConfig("default", { enabled: true });

  const afterChannels = (result.after.channels as Record<string, unknown> | undefined) ?? {};
  console.log(
    `[e2e] AFTER:  channels.helloagent =`,
    JSON.stringify(afterChannels.helloagent ?? null),
  );

  // Re-read from disk and verify it matches.
  const onDisk = await readCfg();
  const onDiskChannels = (onDisk.channels as Record<string, unknown> | undefined) ?? {};
  const onDiskHelloAgent = onDiskChannels.helloagent as { enabled?: boolean } | undefined;
  if (onDiskHelloAgent?.enabled === true) {
    console.log(`[e2e] ✅ cfg on disk now has channels.helloagent.enabled = true`);
  } else {
    console.error(`[e2e] ❌ cfg on disk does NOT have the expected entry`);
    console.error(`[e2e]    raw channels =`, JSON.stringify(onDiskChannels));
    process.exit(1);
  }

  // Verify other fields are preserved.
  const expectedKeys = Object.keys(before).filter((k) => k !== "channels");
  for (const k of expectedKeys) {
    if (JSON.stringify(onDisk[k]) !== JSON.stringify(before[k])) {
      console.error(`[e2e] ❌ unrelated field "${k}" was modified`);
      process.exit(1);
    }
  }
  console.log(`[e2e] ✅ unrelated cfg fields preserved (${expectedKeys.length})`);

  console.log("");
  console.log("[e2e] PASS — run `openclaw --profile ha-test channels list` to see the channel.");
}

main().catch((err) => {
  console.error("[e2e] FATAL:", err);
  process.exit(1);
});
