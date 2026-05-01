/**
 * Setup-phase entry for OpenClaw's channel installer.
 *
 * Kept intentionally narrow: setup only needs the channel plugin object so
 * OpenClaw can inspect metadata/config without registering CLI commands or
 * daemon gateway methods. The full register() lives in ./index.ts and
 * loads only when the gateway brings the channel up.
 */
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { helloAgentPlugin } from "./src/channel/plugin.js";

export const plugin = helloAgentPlugin;
export default defineSetupPluginEntry(helloAgentPlugin);
