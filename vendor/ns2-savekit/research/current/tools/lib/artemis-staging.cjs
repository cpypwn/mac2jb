'use strict';
// Safe staging directories for the Artemis Launcher installer.
//
// The installer rebuilds a staging directory on every run. Doing that with a
// blanket recursive delete is unsafe the moment `--out` is a user-supplied
// path: a typo or a hostile argument could erase an unrelated directory. The
// rules here are deliberately narrow:
//
//   * a staging directory is only ever created under <repo>/staging or under
//     the OS temp directory;
//   * an existing directory is only replaced when it carries our marker file
//     AND says it belongs to the same title;
//   * the new payload is built in a fresh sibling and promoted with rename(),
//     so a failed build leaves the previous good payload untouched;
//   * symlinks are refused at the target and along the parent chain, so a
//     marker cannot be used to redirect a delete into another tree.
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MARKER = '.artemis-staging.json';
const TOOL = 'ns2-savekit/artemis-launcher';
const VERSION = 1;

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function withinOrEqual(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// realpath for a path that may not exist yet: resolve the nearest existing
// ancestor and re-append the missing components, so /tmp/x and
// /private/tmp/x compare equal on macOS.
async function realOrSelf(p) {
  const resolved = path.resolve(p);
  let probe = resolved;
  const missing = [];
  for (;;) {
    try {
      const real = await fsp.realpath(probe);
      return path.join(real, ...missing.reverse());
    } catch {
      const up = path.dirname(probe);
      if (up === probe) return resolved;
      missing.push(path.basename(probe));
      probe = up;
    }
  }
}

async function assertSafeTarget(outDir, {titleId, repo, adopt = null}) {
  const target = path.resolve(outDir);
  const dangerous = new Set([
    path.parse(target).root,
    path.resolve(os.homedir()),
    path.resolve(repo),
    path.dirname(path.resolve(repo)),
    path.join(repo, '.git'),
    path.join(repo, 'tools'),
    path.join(repo, 'docs'),
    path.join(repo, 'saves'),
    path.join(repo, 'config'),
    path.join(repo, 'tests'),
    path.join(repo, 'staging'),
  ]);
  if (dangerous.has(target)) {
    throw Object.assign(new Error('refusing to use ' + target + ' as a staging directory'), {
      code: 'EUNSAFE',
    });
  }
  if (target.length < path.parse(target).root.length + 2) {
    throw Object.assign(new Error('refusing to use a filesystem-root path as staging'), {
      code: 'EUNSAFE',
    });
  }

  const roots = [path.join(path.resolve(repo), 'staging'), path.resolve(os.tmpdir())];
  // macOS: /tmp is a symlink to /private/tmp, while os.tmpdir() returns a
  // per-user /var/folders path. Compare real paths so both spellings agree.
  try { roots.push(await fsp.realpath('/tmp')); } catch { /* no /tmp */ }
  const allowed = await Promise.all(roots.map(async root => {
    try { return await fsp.realpath(root); } catch { return path.resolve(root); }
  }));
  const targetReal = await realOrSelf(target);
  const inAllowed = allowed.some(root => inside(path.resolve(root), targetReal));
  if (!inAllowed) {
    throw Object.assign(new Error(
      'staging directories must live under ' + allowed.join(' or ') +
      ' (got ' + target + '); pass --out inside one of those, or omit --out'), {
      code: 'EUNSAFE',
    });
  }

  let stat = null;
  try { stat = await fsp.lstat(target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat) {
    if (stat.isSymbolicLink()) {
      throw Object.assign(new Error('refusing to stage through symlink ' + target), {
        code: 'EUNSAFE',
      });
    }
    if (!stat.isDirectory()) {
      throw Object.assign(new Error('staging target exists and is not a directory: ' + target), {
        code: 'EUNSAFE',
      });
    }
    // Existing directory: ours, or an older unmarked staging directory that the
    // caller can verify by content. Adoption only writes the marker; the old
    // directory is not touched until a complete new payload is promoted.
    let marker = null;
    try {
      marker = JSON.parse(await fsp.readFile(path.join(target, MARKER), 'utf8'));
    } catch { /* no marker: maybe a pre-marker staging directory */ }
    if (!marker) {
      if (!adopt) {
        throw Object.assign(new Error(
          'refusing to replace existing directory ' + target +
          ' - it has no ' + MARKER + ' marker, so it is not ours'), {code: 'EUNSAFE'});
      }
      const verdict = await adopt(target);
      if (!verdict || !verdict.ok) {
        throw Object.assign(new Error(
          'refusing to adopt existing directory ' + target +
          ' - it does not contain exactly a verifiable staged payload'), {
          code: 'EUNSAFE', problems: verdict && verdict.problems || [],
        });
      }
      await writeMarker(target, titleId);
      marker = {tool: TOOL, version: VERSION, titleId};
    }
    if (marker.tool !== TOOL || marker.version !== VERSION || marker.titleId !== titleId) {
      throw Object.assign(new Error(
        'refusing to replace ' + target + ' - its staging marker is for ' +
        (marker.tool || 'another tool') + '/' + (marker.titleId || 'another title')), {
        code: 'EUNSAFE',
      });
    }
  } else {
    // New directory: the nearest existing ancestor must be a real directory
    // inside an allowed root, then the rest of the parent chain is created.
    // This rejects a symlinked ancestor before mkdir follows it.
    const parent = path.dirname(target);
    let probe = parent;
    let probeStat = null;
    for (;;) {
      try {
        probeStat = await fsp.lstat(probe);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const up = path.dirname(probe);
        if (up === probe) break;
        probe = up;
      }
    }
    if (!probeStat || (!probeStat.isDirectory() && !probeStat.isSymbolicLink())) {
      throw Object.assign(new Error('staging parent chain is not a directory: ' + parent), {
        code: 'EUNSAFE',
      });
    }
    // A symlinked ancestor is only acceptable when it resolves inside an
    // allowed root: /tmp -> /private/tmp is fine, /tmp/x -> ~/Documents is not.
    const probeReal = await fsp.realpath(probe);
    const probeRealStat = await fsp.stat(probeReal);
    if (!probeRealStat.isDirectory() ||
        !allowed.some(root => withinOrEqual(path.resolve(root), probeReal))) {
      throw Object.assign(new Error('staging parent escapes the allowed roots: ' + parent), {
        code: 'EUNSAFE',
      });
    }
    await fsp.mkdir(parent, {recursive: true});
    const parentReal = await fsp.realpath(parent);
    if (!allowed.some(root => withinOrEqual(path.resolve(root), parentReal))) {
      throw Object.assign(new Error('staging parent escapes the allowed roots: ' + parent), {
        code: 'EUNSAFE',
      });
    }
  }
  return target;
}

function buildDirFor(target) {
  const parent = path.dirname(target);
  const base = path.basename(target);
  return path.join(parent, '.artemis-build-' + base + '-' + process.pid + '-' +
    crypto.randomBytes(4).toString('hex'));
}

async function writeMarker(directory, titleId) {
  await fsp.writeFile(path.join(directory, MARKER), JSON.stringify({
    tool: TOOL, version: VERSION, titleId,
  }, null, 2) + '\n');
}

// Build in a sibling; the caller promotes only after the payload is complete.
async function beginBuild(target, titleId) {
  const build = buildDirFor(target);
  await fsp.mkdir(build, {recursive: false});
  await writeMarker(build, titleId);
  return build;
}

// Atomic enough for a local filesystem: rename the old payload aside, rename
// the new one in, then delete the old. If the second rename fails the old one
// is put back. The caller never deletes the live target directly.
async function promoteBuild(build, target, titleId) {
  let existing = false;
  try {
    const stat = await fsp.lstat(target);
    existing = true;
    if (stat.isSymbolicLink()) throw new Error('target became a symlink during staging');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!existing) {
    await fsp.rename(build, target);
    return {replaced: false};
  }
  const aside = target + '.old-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  await fsp.rename(target, aside);
  try {
    await fsp.rename(build, target);
  } catch (error) {
    await fsp.rename(aside, target).catch(() => {});
    throw error;
  }
  await fsp.rm(aside, {recursive: true, force: true});
  return {replaced: true};
}

async function discardBuild(build) {
  // The build directory was created by us in this process, with a unique name
  // and our marker. Removing it cannot touch a previous staged payload.
  await fsp.rm(build, {recursive: true, force: true});
}

module.exports = {
  MARKER, TOOL, VERSION, assertSafeTarget, beginBuild, promoteBuild, discardBuild,
  buildDirFor, inside, withinOrEqual,
};
