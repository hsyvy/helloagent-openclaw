#!/usr/bin/env node
/**
 * Local dev helper: replace the npm-created symlink at
 * `node_modules/@helloagent/sdk` with a real copy of `../../sdk-ts`, and scrub
 * nested symlinks inside the copy.
 *
 * Why: before @helloagent/sdk is published, local development may install it
 * with `npm install --no-save --package-lock=false ../../sdk-ts`, which
 * materializes as a symlink. OpenClaw installs staged plugins with
 * `--ignore-scripts`, so this helper must be run manually before
 * `openclaw plugins install --link`. Copying the SDK in keeps the dependency
 * resolvable while satisfying the scanner.
 *
 * Two pitfalls we have to handle:
 *   1. The outer `@helloagent/sdk` itself is a symlink (handled by replacing
 *      it with a real copy of sdk-ts/).
 *   2. The copy still contains `node_modules/.bin/*` symlinks pointing to
 *      sibling dep binaries (acorn, tsc, etc.). Node's
 *      `fs.cpSync({ dereference: true })` does NOT follow those nested
 *      symlinks — it only dereferences the top-level entry — so we shell
 *      out to POSIX `cp -RL`, which follows ALL symlinks recursively.
 *
 * Idempotent: skips work when node_modules/@helloagent/sdk is already a
 * real directory (e.g. the user did this manually). Safe to re-run.
 */
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const target = join(pluginRoot, "node_modules", "@helloagent", "sdk");
const source = resolve(pluginRoot, "..", "..", "sdk-ts");

if (!existsSync(source)) {
  console.warn(`[dereference-sdk] sdk-ts not found at ${source}; skipping`);
  process.exit(0);
}

if (!existsSync(target)) {
  mkdirSync(dirname(target), { recursive: true });
} else {
  const stat = lstatSync(target);
  if (!stat.isSymbolicLink()) {
    process.exit(0);
  }
  rmSync(target, { recursive: true, force: true });
}

// `cp -RL` is the POSIX recipe for "copy following all symlinks recursively".
// Available on macOS, Linux, and any POSIX-y env. Windows users would need a
// different recipe; revisit if/when that case shows up.
const result = spawnSync("cp", ["-RL", `${source}/`, target], {
  stdio: "inherit",
});
if (result.status !== 0) {
  console.error(
    `[dereference-sdk] cp -RL failed (status ${result.status}); plugin install will likely be blocked by safety scanner`,
  );
  process.exit(result.status ?? 1);
}
console.log(`[dereference-sdk] copied ${source} -> ${target}`);
