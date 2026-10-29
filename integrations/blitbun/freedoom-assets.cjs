const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = '0.13.0';
const WAD_SHA256 = '7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d';
const INVENTORY = Object.freeze({
  'COPYING.txt': ['7c62f2c520769c798774f416637eec4921e5f0aafdac1245ae7c8a8cf65fe102', 1644],
  'CREDITS-MUSIC.txt': ['2bb77677bbc4e587bba44ccb6514ee0f5397c7bb8ae9580b9188d3d6a57c0a31', 9388],
  'CREDITS.txt': ['72364333d295c598d75ef9553d3b3661ad0b60e27271c87b7637c74b2f46918a', 15872],
  'freedoom1.wad': [WAD_SHA256, 28795076],
});

function load(root) {
  const directory = path.join(root, 'integrations/blitbun/assets');
  const expected = Object.keys(INVENTORY).sort();
  const actual = fs.readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Changed Freedoom asset inventory.');
  const contents = new Map();
  for (const name of expected) {
    const file = path.join(directory, name);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== INVENTORY[name][1]) {
      throw Error('Changed Freedoom asset: ' + name);
    }
    const bytes = fs.readFileSync(file);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== INVENTORY[name][0]) throw Error('Changed Freedoom asset: ' + name);
    contents.set(name, bytes);
  }
  if (contents.get('freedoom1.wad').toString('ascii', 0, 4) !== 'IWAD') {
    throw Error('Invalid Freedoom IWAD.');
  }
  return contents;
}

module.exports = { VERSION, WAD_SHA256, INVENTORY, load };
