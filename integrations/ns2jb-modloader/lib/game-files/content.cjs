// Game-mount helper derived from IZ2S-Platform/OunceCake (GPL-2.0).
// See lib/game-files/COPYING and https://github.com/byizmysh/IZ2S-Platform
const { inflateRawSync } = require('node:zlib');
const { success, idBytes, fixedOutput, pathRequest, resultError, withCleanup, closeHandles, throwIfCancelled } = require('./protocol.cjs');

// read nca content!

const inactive = new Set([0x21005, 0x20a05]);

async function discoverInstalled({ s, domain, service, title, metaType, kind }) {
  const label = metaType === 0x80 ? 'application' : metaType === 0x82 ? 'DLC' : 'update';
  const ncm = await service('ncm');
  const records = [];

  for (const storage of [4, 5, 2]) {
    let database;

    try {
      await withCleanup(async () => {
        database = domain.oneHandle(
          success(
            await s.ipc('Open ' + label + ' metadata database', ncm, 5, Buffer.from([storage])),
            'OpenContentMetaDatabase',
          ),
        );

        const found = new Map();

        async function list(min, max) {
          const input = Buffer.alloc(32);
          input[0] = metaType;
          idBytes(title).copy(input, 8);
          input.writeBigUInt64LE(min, 16);
          input.writeBigUInt64LE(max, 24);

          const address = s.base + 0x6000;
          const capacity = 32;
          const size = capacity * 16;

          const reply = success(
            await s.ipc('List installed game ' + kind, database, 5, input, {
              receive: [{ address, size, mode: 0 }],
            }),
            'List installed game ' + kind,
          );

          const total = reply.data.readInt32LE();
          const count = reply.data.readInt32LE(4);

          const bytes = await s.readOwned(address, size);

          for (let i = 0; i < count; i++) {
            const key = bytes.subarray(i * 16, (i + 1) * 16);
            const id = key.readBigUInt64LE();

            const contentTitle = id.toString(16).padStart(16, '0');
            const version = key.readUInt32LE(8);

            if (!found.has(contentTitle) || version > found.get(contentTitle).version) {
              found.set(contentTitle, { contentTitle, version, storage });
            }
          }

          if (total <= count) return;

          // properly handle a weirdly high amount of packages
          if (min === max) {
            const latest = success(
              await s.ipc(
                'Get latest installed ' + label,
                database,
                6,
                idBytes(min.toString(16).padStart(16, '0')),
              ),
              'GetLatestContentMetaKey',
            );

            const contentTitle = min.toString(16).padStart(16, '0');
            found.set(contentTitle, {
              contentTitle,
              version: latest.data.readUInt32LE(8),
              storage,
            });
            return;
          }

          const mid = (min + max) / 2n;
          await list(min, mid);
          await list(mid + 1n, max);
        }

        await list(0n, 0xffffffffffffffffn);

        if (metaType === 0x82) {
          for (const item of found.values()) {
            const key = Buffer.alloc(16);
            idBytes(item.contentTitle).copy(key);
            key.writeUInt32LE(item.version, 8);
            key[12] = metaType;

            const owner = success(
              await s.ipc('Verify installed DLC application', database, 22, key),
              'GetOwnerApplicationId',
            );
          }
        }

        records.push(...found.values());
      }, () => closeHandles(s, database ? [database] : []));
    } catch (error) {
      if (!inactive.has(error.nativeResult?.canonical)) throw error;
    }
  }

  records.sort(
    (a, b) => b.version - a.version || a.contentTitle.localeCompare(b.contentTitle) || a.storage - b.storage,
  );
  return records;
}

const discoverUpdates = (options) => discoverInstalled({ ...options, metaType: 0x81, kind: 'updates' });
const discoverDlc = (options) => discoverInstalled({ ...options, metaType: 0x82, kind: 'dlc' });
const discoverApplications = (options) =>
  discoverInstalled({ ...options, title: '0000000000000000', metaType: 0x80, kind: 'applications' });

// Resolve a pinned Program or DLC Data record without mounting its filesystem.



async function resolveContent({ s, domain, service, title, storage, update, dlc, contentType = 1 }) {
  const contentName = { 1: 'Program', 2: 'Data', 3: 'Control' }[contentType];

  const handles = [];
  const own = (reply) => {
    const h = domain.oneHandle(reply);
    handles.push(h);
    return h;
  };

  return withCleanup(async () => {
    const ncm = await service('ncm');
    const database = own(
      success(
        await s.ipc('OpenContentMetaDatabase', ncm, 5, Buffer.from([storage])),
        'OpenContentMetaDatabase',
      ),
    );
    const selected = dlc || update;
    const contentTitle = selected ? selected.contentTitle : title;
    const latest = success(
      await s.ipc('GetLatestContentMetaKey', database, 6, idBytes(contentTitle)),
      'GetLatestContentMetaKey',
    );
    const key = Buffer.from(latest.data.subarray(0, 16));

    if (dlc || update) {
      const owner = success(
        await s.ipc('Verify selected ' + (dlc ? 'DLC' : 'update') + ' application', database, 22, key),
        'GetOwnerApplicationId',
      );
      const ownerTitle=owner.data.readBigUInt64LE().toString(16).padStart(16,'0');
      if (title!==contentTitle && ownerTitle!==title) throw new Error('Selected content belongs to another application');
    }

    const input = Buffer.alloc(24);
    input[0] = contentType;
    key.copy(input, 8);

    const content = success(await s.ipc('GetContentIdByType', database, 3, input), 'GetContentIdByType');
    const contentId = Buffer.from(content.data.subarray(0, 16));

    const info = success(
      await s.ipc('Get installed ' + contentName + ' content information', database, 24, input),
      'Get installed ' + contentName + ' content information',
    ).data;

    const attributes = info[21] & 15;
    const store = own(
      success(await s.ipc('OpenContentStorage', ncm, 4, Buffer.from([storage])), 'OpenContentStorage'),
    );
    const address = s.base + 0x3000;
    const size = 0x300;

    const resolved = await domain.send(
      s,
      'Resolve installed game path',
      store,
      fixedOutput(8, contentId, address, size),
    );
    success(resolved, 'Resolve installed game path');

    const bytes = await s.readOwned(address, size);
    const end = bytes.indexOf(0);

    const contentPath = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));

    const source = {
      route: 'ncm',
      storage,
      contentPath,
      attributes,
      contentType,
      contentId: contentId.toString('hex'),
      version: key.readUInt32LE(8),
      metaType: key[12],
    };

    if (update) {
      Object.assign(source, {
        selection: 'update',
        applicationTitle: title,
        contentTitle,
      });
    }

    if (dlc) {
      Object.assign(source, {
        selection: 'dlc',
        applicationTitle: title,
        contentTitle,
      });
    }

    return source;
  }, () => closeHandles(s, handles));
}

const resolveProgramContent = (options) => resolveContent({ ...options, dlc: undefined, contentType: 1 });
const resolveControlContent = (options) =>
  resolveContent({ ...options, dlc: undefined, update: undefined, contentType: 3 });
const resolveDlcContent = (options) => {
  return resolveContent({ ...options, contentType: 2 });
};

async function findOriginalContent(options) {
  for (const storage of [4, 5, 2]) {
    try {
      return await resolveProgramContent({ ...options, storage, update: undefined });
    } catch (error) {
      const absent = new Set([0xe05, 0x21005, 0x20a05]); // collection of error codes for "we don't have this"
      if (!absent.has(error.nativeResult?.canonical)) throw error;
    }
  }

  throw new Error('No installed base Program content was found');
}

// handling for switch 2 editions, mainly. their switch 2 updates seem to have different title ids from their base apps
function isInstalledUpdate(title, source) {
  return (
    source.selection === 'update' &&
    source.applicationTitle === title &&
    source.metaType === 0x81 &&
    source.contentTitle !== title
  );
}

function programMatchesApplication(title, source, programId) {
  return (
    programId === title ||
    (isInstalledUpdate(title, source) && title.startsWith('01') && programId === '04' + title.slice(2))
  );
}

module.exports = {
  discoverUpdates, discoverDlc, discoverApplications, resolveProgramContent, resolveDlcContent,
  findOriginalContent, isInstalledUpdate, programMatchesApplication,
};
