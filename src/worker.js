'use strict';
// Wake on persisted work; idle polling is rare so a free database can suspend.
function createWorker(deliver, nextWake) {
    let timer, running = false, requested = false, stopped = false;
    async function run() {
        if (stopped) return;
        if (running) { requested = true; return; }
        running = true; requested = false;
        let delay = 60000;
        try { await deliver(); delay = await nextWake(); }
        catch { console.error('Delivery worker unavailable; retrying'); }
        finally {
            running = false;
            if (!stopped) { timer = setTimeout(run, requested ? 0 : delay); timer.unref(); }
        }
    }
    return {
        wake() { if (stopped) return; clearTimeout(timer); void run(); },
        stop() { stopped = true; clearTimeout(timer); }
    };
}
module.exports = { createWorker };
