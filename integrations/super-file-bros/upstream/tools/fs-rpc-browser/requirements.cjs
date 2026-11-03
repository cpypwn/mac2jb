function check(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 20 || (major === 20 && minor < 20))
    throw Error('Super File Bros. needs Node.js 20.20 or newer (22+ recommended). Install it from https://nodejs.org/ and reopen this launcher.');
}
module.exports = {check};
