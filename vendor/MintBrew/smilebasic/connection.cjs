const os = require('node:os'), net = require('node:net'), fs = require('node:fs');
const port = 39380;

// Interface names are all we get from Node. Classify the common Linux names so
// the operator can tell Wi-Fi from Ethernet, and keep obvious virtual adapters
// (Docker, VMs, VPNs) at the end of the list instead of hiding them.
function interfaceKind(name = '') {
  if (/^(docker|veth|virbr|vmnet|vboxnet|br-|tun|tap|wg|tailscale|zt|utun|awdl|llw|anpi)/i.test(name))
    return 'virtual';
  if (process.platform === 'linux') {
    try {
      if (fs.existsSync('/sys/class/net/' + name + '/wireless')) return 'Wi-Fi';
    } catch {}
  }
  if (/^(wl|wlan|wifi|ath|ra\d)/i.test(name)) return 'Wi-Fi';
  if (/^(wi-?fi|wireless)$/i.test(name)) return 'Wi-Fi';
  if (/^(eth|eno|enp|ens|enx|em\d|ethernet)/i.test(name)) return 'Ethernet';
  return 'LAN';
}

function describe(entry) {
  return `${entry.address} (${entry.interface}, ${entry.kind})`;
}

// Every non-loopback IPv4 address this computer currently owns. A console on
// the same LAN can only reach one of these; nothing here is hardcoded.
function addresses(interfaces = os.networkInterfaces()) {
  const list = [], seen = new Set();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if ((entry.family !== 'IPv4' && entry.family !== 4) || entry.internal ||
          entry.netmask === '255.255.255.255' ||
          entry.address.startsWith('169.254.') || seen.has(entry.address)) continue;
      seen.add(entry.address);
      list.push({address: entry.address, interface: name, kind: interfaceKind(name)});
    }
  }
  const rank = {Ethernet: 0, 'Wi-Fi': 1, LAN: 2, virtual: 3};
  return list.sort((a, b) =>
    rank[a.kind] - rank[b.kind] ||
    a.interface.localeCompare(b.interface) ||
    a.address.localeCompare(b.address));
}

async function chooseHost(args, interfaces = os.networkInterfaces(), options = {}) {
  if (args.length > 1 || args.length === 1 && !net.isIPv4(args[0]))
    throw Error('Usage: ./start.sh [computer-IP]  (or ./start.sh --list)');
  const choices = addresses(interfaces);
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY);
  if (args.length) {
    if (!choices.some(choice => choice.address === args[0]))
      throw Error(`${args[0]} is not assigned to this computer. ` +
        (choices.length ? 'Detected: ' + choices.map(describe).join(', ') :
          'Connect this computer to the console’s network first.'));
    return args[0];
  }
  if (!choices.length)
    throw Error('Connect this computer to the same Wi-Fi or Ethernet network as the Switch 2.');
  if (choices.length === 1) {
    console.log('Using computer address ' + describe(choices[0]) + '.');
    return choices[0].address;
  }
  if (!interactive)
    throw Error('Choose the computer address on the console’s network: ./start.sh IP\nDetected:\n' +
      choices.map((choice, index) => `  ${index + 1}. ${describe(choice)}`).join('\n'));
  choices.forEach((choice, index) => console.log(`  ${index + 1}. ${describe(choice)}`));
  const input = require('node:readline/promises').createInterface({input: process.stdin, output: process.stdout});
  try {
    const choice = await input.question('Which computer address can the Switch 2 reach? ');
    if (!/^[1-9][0-9]*$/.test(choice) || !choices[Number(choice) - 1])
      throw Error('Choose one of the listed addresses.');
    return choices[Number(choice) - 1].address;
  } finally {input.close();}
}

function connectCommand(host, token = [0, 0, 0, 0]) {
  return `V=START(${[port, ...host.split('.'), ...token].join(',')})`;
}

if (require.main === module) {
  if (process.argv[2] !== '--list') {
    console.error('Usage: node smilebasic/connection.cjs --list');
    process.exitCode = 1;
  } else {
    const choices = addresses();
    if (!choices.length) {
      console.error('No non-loopback IPv4 address found. Connect Wi-Fi or Ethernet.');
      process.exitCode = 1;
    } else choices.forEach(choice => console.log(describe(choice)));
  }
}

module.exports = {addresses, chooseHost, connectCommand, interfaceKind, describe};
