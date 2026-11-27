// Validate the host-side kaiHEN package before starting the Switch runner.
const fs = require('node:fs');
const path = require('node:path');

const requiredFiles = ['ro/main', 'hen/main', 'game/main', 'bootstrap.bin', 'hbmenu.nro'];

function validatePackage(directory) {
  const root = path.resolve(directory);
  for (const relative of requiredFiles) {
    const filename = path.join(root, relative);
    let stat;
    try { stat = fs.statSync(filename); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        throw Error(`Missing package file: ${filename}`);
      }
      throw error;
    }
    if (!stat.isFile()) throw Error(`Package path is not a file: ${filename}`);
  }

  const programs = path.join(root, 'programs');
  let programsStat;
  try { programsStat = fs.statSync(programs); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw Error(`Missing package directory: ${programs}`);
    }
    throw error;
  }
  if (!programsStat.isDirectory()) throw Error(`Package path is not a directory: ${programs}`);

  const programFiles = fs.readdirSync(programs, {withFileTypes: true})
    .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
    .map(entry => ({source: path.join(programs, entry.name), target: `/switch/${entry.name}`}));
  return {root, programFiles};
}

module.exports = {requiredFiles, validatePackage};
