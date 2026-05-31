// Config persistence.
// - Primary source of truth: Cloudflare Worker KV (if Worker URL + token are set).
//   That makes config the same on every device.
// - localStorage acts as a cache for fast first-paint + offline fallback.

const STORAGE_KEY = 'netro-desktop-config-v1';
const WORKER_STORE = 'netro-desktop-worker-v1';

export function defaultConfig() {
    return {
        controllers: [],
        sensors: [],
        borehole_capacity_lpm: null,
        default_zone_flow_lpm: null,
    };
}

function normalize(cfg) {
    cfg = cfg || {};
    if (!Array.isArray(cfg.controllers)) cfg.controllers = [];
    if (!Array.isArray(cfg.sensors)) cfg.sensors = [];
    return { ...defaultConfig(), ...cfg };
}

// --- localStorage cache ---

export function loadLocal() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    try { return normalize(JSON.parse(raw)); }
    catch { return defaultConfig(); }
}

export function saveLocal(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

// --- Worker credentials (per-device) ---

export function loadWorkerCreds() {
    const raw = localStorage.getItem(WORKER_STORE);
    if (!raw) return { url: '', token: '' };
    try { return JSON.parse(raw); } catch { return { url: '', token: '' }; }
}

export function saveWorkerCreds(creds) {
    localStorage.setItem(WORKER_STORE, JSON.stringify(creds));
}

export function hasWorkerCreds() {
    const c = loadWorkerCreds();
    return !!(c.url && c.token);
}

// --- Cloud (Worker) read/write ---

export async function fetchFromWorker() {
    const c = loadWorkerCreds();
    const r = await fetch(`${c.url}/config`, { headers: { Authorization: `Bearer ${c.token}` } });
    if (!r.ok) throw new Error(`Worker /config → ${r.status}`);
    return r.json();
}

export async function pushToWorker(cfg) {
    const c = loadWorkerCreds();
    const r = await fetch(`${c.url}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` },
        body: JSON.stringify(cfg),
    });
    if (!r.ok) throw new Error(`Worker save → ${r.status}`);
}

// --- High-level load/save ---
// loadConfig: returns the best available config (cloud if reachable, cache otherwise)
// + a `source` field so the UI can show "synced" vs "offline cache".

export async function loadConfig() {
    const cached = loadLocal();
    if (hasWorkerCreds()) {
        try {
            const cloud = normalize(await fetchFromWorker());
            // Migration: if cloud is missing things that local has (e.g. sensors
            // not yet pushed up), surface local values so nothing's lost. The
            // next save will persist them.
            if (cached.sensors?.length && !cloud.sensors?.length) cloud.sensors = cached.sensors;
            if (cached.controllers?.length && !cloud.controllers?.length) cloud.controllers = cached.controllers;
            saveLocal(cloud);
            return { cfg: cloud, source: 'cloud' };
        } catch (e) {
            console.warn('Worker unreachable, using cached config:', e);
            return { cfg: cached, source: 'cache' };
        }
    }
    return { cfg: cached, source: 'local' };
}

// saveConfig: writes to localStorage immediately, then to the Worker if creds set.
// Returns whether the cloud write succeeded.
export async function saveConfig(cfg) {
    saveLocal(cfg);
    if (!hasWorkerCreds()) return { cloud: 'none' };
    try {
        // Round-trip merge so we don't clobber fields the dashboard doesn't own
        // (patterns, last_run).
        const existing = await fetchFromWorker().catch(() => ({}));
        const merged = {
            ...existing,
            controllers: cfg.controllers,
            sensors: cfg.sensors,
            borehole_capacity_lpm: cfg.borehole_capacity_lpm,
            default_zone_flow_lpm: cfg.default_zone_flow_lpm,
        };
        await pushToWorker(merged);
        return { cloud: 'ok' };
    } catch (e) {
        return { cloud: 'failed', error: e.message };
    }
}

export function hasController(cfg) {
    return Array.isArray(cfg.controllers) && cfg.controllers.length > 0;
}

export function hasSensor(cfg) {
    return Array.isArray(cfg.sensors) && cfg.sensors.length > 0;
}
