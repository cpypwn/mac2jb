const fs = require('node:fs/promises');
const path = require('node:path');
const {client, live} = require('./rpc.cjs');
const {loadTarget} = require('../../shared/target.cjs');
const target = loadTarget();

async function scan(rpc, maxRegions = target.memoryMap.maxRegions) {
  const regions = [];
  for (let address = 0; address < 2 ** 39;) {
    if (regions.length >= maxRegions) throw Error('Application memory map exceeded its bound');
    const region = await rpc.query(address);
    const next = region.address + region.size;
    if (region.result || region.address > address || !Number.isSafeInteger(next) || next <= address)
      throw Error('Application memory map is incomplete or changed during the scan');
    regions.push(region); address = next;
  }
  return regions;
}

async function main() {
  const rpc = await client();
  let regions, lastError;
  for (let attempt = 1; attempt <= target.memoryMap.attempts; attempt++) {
    try {regions = await scan(rpc); break;}
    catch (error) {
      lastError = error;
      if (attempt === target.memoryMap.attempts) break;
      console.error(`Memory map attempt ${attempt} failed; rescanning: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, target.memoryMap.retryDelayMs));
    }
  }
  if (!regions) throw lastError;
  await fs.writeFile(path.join(__dirname, 'memory-map.json'),
    JSON.stringify({session: live.session, complete: true, regions}, null, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify({complete: true, regions: regions.length}));
}
module.exports = {scan, main};
if (require.main === module) main().catch(error => {console.error(error.stack); process.exitCode = 1;});
