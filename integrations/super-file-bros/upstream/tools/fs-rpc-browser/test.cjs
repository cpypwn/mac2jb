const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const names = ['fs-rpc-browser', 'fs-rpc-downloads', 'fs-rpc-discovery', 'fs-rpc-writes', 'dolphin-fs-rpc', 'super-file-bros-release'];
const files = names.map(name => path.join(root, 'tests', name + '.test.cjs'));
for (const file of files) if (!fs.existsSync(file)) throw Error('Missing test source: ' + path.basename(file));
const result = spawnSync(process.execPath, ['--test', ...files], {stdio: 'inherit', cwd: root});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
