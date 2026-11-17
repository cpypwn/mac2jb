// CivSwitchFS + kaiHEN combined payload — promotion, then the kaiHEN
// chain, in one eval. Step 1 of the persistent chain: with this entry no
// PC orchestration sits between the two halves, so the same sequence can
// later run from the persisted save image.
//
// tools/kaihen.mjs normally sets __KH_MODE / __KH_SKIP / __KH_MANIFEST
// through prelude evals before sending src/kaihen.js. This entry sets
// them itself: default skips (dx, probes — their doomed sends close the
// loader session copy per the SessionClosed verdict), and the
// version-pinned SD manifest from kaihen/state.mjs. The ship files must
// already be staged on the card (run the kaiHEN launcher once, or copy
// /kaihen/bin, /hbmenu.nro and /switch/ounceshell.nro manually).

import coreRuntime from "./core/runtime.mjs";
import {run as runPromotion} from "./core.js";
import {run as runKaihen} from "./kaihen.js";
import {SD_MANIFEST} from "./kaihen/state.mjs";

const {log} = coreRuntime;

export async function run() {
    await runPromotion();

    // Gate on the retained-boot snapshot the chain re-derives from. A
    // promotion lottery loss ends here, cleanly: restart the game and the
    // whole sequence runs again.
    const state = globalThis.fsKaihen;
    if (!state || !state.domainSession) {
        await log("CHAIN: promotion did not retain a session — " +
            "kaiHEN not started; restart the game to retry");
        return;
    }

    await log("CHAIN: promotion retained a session — starting kaiHEN");
    globalThis.__KH_MODE = "run";
    globalThis.__KH_SKIP = ["dx", "probes"];
    globalThis.__KH_MANIFEST = SD_MANIFEST;
    await runKaihen();
}
