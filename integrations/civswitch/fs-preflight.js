(async function () {
    const marker = 'MAC2JB_CIVSWITCH_FS';
    const required = ['read8', 'read16', 'read32', 'read64', 'write8', 'write16',
        'write32', 'write64', 'call_rop', 'malloc', 'free', 'alloc_string'];
    const missing = required.filter(name => {
        try { return typeof eval(name) !== 'function'; }
        catch { return true; }
    });
    if (missing.length || typeof sdk_base !== 'bigint') {
        await log(marker + ' ' + JSON.stringify({stage: 'primitives', ready: false,
            missing, sdkBase: typeof sdk_base}));
        return;
    }

    await log(marker + ' ' + JSON.stringify({stage: 'primitives', ready: true}));
    const openDir = sdk_base + 0xa7bb0n;
    const closeDir = sdk_base + 0xa57b0n;
    const output = malloc(8);
    try {
        for (const name of ['save:/saves', 'save:/']) {
            const path = alloc_string(name);
            try {
                const result = call_rop(openDir, output, path, 3n);
                if (result === 0n) {
                    const handle = read64(output);
                    call_rop(closeDir, handle);
                    await log(marker + ' ' + JSON.stringify({stage: 'mounted-save',
                        ready: true, path: name}));
                    return;
                }
                await log(marker + ' ' + JSON.stringify({stage: 'mount-attempt',
                    path: name, result: result.toString(16)}));
            } finally {
                free(path);
            }
        }
        await log(marker + ' ' + JSON.stringify({stage: 'mounted-save', ready: false}));
    } finally {
        free(output);
    }
})().catch(error => log('MAC2JB_CIVSWITCH_FS ' + JSON.stringify({stage: 'error',
    message: String(error && error.message || error)})));
