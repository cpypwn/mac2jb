'use strict';
// Walking a mounted save archive: which entries are directories, which are files.
//
// The engine's listDirectory returns the FsDirectoryEntry type with every entry,
// so the listing already answers the question. On this console that value is
// Directory = 0 and File = 1: a file's type byte is 1 (docs/RESULTS.md, the
// tmp.dat reset that matched a file by type), and the engine's own scratch walk
// reads 0 as the directory value.
//
// Classify from the listing, never from whether openFile succeeds. A read-only
// open can refuse a real file, and the pull used to call every failed open a
// directory: it recursed into a file, found nothing there and dropped the file
// without a word - the "not catching all the file structure" report for Breath
// of the Wild. The open is still what reads a file's bytes; it is no longer what
// decides what the entry is.
const DIRECTORY = 0;
const FILE = 1;

// One ReadDirectory call returns at most four entries, so this is only the loop
// bound handed to the engine. It used to be 2048, which aborted the whole pull of
// a save holding more entries than that in a single directory; no save is close.
const ENTRY_LIMIT = 65536;

function isDirectory(entry) {
  return Number(entry.type) === DIRECTORY;
}

function isFile(entry) {
  return Number(entry.type) === FILE;
}

function join(directory, name) {
  return (directory.endsWith('/') ? directory : directory + '/') + name;
}

// Depth-first walk over one mounted archive, from `directory` (default '/').
//
//   api.list(save, directory, limit)  -> [{name, type, size}]
//   api.open / api.size / api.read / api.close  are the caller's to use; the walk
//   only lists and recurses, so a listing and a pull traverse identically.
//
//   visit.directory(full, entry, depth)  optional, before descending
//   visit.file(full, entry, depth)
//
// An entry whose type is neither value is treated as a file: it must not be
// recursed into, and the read attempt reports it as a file that failed.
async function walk(save, directory, api, visit, options = {}) {
  const limit = options.entryLimit ?? ENTRY_LIMIT;
  const depth = options.depth ?? 0;
  const entries = await api.list(save, directory, limit);
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (isDirectory(entry)) {
      if (visit.directory) await visit.directory(full, entry, depth);
      await walk(save, full, api, visit, {entryLimit: limit, depth: depth + 1});
    } else {
      await visit.file(full, entry, depth);
    }
  }
}

module.exports = {DIRECTORY, FILE, ENTRY_LIMIT, isDirectory, isFile, join, walk};
