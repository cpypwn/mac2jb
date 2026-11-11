const fs = require('node:fs');
const path = require('node:path');

const TARGETS = new Set(['smilebasic', 'civ7', 'artemis-seedsow']);
const transportNames = ['memcpy', 'memmove', 'queryMemory'];
const nativeNames = [...transportNames, 'crc32', 'cancelSynchronization', 'eventSyscallScan',
  'threadId', 'waitZero', 'processInfo', 'syscallCapture'];

function readJson(file, label = file) {
  let text;
  try {text = fs.readFileSync(file, 'utf8');}
  catch (error) {
    if (error.code === 'ENOENT') throw Error(`Missing ${label}: ${file}`);
    throw Error(`Cannot read ${label} ${file}: ${error.message}`);
  }
  try {return JSON.parse(text);}
  catch (error) {throw Error(`Invalid JSON in ${label} ${file}: ${error.message}`);}
}

function selectedTarget(value = process.env.NS2_TARGET || 'smilebasic') {
  if (!TARGETS.has(value)) throw Error(`Unsupported target ${JSON.stringify(value)}; choose civ7, smilebasic, or artemis-seedsow`);
  return value;
}

function loadTarget(name = selectedTarget(), options = {}) {
  name = selectedTarget(name);
  const configPath = options.configPath || path.join(__dirname, `target.${name}.json`);
  const target = readJson(configPath, `${name} target configuration`);
  if (target.schemaVersion !== 1 || target.name !== name || !Number.isInteger(target.sdkBytes) || target.sdkBytes <= 0)
    throw Error(`Unsupported target configuration: ${configPath}`);
  target.configPath = configPath;
  target.portRoot = options.portRoot || process.env.NS2_PORT_ROOT || path.resolve(__dirname, '../..');
  target.materializedRoot = options.materializedRoot || process.env.NS2_TARGET_ROOT || null;
  return target;
}

function required(value, label) {
  if (value === null || value === undefined || value === '' ||
      Array.isArray(value) && value.length === 0)
    throw Error(`Unsupported ${label}: no verified replacement is configured`);
  return value;
}

function artifactPath(target, relative, label) {
  required(relative, label);
  const file = path.resolve(target.portRoot, relative);
  if (file !== target.portRoot && !file.startsWith(target.portRoot + path.sep))
    throw Error(`${label} escapes the port directory: ${relative}`);
  return file;
}

function sdkFunctionPath(target) {
  if (target.materializedRoot)
    return path.join(target.materializedRoot, 'shared', 'sdk-functions.json');
  return target.artifacts.sdkFunctions ? artifactPath(target, target.artifacts.sdkFunctions, 'Civ7 SDK function table') :
    path.join(__dirname, 'sdk-functions.json');
}

function sdkFunctions(target = loadTarget()) {
  const file = sdkFunctionPath(target);
  const functions = readJson(file, `${target.name} SDK function table`);
  if (!functions || Array.isArray(functions) || typeof functions !== 'object')
    throw Error(`Invalid SDK function table: ${file}`);
  return functions;
}

function checkedOffset(offset, target, label) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= target.sdkBytes || offset % 4)
    throw Error(`Invalid ${label} offset for ${target.name}: ${offset}`);
  return offset;
}

function nativeEntry(name, target = loadTarget()) {
  if (!nativeNames.includes(name)) throw Error(`Unknown native transport function: ${name}`);
  const reference = required(target.nativeFunctions?.[name], `${target.name} native ${name}`);
  if (Number.isInteger(reference)) return {offset: checkedOffset(reference, target, `native ${name}`)};
  if (typeof reference !== 'string') throw Error(`Invalid native ${name} reference for ${target.name}`);
  const entry = required(sdkFunctions(target)[reference], `${target.name} SDK function ${reference}`);
  const offset = checkedOffset(entry.offset, target, reference);
  if (typeof entry.bytes !== 'string' || !/^(?:[0-9a-f]{2}){4,256}$/i.test(entry.bytes))
    throw Error(`${target.name} SDK function ${reference} has no verified instruction bytes in ${sdkFunctionPath(target)}`);
  return {...entry, offset, name: reference};
}

function nativeOffset(name, target = loadTarget()) {
  return nativeEntry(name, target).offset;
}

function programId(target = loadTarget()) {
  const value = required(target.programIds?.ro, `${target.name} RO donor program ID`);
  if (typeof value !== 'string' || !/^0x[0-9a-f]{16}$/.test(value) ||
      !target.programIds.allowedRo.includes(value))
    throw Error(`Unsupported ${target.name} RO donor program ID: ${value}`);
  return value;
}

const requiredAppFunctions = {
  'thread-code.json': ['create', 'join', 'exit', 'current', 'longjmp', 'loadTable', 'call4',
    'saveResult', 'saveResult64', 'tryWait', 'tryWaitImplementation', 'sleep'],
  'event-code.json': ['initialize', 'finalize', 'wait', 'tryWait', 'signal', 'clear', 'waitAddress', 'signalAddress'],
  'timing-code.json': ['tick', 'frequency', 'priority'],
  'thread-scheduling-reference.json': ['pthread_getaffinity_np', 'pthread_setaffinity_np',
    'nn::os::SetThreadCoreMask(nn::os::ThreadType*, int, unsigned long)',
    'nn::os::GetThreadCoreMask(int*, unsigned long*, nn::os::ThreadType const*)',
    'nn::os::GetThreadAvailableCoreMask()', 'nn::os::GetCurrentCoreNumber()',
    'nn::os::detail::ThreadManagerImplByHorizon::GetThreadAvailableCoreMask() const',
    'nn::os::detail::ThreadManagerImplByHorizon::GetCurrentCoreNumber() const']
};

function validateCodeEntry(entry, target, label) {
  if (!entry || typeof entry.bytes !== 'string' || !/^(?:[0-9a-f]{2}){4,256}$/i.test(entry.bytes))
    throw Error(`Unresolved ${label}`);
  checkedOffset(entry.offset, target, label);
}

function validateArtifact(target, relative, label) {
  const file = artifactPath(target, relative, label);
  const value = readJson(file, label);
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw Error(`Invalid ${label}: ${file}`);
  return {file, value};
}

function validateArtifacts(target = loadTarget()) {
  const validated = {};
  if (target.artifacts.sdkFunctions) {
    validated.sdkFunctions = validateArtifact(target, target.artifacts.sdkFunctions, 'Civ7 SDK function table');
    for (const [name, entry] of Object.entries(validated.sdkFunctions.value)) {
      if (!entry || !Number.isInteger(entry.offset) || typeof entry.bytes !== 'string' ||
          !/^(?:[0-9a-f]{2}){4,256}$/i.test(entry.bytes))
        throw Error(`Unresolved Civ7 SDK function ${name} in ${validated.sdkFunctions.file}`);
      checkedOffset(entry.offset, target, `SDK function ${name}`);
    }
  }
  if (target.artifacts.sdkLayout) {
    validated.sdkLayout = validateArtifact(target, target.artifacts.sdkLayout, 'Civ7 SDK layout');
    const mountTableOffset = required(validated.sdkLayout.value.mountTableOffset, 'Civ7 mount table');
    if (!Number.isInteger(mountTableOffset) || mountTableOffset < 0 || mountTableOffset % 8)
      throw Error(`Invalid Civ7 mount table offset: ${mountTableOffset}`);
    if (!Array.isArray(validated.sdkLayout.value.verifiedFunctions) || !validated.sdkLayout.value.verifiedFunctions.length)
      throw Error('Civ7 SDK layout has no verified mount functions');
    for (const entry of validated.sdkLayout.value.verifiedFunctions) {
      checkedOffset(entry?.offset, target, 'mount verification function');
      if (typeof entry.bytes !== 'string' || !/^(?:[0-9a-f]{2}){4,256}$/i.test(entry.bytes))
        throw Error('Civ7 SDK layout has an unresolved mount verification function');
    }
  }
  validated.app = {};
  for (const [name, relative] of Object.entries(target.artifacts.app || {})) {
    const artifact = validateArtifact(target, relative, `Civ7 app offset file ${name}`);
    validated.app[name] = artifact;
    if (requiredAppFunctions[name]) {
      if (!artifact.value.functions || typeof artifact.value.functions !== 'object')
        throw Error(`Missing functions table in ${artifact.file}`);
      for (const functionName of requiredAppFunctions[name])
        validateCodeEntry(artifact.value.functions[functionName], target, `${name} ${functionName}`);
    } else if (name === 'hash-code.json') validateCodeEntry(artifact.value, target, 'SHA-256 function');
    else if (name === 'sdk-proxy-code.json') {
      validateCodeEntry({offset: artifact.value.functionOffset, bytes: artifact.value.bytes}, target, 'SDK proxy getter');
      if (!Number.isInteger(artifact.value.globalOffset) || artifact.value.globalOffset < 0 ||
          artifact.value.globalOffset % 8) throw Error('Unresolved SDK proxy global offset');
    } else if (name === 'compat-affinity-reference.json' && target.affinity.mode === 'compat') {
      validateCodeEntry(artifact.value.import, target, 'compatibility affinity import');
      if (!Number.isInteger(artifact.value.gotOffset) || !artifact.value.symbol ||
          !Number.isInteger(artifact.value.symbolOffsetFromTarget) || !artifact.value.target?.bytes)
        throw Error('Unresolved compatibility affinity reference');
    }
  }
  return validated;
}

function assertAppSupported(target = loadTarget()) {
  if (!['pthread', 'pthread-enumerate', 'raw-svc'].includes(target.thread?.mode))
    throw Error(`Unsupported ${target.name} thread lifecycle: ${target.thread?.mode}`);
  for (const name of transportNames) nativeEntry(name, target);
  if (target.importRestoration)
    required(target.hello.gotOffsetFromMain, `${target.name} HELLO GOT offset`);
  required(target.hello.sdkCrc32, `${target.name} HELLO SDK CRC-32`);
  required(target.crc32?.expected, `${target.name} SDK CRC-32 value`);
  required(target.sessionManager, `${target.name} SDK session-manager layout`);
  if (target.name !== 'smilebasic') {
    required(target.crc32.function, 'Civ7 SDK CRC-32 function');
    nativeEntry('crc32', {...target, nativeFunctions: {...target.nativeFunctions, crc32: target.crc32.function}});
  }
  validateArtifacts(target);
  return target;
}

function assertFullSupported(target = loadTarget()) {
  assertAppSupported(target);
  for (const name of nativeNames.slice(transportNames.length + 1)) nativeEntry(name, target);
  required(target.romMount, `${target.name} RomFS mount layout`);
  required(target.retainedCaptureBytes, `${target.name} retained capture size`);
  required(target.retainedCaptureOffset, `${target.name} retained capture offset`);
  required(target.smServiceOffset, `${target.name} SM service offset`);
  programId(target);
  required(target.programIds.host, `${target.name} host program IDs`);
  return target;
}

async function materializeTarget(target, directory) {
  const validated = validateArtifacts(target);
  const copies = [];
  if (validated.sdkFunctions)
    copies.push([validated.sdkFunctions.file, path.join(directory, 'shared', 'sdk-functions.json')]);
  if (validated.sdkLayout)
    copies.push([validated.sdkLayout.file, path.join(directory, 'shared', 'sdk-layout.json')]);
  for (const [name, artifact] of Object.entries(validated.app))
    copies.push([artifact.file, path.join(directory, 'switch2', 'app', name)]);
  for (const [source, destination] of copies) await fs.promises.copyFile(source, destination);
  return copies.map(([, destination]) => destination);
}

module.exports = {TARGETS, selectedTarget, loadTarget, readJson, required, sdkFunctionPath, sdkFunctions,
  nativeEntry, nativeOffset, programId, validateArtifacts, assertAppSupported, assertFullSupported,
  materializeTarget};
