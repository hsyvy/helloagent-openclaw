/**
 * Plugin-load test — drives the real `openclaw` CLI (from the plugin's
 * devDependencies) to install our plugin into an isolated profile, then
 * asserts via `openclaw plugins inspect` and `plugins doctor` that the
 * plugin loaded cleanly, the channel registered, and there are no
 * load-time errors.
 *
 * This catches the kind of regression the typecheck + unit smoke can't:
 *
 *   - Missing manifest fields (channelConfigs, channels)
 *   - Wrong entry pattern (defineBundledChannelEntry vs plain register)
 *   - Missing register/activate exports
 *   - Manifest/code drift (e.g. plugin id mismatch)
 *   - SDK-version drift in adapter type names
 *
 * Workarounds applied — same as the existing
 * `examples/openclaw_plugin_load_test.ts`:
 *
 *   - The plugin's `@helloagent/sdk` dep is `file:../../sdk-ts` which npm
 *     symlinks. OpenClaw's safety scanner refuses to install plugins whose
 *     node_modules contain symlinks pointing outside the plugin root, so
 *     we materialise a real copy of sdk-ts into node_modules/@helloagent/sdk
 *     for the duration of the test, then restore the symlink at the end.
 *   - `auth/login.ts` uses child_process.spawn() to launch the user's
 *     browser; OpenClaw flags this as dangerous. We pass
 *     --dangerously-force-unsafe-install. (For a real release, the spawn
 *     would either be moved behind an opt-in or signed.)
 *
 * Run:
 *   cd integrations/openclaw-HelloAgent
 *   npm run test:load
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_DIR = path.resolve(import.meta.dirname, "..");
const SDK_DIR = path.resolve(PLUGIN_DIR, "../../sdk-ts");
const OPENCLAW_BIN = path.join(PLUGIN_DIR, "node_modules", ".bin", "openclaw");
const SDK_SHIM_DIR = path.join(PLUGIN_DIR, "node_modules", "@helloagent");

function rand(n = 6): string {
  return Math.random().toString(16).slice(2, 2 + n);
}

function oc(profile: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  // Generous timeout — first run on a fresh profile does heavy jiti TS
  // resolution. ~30-60s cold cache is normal.
  const res = spawnSync(OPENCLAW_BIN, ["--profile", profile, ...args], {
    cwd: PLUGIN_DIR,
    encoding: "utf-8",
    timeout: 180_000,
    env: { ...process.env, OPENCLAW_PLUGIN_LOAD_DEBUG: "1" },
  });
  if (res.error) {
    return { ok: false, stdout: res.stdout ?? "", stderr: `[spawn error] ${res.error.message}` };
  }
  if (res.signal) {
    return { ok: false, stdout: res.stdout ?? "", stderr: `[killed by ${res.signal}] ${res.stderr ?? ""}` };
  }
  return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function materialiseSdkCopy(): void {
  if (!existsSync(path.join(SDK_DIR, "dist"))) {
    throw new Error(
      `sdk-ts/dist not found at ${SDK_DIR} — run 'cd sdk-ts && npm run build' before this test`,
    );
  }
  rmSync(SDK_SHIM_DIR, { recursive: true, force: true });
  mkdirSync(SDK_SHIM_DIR, { recursive: true });
  // Copy with symlinks dereferenced so node_modules/@helloagent/sdk is a
  // real directory, not a symlink crossing the plugin root.
  cpSync(SDK_DIR, path.join(SDK_SHIM_DIR, "sdk"), {
    recursive: true,
    dereference: true,
    filter: (src) => !src.includes("/node_modules"),
  });
}

function restoreSymlink(): void {
  rmSync(SDK_SHIM_DIR, { recursive: true, force: true });
  const res = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: PLUGIN_DIR,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (res.status !== 0) {
    console.warn("[load-test] npm install (restore) failed:", res.stderr);
  }
}

function cleanupProfile(profile: string): void {
  const dir = path.join(os.homedir(), `.openclaw-${profile}`);
  rmSync(dir, { recursive: true, force: true });
}

function main(): void {
  if (!existsSync(OPENCLAW_BIN)) {
    throw new Error(
      `openclaw CLI not found at ${OPENCLAW_BIN} — run 'npm install' inside ${PLUGIN_DIR} first`,
    );
  }

  const profile = `ha-new-load-${rand()}`;
  console.log(`[load-test] profile=${profile} plugin=${PLUGIN_DIR}`);

  materialiseSdkCopy();
  let testFailed = false;
  try {
    // ---- install ----
    const install = oc(profile, [
      "plugins",
      "install",
      "--link",
      "--dangerously-force-unsafe-install",
      PLUGIN_DIR,
    ]);
    if (!install.ok) {
      console.error("[load-test] install stdout:\n" + install.stdout);
      console.error("[load-test] install stderr:\n" + install.stderr);
      throw new Error("openclaw plugins install failed");
    }
    if (!install.stdout.includes("Linked plugin path")) {
      throw new Error(`install did not link the plugin: ${install.stdout}`);
    }
    console.log(`[load-test] install OK (plugin linked)`);

    // ---- inspect ----
    const inspect = oc(profile, ["plugins", "inspect", "helloagent", "--json"]);
    if (!inspect.ok) {
      console.error(inspect.stderr);
      throw new Error("openclaw plugins inspect failed");
    }
    const parsed = JSON.parse(inspect.stdout) as { plugin: Record<string, unknown> };
    const p = parsed.plugin;

    if (p.id !== "helloagent") throw new Error(`bad id: ${p.id}`);
    if (p.status !== "loaded") {
      throw new Error(`expected status=loaded, got status=${p.status} error=${p.error ?? ""}`);
    }
    if (p.activated !== true) throw new Error(`expected activated=true, got ${p.activated}`);
    if (p.error !== null && p.error !== undefined) {
      throw new Error(`unexpected error field: ${p.error}`);
    }
    const channelIds = (p.channelIds ?? []) as string[];
    if (!channelIds.includes("helloagent")) {
      throw new Error(`channelIds missing helloagent: ${JSON.stringify(channelIds)}`);
    }
    console.log(`[load-test] inspect OK: status=${p.status} channelIds=${JSON.stringify(channelIds)}`);

    // ---- doctor: should report no plugin issues for OUR plugin ----
    //
    // openclaw bundles other extensions (memory-core, etc.) that may have
    // their own environment/dep issues unrelated to ours. We only care
    // whether `helloagent` is in the failure list. The doctor output
    // formats failures as either:
    //
    //   Plugin errors:
    //   - <plugin-id> [<phase>]: ...
    //
    // or:
    //
    //   [plugins] <plugin-id> failed to load from <path>: ...
    //
    // so we look for those exact patterns scoped to "helloagent".
    const doctor = oc(profile, ["plugins", "doctor"]);
    if (!doctor.ok) {
      // Doctor exiting non-zero just means *some* plugin is unhealthy in
      // this profile. We still want to verify ours specifically; only
      // throw if its stderr is empty (truly nothing to inspect).
      if (!doctor.stdout && !doctor.stderr) {
        throw new Error(`plugins doctor failed with no output`);
      }
    }
    const doctorOut = doctor.stdout + "\n" + doctor.stderr;
    const ourErrorPatterns = [
      /^\s*-\s+helloagent\s+\[/m, // "- helloagent [load]: ..." in Plugin errors
      /\[plugins\]\s+helloagent\s+failed/i, // "[plugins] helloagent failed to load ..."
      /^\s*-\s+helloagent:\s+failed/im, // "- helloagent: failed to load plugin: ..."
    ];
    const matchedFailure = ourErrorPatterns.find((re) => re.test(doctorOut));
    if (matchedFailure) {
      throw new Error(
        `doctor reports issues for helloagent (matched ${matchedFailure}):\n${doctor.stdout}\n${doctor.stderr}`,
      );
    }

    // Surface any environment-level issues so the operator knows about
    // them, but don't fail the test on them.
    if (!doctor.ok) {
      const otherErrors = doctorOut.match(/^\s*-\s+\S+\s+\[\w+\]:.*/gm) ?? [];
      if (otherErrors.length > 0) {
        console.log(
          `[load-test] doctor reports unrelated plugin issues (not ours):\n${otherErrors.map((l) => "    " + l).join("\n")}`,
        );
      }
    }
    console.log(`[load-test] doctor OK (no issues for helloagent)`);

    console.log("PASS openclaw plugin load");
  } catch (e) {
    testFailed = true;
    throw e;
  } finally {
    cleanupProfile(profile);
    restoreSymlink();
    if (!testFailed) console.log(`[load-test] cleaned up profile + restored symlink`);
  }
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
