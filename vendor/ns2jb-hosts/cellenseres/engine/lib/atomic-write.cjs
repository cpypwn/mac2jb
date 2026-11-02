// Fall back when Windows blocks destination replacement.
const fs = require('node:fs/promises');

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function writeRetry(file, bytes, options) {
  for (let attempt = 0; ; ++attempt) {
    try {
      return await fs.writeFile(file, bytes, options);
    } catch (error) {
      if (!RETRYABLE.has(error.code) || attempt >= 4) throw error;
      await delay(40 * (attempt + 1));
    }
  }
}

async function writeFileAtomic(file, bytes, options = {mode: 0o600}) {
  const temporary = file + '.' + process.pid + '.tmp';
  await writeRetry(temporary, bytes, options);
  for (let attempt = 0; attempt <= 4; ++attempt) {
    try {
      await fs.rename(temporary, file);
      return;
    } catch (error) {
      if (!RETRYABLE.has(error.code) || attempt === 4) break;
      await delay(40 * (attempt + 1));
    }
  }
  try {
    await writeRetry(file, bytes, options);
  } finally {
    await fs.rm(temporary, {force: true});
  }
}

module.exports = {writeFileAtomic};
