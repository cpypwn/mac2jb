const connection = require("./server/lib/connection.cjs");
const { NativeClient } = require("./server/lib/native.cjs");
const { qualify } = require("./server/lib/qualify.cjs");
const { plan } = require("./server/install.cjs");
const { connectCommand } = require("./server/lib/network.cjs");
const net = require("node:net");
function create({ host, port = 39395 } = {}) {
  if (
    !net.isIPv4(host || "") ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw Error("Expected reachable IPv4 address and port");
  const token = connection.pairingCode(),
    installation = plan();
  return {
    id: "izmysh",
    rpcClient: require("node:path").join(__dirname, "server/lib/rpc.cjs"),
    command: connectCommand(host, token, port),
    protocol: 1,
    resumable: false,
    bootstrap: {
      file: installation.file,
      saveName: installation.saveName,
      arity: installation.arity,
      loaderId: "izmysh",
      recovery: false,
    },
    listen: (options) => connection.listen({ ...options, host, port, token }),
    native: (connected) =>
      new NativeClient(connected.connection, connected.addresses),
    qualify,
  };
}
module.exports = { create };
