-- Per-game offset tables for Switch native images.
-- Extracted from the decompressed NSOs using hactool + nstool + MOD0 relocation analysis.
--
-- A game entry may point at one profile table or an array of profiles. resolve.lua
-- picks the profile whose `expect.present_head` matches the running
-- love.graphics.present code, so several game builds can ship in one binary.

-- nn::sdk module used by Gravity Circuit 1.0 and 1.2.1. The SDK NSO is
-- byte-identical between both builds, so every offset below is shared.
local GC_SDK_14_3_1 = {
    mod0 = 0x8,
    memcpy = 0x589198,

    -- nn::nifm
    nifm_init = 0x398de0,
    nifm_submit_now = 0x399ee0,
    nifm_ip = 0x399b40,

    -- nn::socket
    sock_init = 0x1413c0,
    socket = 0x140f50,
    bind = 0x140e40,
    listen = 0x140ed0,
    accept = 0x140e20,
    recv = 0x140da0,
    send = 0x140de0,
    close = 0x140fa0,
    setsockopt = 0x140ef0,
    poll = 0x140fd0,
    fcntl = 0x141090,
    sock_error = 0x1412c0,

    -- JankFFI gadgets (from SDK .text)
    thunk_ptr = 0x8962c,
    launder = 0x75500,
    launder_arg1 = 0x38,
    launder_callee = 0x48,
    launder_arg0 = 0x50,

    fiber_switch = 0x12ee80,
    fiber_pop_gp = 0x3ba524,
    fiber_capture = 0x31d6c,

    -- Full-ABI gadgets for ffi_call.lua
    ctx_restore = 0x5672e4,
    ctx_save = 0x567370,
    fp_capture = 0x563658,
}

local GRAVITY_CIRCUIT = {
    -- Gravity Circuit 1.0.0 (title version 0), LÖVE 11.4, SDK 14.3.1.0
    ["gravity-circuit-v1.0"] = {
        id = "gravity-circuit-v1.0",
        game = "gravity-circuit",
        present = 0x239360,
        mod0 = 0x8,
        got_memcpy = 0x51a6e8,
        sdk = GC_SDK_14_3_1,
        expect = {
            present_head = "fd7bbea9f44f01a9fd030091081700d0",
            memcpy_head = "e80301cb090940923f0102eb22040054",
        },
    },

    -- Gravity Circuit 1.2.1 (title version 655360), LÖVE 11.4, SDK 14.3.1.0.
    -- Binary shipped 2024-10-08. Only the main module changed; SDK is identical.
    ["gravity-circuit-v1.2.1"] = {
        id = "gravity-circuit-v1.2.1",
        game = "gravity-circuit",
        present = 0x289c40,
        mod0 = 0x8,
        got_memcpy = 0x54d9e0,
        sdk = GC_SDK_14_3_1,
        expect = {
            present_head = "fd7bbea9f44f01a9fd030091481600d0",
            memcpy_head = "e80301cb090940923f0102eb22040054",
        },
    },
}
GRAVITY_CIRCUIT["gravity-circuit"] = {
    "gravity-circuit-v1.0",
    "gravity-circuit-v1.2.1",
}

-- Kingdom Rush (LÖVE 0.10.2, Switch) — offsets TBD
local KINGDOM_RUSH = {
    present = 0x0,
    mod0 = 0x0,
    got_memcpy = 0x0,
    sdk = {
        mod0 = 0x0,
        memcpy = 0x0,
        nifm_init = 0x0,
        nifm_submit_now = 0x0,
        nifm_ip = 0x0,
        sock_init = 0x0,
        socket = 0x0,
        bind = 0x0,
        listen = 0x0,
        accept = 0x0,
        recv = 0x0,
        send = 0x0,
        close = 0x0,
        setsockopt = 0x0,
        poll = 0x0,
        fcntl = 0x0,
        sock_error = 0x0,
        thunk_ptr = 0x0,
        launder = 0x0,
        launder_arg1 = 0x38,
        launder_callee = 0x48,
        launder_arg0 = 0x50,
        fiber_switch = 0x0,
        fiber_pop_gp = 0x0,
        fiber_capture = 0x0,
        ctx_restore = 0x0,
        ctx_save = 0x0,
        fp_capture = 0x0,
    },
    expect = {
        present_head = "",
        memcpy_head = "",
    },
}

return {
    ["gravity-circuit-v1.0"] = GRAVITY_CIRCUIT["gravity-circuit-v1.0"],
    ["gravity-circuit-v1.2.1"] = GRAVITY_CIRCUIT["gravity-circuit-v1.2.1"],
    ["gravity-circuit"] = GRAVITY_CIRCUIT["gravity-circuit"],
    ["kingdom-rush"] = KINGDOM_RUSH,
}
