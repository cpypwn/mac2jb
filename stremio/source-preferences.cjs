'use strict';
const {createHash, randomBytes} = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const provider = source => validDigest(source?.providerKey) ? source.providerKey : source?.addonName || '';
const label = source => source?.label || '';
const videoKey = (type, itemId, videoId) => digest([type, itemId, videoId]);
function sourceKey(streams, index) {
  const source = streams[index];
  if (!source) return null;
  const duplicate = streams.some((other, otherIndex) => otherIndex !== index &&
    provider(other) === provider(source) && label(other) === label(source));
  return digest([provider(source), label(source), duplicate ? digest([source.url, source.headers]) : null]);
}

class SourcePreferences {
  constructor(file = null, entries = []) {
    this.file = file;
    this.entries = new Map(entries);
    this.saves = Promise.resolve();
  }

  static async load(file) {
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 ||
          info.uid !== process.getuid() || (info.mode & 0o077) !== 0) return new SourcePreferences(file);
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.entries)) return new SourcePreferences(file);
      const entries = data.entries.slice(-1000).filter(entry =>
        validDigest(entry?.key) && validDigest(entry?.source) && Number.isSafeInteger(entry.at) && entry.at >= 0)
        .map(entry => [entry.key, {source: entry.source, at: entry.at}]);
      return new SourcePreferences(file, entries);
    } catch { return new SourcePreferences(file); }
  }

  find(type, itemId, videoId, streams) {
    const saved = this.entries.get(videoKey(type, itemId, videoId))?.source;
    if (!saved) return -1;
    return streams.findIndex((stream, index) => stream.playable && sourceKey(streams, index) === saved);
  }

  async remember(type, itemId, videoId, streams, index) {
    if (!streams[index]?.playable) return;
    this.entries.set(videoKey(type, itemId, videoId), {source: sourceKey(streams, index), at: Date.now()});
    await this._save();
  }

  async forget(type, itemId, videoId, streams, index) {
    const key = videoKey(type, itemId, videoId);
    if (this.entries.get(key)?.source !== sourceKey(streams, index)) return;
    this.entries.delete(key);
    await this._save();
  }

  async _save() {
    if (!this.file) return;
    const entries = [...this.entries].sort((a, b) => a[1].at - b[1].at).slice(-1000)
      .map(([key, value]) => ({key, source: value.source, at: value.at}));
    this.entries = new Map(entries.map(entry => [entry.key, {source: entry.source, at: entry.at}]));
    this.saves = this.saves.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), {recursive: true, mode: 0o700});
      const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({version: 1, entries}) + '\n', {flag: 'wx', mode: 0o600});
        await fs.rename(temporary, this.file);
      } finally { await fs.rm(temporary, {force: true}).catch(() => {}); }
    });
    return this.saves;
  }
}

module.exports = {SourcePreferences, sourceKey};
