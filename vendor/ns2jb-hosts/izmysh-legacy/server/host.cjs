#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { chooseHost, connectCommand } = require("./lib/network.cjs");
const { listen, pairingCode } = require("./lib/connection.cjs");
const { NativeClient } = require("./lib/native.cjs");
const { qualify } = require("./lib/qualify.cjs");
const { serve } = require("./lib/bridge.cjs");
const { plan } = require("./install.cjs");

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "IZMYSH server\nUsage: node server/host.cjs [computer-IPv4]\nHB_PORT: console TCP port (default 39395).\nNo console shell or input device is started by this server.",
    );
    return;
  }
  const host = await chooseHost(args),
    port = Number(process.env.HB_PORT || 39395);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("Port must be 1024..65535");
  const bootstrap = plan(),
    token = pairingCode(),
    command = connectCommand(host, token, port);
  const workspace =
    process.env.IZ_SESSION_DIR ||
    ((process.env.IZ2S_ROOT || process.env.IZ15_ROOT)
      ? path.join(process.env.IZ2S_ROOT || process.env.IZ15_ROOT, "data/sessions")
      : path.resolve(__dirname, "../data/sessions"));
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(workspace, "server-"));
  const record = {
    started: new Date().toISOString(),
    engine: "izmysh",
    protocol: 1,
  };
  const cancellation = new AbortController();
  let native,
    bridge,
    connected,
    stopping = false;
  const stop = () => {
    stopping = true;
    cancellation.abort();
    connected?.connection.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await fs.writeFile(path.join(directory, "connect.txt"), command + "\n", {
      mode: 0o600,
    });
    connected = await listen({
      host,
      port,
      token,
      signal: cancellation.signal,
      onRejected: console.error,
      onWaiting() {
        console.log("Console listener ready at " + host + ":" + port + ".");
        console.log(
          "  " + bootstrap.load + "\n  RUN\n  REMOVE NSR,&H60000000,&H3FFFFFFF",
        );
        console.log(
          "After the expected Out of memory message, enter:\n  " + command,
        );
        console.log("Run folder: " + directory);
      },
    });
    native = new NativeClient(connected.connection, connected.addresses);
    record.qualification = await qualify(native);
    connected.connection.timeout = 120000;
    bridge = await serve(native, directory);
    bridge.keepAwake(record.qualification.activity);
    await fs.mkdir(path.join(directory, "shared"));
    await fs.copyFile(
      path.join(__dirname, "lib/rpc.cjs"),
      path.join(directory, "shared/rpc.cjs"),
    );
    await fs.writeFile(
      path.join(directory, "connection.json"),
      JSON.stringify({
        port: bridge.port,
        token: bridge.token,
        addresses: {
          ...native.addresses,
          session: path.basename(directory),
          target: "switch2",
        },
      }),
      { mode: 0o600 },
    );
    console.log("Qualified native session ready.");
    await new Promise((resolve) => {
      const socket = connected.connection.socket;
      socket.once("close", resolve);
      if (socket.destroyed || connected.connection.error) resolve();
    });
    if (native.connection.error && !stopping)
      record.disconnect = native.connection.error.message;
  } catch (error) {
    if (!stopping) {
      record.error = error.stack;
      throw error;
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      await bridge?.close();
    } finally {
      await native?.stop();
      connected?.connection.close();
      record.completed = new Date().toISOString();
      await fs.writeFile(
        path.join(directory, "result.json"),
        JSON.stringify(record, null, 2),
        { mode: 0o600 },
      );
    }
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
module.exports = { main };
