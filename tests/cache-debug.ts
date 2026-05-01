/**
 * One-off debug: with OPENCLAW_STATE_DIR set the way --profile sets it,
 * what does our account-cache see, AND what does helloAgentPlugin.config.listAccountIds
 * (which `channels list` calls) return?
 */
import * as accountCache from "../src/core/account-cache.js";
import { resolveHelloAgentAuthDir } from "../src/core/auth-store.js";
import { helloAgentPlugin } from "../src/channel/plugin.js";

console.log("env OPENCLAW_STATE_DIR =", process.env.OPENCLAW_STATE_DIR ?? "(unset)");
console.log("env OPENCLAW_PROFILE   =", process.env.OPENCLAW_PROFILE ?? "(unset)");
console.log("env HELLOAGENT_AUTH_DIR=", process.env.HELLOAGENT_AUTH_DIR ?? "(unset)");
console.log("resolveHelloAgentAuthDir →", resolveHelloAgentAuthDir());

console.log("\n--- accountCache direct ---");
accountCache.init();
const cacheIds = accountCache.listAccountIds();
console.log("accountCache.listAccountIds →", cacheIds);

console.log("\n--- helloAgentPlugin.config.listAccountIds (what `channels list` calls) ---");
const cfgEmpty = {};
const ids = helloAgentPlugin.config!.listAccountIds!(cfgEmpty as never);
console.log(`with cfg={}: → ${JSON.stringify(ids)}`);

const cfgWithChannel = { channels: { helloagent: { enabled: true } } };
const idsWithChannel = helloAgentPlugin.config!.listAccountIds!(cfgWithChannel as never);
console.log(`with cfg.channels.helloagent={enabled:true}: → ${JSON.stringify(idsWithChannel)}`);

console.log("\n--- inspectAccount ---");
const insp = helloAgentPlugin.config!.inspectAccount!(cfgEmpty as never, "default");
console.log("inspectAccount(cfg={}, 'default') →", insp);

console.log("\n--- resolveAccount ---");
try {
  const acc = helloAgentPlugin.config!.resolveAccount(cfgEmpty as never, "default");
  console.log("resolveAccount → handle:", acc.handle);
} catch (err) {
  console.log("resolveAccount threw:", (err as Error).message);
}
