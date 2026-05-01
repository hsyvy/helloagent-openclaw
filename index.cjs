"use strict";
/**
 * CJS entry shim — openclaw's gateway plugin loader resolves the entry via
 * `require()` synchronously. This file exposes the ESM plugin (./dist/index.js)
 * as a CJS module by leveraging Node's >=22.12 require-of-ESM support.
 *
 * Mirrors the published `@larksuite/openclaw-lark` shape: a CJS file at the
 * package root pointed at by `package.json.openclaw.extensions`. The actual
 * implementation stays in dist/ as ESM.
 */
const esm = require("./dist/index.js");

const plugin = esm.default;

// Plain CJS export — openclaw's loader reads `register` / `id` / `name` /
// `configSchema` from either module.exports or module.exports.default.
// Forwarding both shapes keeps it robust across loader versions.
module.exports = plugin;
module.exports.default = plugin;
module.exports.register = esm.register;
module.exports.id = esm.id;
module.exports.name = esm.name;
module.exports.description = esm.description;
module.exports.configSchema = esm.configSchema;
module.exports.helloAgentPlugin = esm.helloAgentPlugin;
module.exports.hasAnyHelloAgentAuth = esm.hasAnyHelloAgentAuth;
