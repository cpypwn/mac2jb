const PAGE = 4096;
const STEP = 0xf0;
const RESULT = 0x800;
const SENTINEL = 0xfedcba9876543210n;
const align = value => Math.ceil(value / PAGE) * PAGE;

function build(base, sdk, calls, code, options = {}) {
  const {sdkBytes, memcpyOffset, exitOffset} = options;
  if (![base, sdk, sdkBytes, memcpyOffset, exitOffset].every(Number.isSafeInteger) ||
      base % PAGE || sdk % PAGE || sdkBytes < PAGE || memcpyOffset < 0 ||
      exitOffset < 0 || !Array.isArray(calls) || calls.length < 1 || calls.length > 32768)
    throw Error('Invalid Gravity Circuit worker address or call count');
  for (const name of ['longjmp', 'loadTable', 'call4', 'saveResult64']) {
    if (!Number.isSafeInteger(code?.[name]?.offset) || code[name].offset < 0 ||
        code[name].offset >= sdkBytes)
      throw Error('Missing Gravity Circuit worker code: ' + name);
  }
  if (code.call4.offset !== 0x516ac0 || code.loadTable.offset !== 0x4adec ||
      code.saveResult64.offset !== 0x18b8b0 || code.longjmp.offset !== 0x5b5534)
    throw Error('Gravity Circuit frame requires the measured SDK v1.2.1 gadgets');
  if (exitOffset >= sdkBytes || memcpyOffset >= sdkBytes)
    throw Error('Worker continuation is outside the captured SDK');

  const expanded = [], logicalResultIndices = [], patches = [];
  for (const call of calls) {
    if (!Array.isArray(call?.args) || call.args.length !== 4)
      throw Error('Workers require exactly four arguments');
    const loads = [];
    call.args.forEach((argument, argumentIndex) => {
      if (typeof argument !== 'object') return;
      if (!argument || Object.keys(argument).join() !== 'u32' ||
          !Number.isSafeInteger(argument.u32) || argument.u32 <= 0 || argument.u32 % 4)
        throw Error('Dynamic arguments require an aligned u32 address');
      loads.push({load: expanded.length, argumentIndex});
      expanded.push({function: sdk + memcpyOffset, args: [0, argument.u32, 4, 0]});
    });
    const targetIndex = expanded.length;
    patches.push(...loads.map(load => ({...load, targetIndex})));
    logicalResultIndices.push(targetIndex);
    expanded.push({...call, args: call.args.map(value => typeof value === 'object' ? 0 : value)});
  }

  const count = expanded.length;
  const tables = align(RESULT + count * 8);
  const stack = align(tables + count * 0x100) + 0x10000;
  const size = align(stack + 0x30 + count * STEP + 0x4000);
  if (size > 0x2000000 || RESULT + count * 8 > tables ||
      tables + count * 0x100 > stack || stack + 0x30 + count * STEP > size)
    throw Error('Worker regions overlap or exceed the allocation');

  const frame = Buffer.alloc(size);
  const put = (offset, value) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value))
      throw Error('Worker word is not an exact integer');
    const word = BigInt(value);
    if (word < 0n || word > 0xffffffffffffffffn)
      throw Error('Worker word is outside uint64');
    frame.writeBigUInt64LE(word, offset);
  };
  const nextArgSlot = (index, argumentIndex) => {
    if (index === 0) return argumentIndex === 0 ? 0x30 :
      argumentIndex === 1 ? stack + 0x10 :
      argumentIndex === 2 ? stack + 0x20 : 0x48;
    const previous = stack + 0x30 + (index - 1) * STEP;
    return previous + [0x68, 0xd0, 0xe0, 0x50][argumentIndex];
  };
  for (const {load, targetIndex, argumentIndex} of patches)
    expanded[load].args[0] = base + nextArgSlot(targetIndex, argumentIndex);

  const firstSp = stack + 0x30;
  put(0x10, base + tables);
  put(0x20, base + firstSp + 0x20);
  put(0x30, expanded[0].args[0]);
  put(0x40, base + firstSp + 0x28);
  put(0x48, expanded[0].args[3]);
  put(0x58, sdk + code.loadTable.offset);
  put(0x68, base + stack);

  expanded.forEach((call, index) => {
    if (!Number.isSafeInteger(call.function) || call.function % 4 ||
        call.function < sdk || call.function >= sdk + sdkBytes)
      throw Error('Worker function is outside the captured SDK');
    const table = tables + index * 0x100;
    const sp = stack + 0x30 + index * STEP;
    put(table, call.function);
    put(RESULT + index * 8, SENTINEL);
    if (index === 0) {
      put(stack + 0x08, sdk + code.call4.offset);
      put(stack + 0x10, call.args[1]);
      put(stack + 0x20, call.args[2]);
    }
    put(sp + 0x48, sdk + code.saveResult64.offset);
    put(sp + 0x98, base + RESULT + index * 8);
    if (index + 1 < count) {
      const next = expanded[index + 1];
      const nextSp = sp + STEP;
      put(sp + 0x50, next.args[3]);
      put(sp + 0x58, base + nextSp + 0x28);
      put(sp + 0x68, next.args[0]);
      put(sp + 0x78, base + nextSp + 0x20);
      put(sp + 0x88, base + tables + (index + 1) * 0x100);
      put(sp + 0xa8, sdk + code.loadTable.offset);
      put(sp + 0xc8, sdk + code.call4.offset);
      put(sp + 0xd0, next.args[1]);
      put(sp + 0xe0, next.args[2]);
    } else put(sp + 0xa8, sdk + exitOffset);
  });

  return {frame, proof: {bytes: size, logicalCalls: calls.length, nativeCalls: count,
    resultOffsets: expanded.map((_, index) => RESULT + index * 8), logicalResultIndices,
    resultOffset: RESULT + (count - 1) * 8, stackOffset: stack, firstCallSpOffset: firstSp,
    callStride: STEP, tablesOffset: tables, scratchOffsets: expanded.map((_, index) =>
      [stack + 0x30 + index * STEP + 0x20, stack + 0x30 + index * STEP + 0x28])}};
}

module.exports = {build, SENTINEL};
