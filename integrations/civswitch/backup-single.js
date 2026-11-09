(async function () {
  const prefix = "MAC2JB_CIV_BACKUP ";
  const directory = "save:/saves/Single";
  const parent = "save:/saves";
  const chunkSize = 512;
  const batchSize = 16;
  const maxFiles = 512;
  const fOpenDir = sdk_base + 0xa7bb0n;
  const fReadDir = sdk_base + 0xa5840n;
  const fCloseDir = sdk_base + 0xa57b0n;
  const fOpenFile = sdk_base + 0xa78a0n;
  const fReadFile = sdk_base + 0xa5bf0n;
  const fCloseFile = sdk_base + 0xa5a70n;

  function result(value) {
    return BigInt.asUintN(32, value);
  }

  function pathBytes(path) {
    return text_encode(path);
  }

  function writePath(buffer, prefixBytes, nameBytes) {
    const bytes = Array.from(prefixBytes).concat(nameBytes || []);
    if (bytes.length >= 0x400) throw new Error("save path too long");
    for (let i = 0; i < bytes.length; i++) write8(buffer + BigInt(i), BigInt(bytes[i]));
    write8(buffer + BigInt(bytes.length), 0n);
  }

  function hex(bytes) {
    let output = "";
    for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
    return output;
  }

  async function emit(kind, value) {
    await log(prefix + kind + " " + JSON.stringify(value));
  }

  function list(path) {
    const handleOut = malloc(8);
    const countOut = malloc(8);
    const pathBuffer = malloc(0x400);
    const entries = malloc(0x310 * batchSize);
    let handle = null;
    try {
      writePath(pathBuffer, pathBytes(path), []);
      const opened = result(call_rop(fOpenDir, handleOut, pathBuffer, 3n));
      if (opened !== 0n) return {error: opened.toString(16), entries: []};
      handle = read64(handleOut);
      const output = [];
      for (;;) {
        write64(countOut, 0n);
        const read = result(call_rop(fReadDir, countOut, entries, handle, BigInt(batchSize)));
        if (read !== 0n) throw new Error("ReadDir " + path + " 0x" + read.toString(16));
        const count = Number(read64(countOut));
        if (!Number.isSafeInteger(count) || count < 0 || count > batchSize) throw new Error("invalid directory count");
        for (let i = 0; i < count; i++) {
          const entry = entries + BigInt(i * 0x310);
          const name = [];
          for (let j = 0; j < 0x300; j++) {
            const byte = Number(read8(entry + BigInt(j)));
            if (byte === 0) break;
            name.push(byte);
          }
          if (!name.length) throw new Error("empty save filename");
          const size = read64(entry + 0x308n);
          if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("save too large");
          output.push({name, type: Number(read32(entry + 0x304n) & 0xffn), size: Number(size)});
          if (output.length > maxFiles) throw new Error("too many save entries");
        }
        if (count === 0) break;
      }
      return {error: null, entries: output};
    } finally {
      if (handle !== null) call_rop(fCloseDir, handle);
      free(entries);
      free(pathBuffer);
      free(countOut);
      free(handleOut);
    }
  }

  function inventory() {
    const snapshot = list(directory);
    if (snapshot.error === null) return {...snapshot, missing: false};
    if (snapshot.error !== "202") throw new Error("OpenDir " + directory + " 0x" + snapshot.error);
    const parentEntries = list(parent);
    if (parentEntries.error !== null) throw new Error("OpenDir " + parent + " 0x" + parentEntries.error);
    const single = hex(pathBytes("Single"));
    if (parentEntries.entries.some(entry => hex(entry.name) === single)) {
      throw new Error("Single save directory exists but could not be opened");
    }
    return {error: null, entries: [], missing: true};
  }

  function changedDirectory(before, after) {
    if (before.missing !== after.missing) {
      return "save directory changed during backup: Single save directory " +
        (after.missing ? "disappeared" : "appeared");
    }
    if (after.error !== null) {
      return "save directory changed during backup: reopen failed 0x" + after.error;
    }
    const beforeByName = new Map(before.entries.map(entry => [hex(entry.name), entry.size]));
    const afterByName = new Map(after.entries.map(entry => [hex(entry.name), entry.size]));
    const changes = [];
    const label = name => {
      const bytes = [];
      for (let i = 0; i < Math.min(name.length, 64); i += 2) bytes.push(parseInt(name.slice(i, i + 2), 16));
      return bytes.every(byte => byte >= 32 && byte <= 126)
        ? String.fromCharCode(...bytes)
        : "0x" + name.slice(0, 32);
    };
    for (const [name, size] of afterByName) {
      if (!beforeByName.has(name)) changes.push("added " + label(name));
      else if (beforeByName.get(name) !== size) {
        changes.push("resized " + label(name) + " " + beforeByName.get(name) + " to " + size);
      }
    }
    for (const name of beforeByName.keys()) {
      if (!afterByName.has(name)) changes.push("removed " + label(name));
    }
    return "save directory changed during backup: " + before.entries.length + " before, " +
      after.entries.length + " after" + (changes.length ? "; " + changes.slice(0, 4).join(", ") : "");
  }

  const handleOut = malloc(8);
  const pathBuffer = malloc(0x400);
  const data = malloc(chunkSize);
  let handle = null;
  try {
    const snapshot = inventory();
    if (snapshot.entries.some(entry => entry.type !== 1)) throw new Error("nested save entries are not supported");
    await emit("BEGIN", {version: 1, directory, count: snapshot.entries.length, chunkSize});
    for (const entry of snapshot.entries) {
      await emit("FILE", {nameHex: hex(entry.name), size: entry.size});
      writePath(pathBuffer, pathBytes(directory + "/"), entry.name);
      const opened = result(call_rop(fOpenFile, handleOut, pathBuffer, 1n));
      if (opened !== 0n) throw new Error("OpenFile 0x" + opened.toString(16));
      handle = read64(handleOut);
      let checksum = 2166136261;
      try {
        for (let offset = 0; offset < entry.size; offset += chunkSize) {
          const length = Math.min(chunkSize, entry.size - offset);
          const read = result(call_rop(fReadFile, handle, BigInt(offset), data, BigInt(length)));
          if (read !== 0n) throw new Error("ReadFile 0x" + read.toString(16));
          const bytes = [];
          for (let i = 0; i < length; i++) {
            const byte = Number(read8(data + BigInt(i)));
            bytes.push(byte);
            checksum = Math.imul(checksum ^ byte, 16777619) >>> 0;
          }
          await emit("CHUNK", {offset, hex: hex(bytes)});
        }
      } finally {
        call_rop(fCloseFile, handle);
        handle = null;
      }
      await emit("FILE_END", {size: entry.size, fnv32: checksum.toString(16).padStart(8, "0")});
    }
    const after = inventory();
    if (after.missing !== snapshot.missing || after.entries.length !== snapshot.entries.length) {
      throw new Error(changedDirectory(snapshot, after));
    }
    const first = snapshot.entries.map(entry => hex(entry.name) + ":" + entry.size).sort();
    const second = after.entries.map(entry => hex(entry.name) + ":" + entry.size).sort();
    if (first.some((value, index) => value !== second[index])) throw new Error(changedDirectory(snapshot, after));
    await emit("END", {count: snapshot.entries.length});
  } catch (error) {
    await emit("ERROR", {message: String(error && error.message || error)});
    throw error;
  } finally {
    if (handle !== null) call_rop(fCloseFile, handle);
    free(data);
    free(pathBuffer);
    free(handleOut);
  }
})();
