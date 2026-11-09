const path = require("node:path");
const { base, startup, izPlan } = require("../common.cjs");
const manifest = require("./manifest.json"),
  menu = require("./menu.json");
function settings() {
  return {};
}
function plan(value = {}, options = {}) {
  const { host, node } = base(options),
    root = path.resolve(__dirname, "../..");
  const bootstrap = require("./transport.cjs").create({
    host,
    port: options.port ?? 39395,
  }).bootstrap;
  if (options.runtime !== "original")
    return izPlan({
      id: manifest.id,
      manifest,
      settings: {},
      options,
      bootstrap,
    });
  const server = path.join(__dirname, "server/host.cjs");
  const data = startup({
    root: __dirname,
    manifest,
    bootstrap: bootstrap.file,
    saveName: bootstrap.saveName,
    runRoot: path.join(root, "data/sessions"),
    persistent: true,
    readyPatterns: ["^Qualified native session ready\\.$"],
  });
  data.bootstrap.sourceSlot = 0;
  return {
    loaderId: manifest.id,
    mode: "original",
    runtime: "original",
    runner: "original-server",
    command: node,
    args: [server, host],
    cwd: root,
    startup: data,
    runRoot: data.runRoot,
    bootstrap: data.bootstrap,
    manualCommands: data.manualCommands,
    lifecycle: data.lifecycle,
    env: { HB_PORT: String(options.port ?? 39395), IZ2S_ROOT: root, IZ15_ROOT: root },
    capabilities: { izPackages: false, streaming: false },
    originalServer: server,
  };
}
module.exports = { manifest, menu, settings, plan };
module.exports.createEngine = (context) =>
  require("../../core/session-api.cjs").engine(module.exports, context);
