// Config persistence — stored in browser localStorage. Per-device.
// Nothing leaves your browser except API calls to api.netrohome.com.

const STORAGE_KEY = 'netro-desktop-config-v1';

export function defaultConfig() {
    return {
        controllers: [],
        sensors: [],
        borehole_capacity_lpm: null,
        default_zone_flow_lpm: null,
    };
}

export function loadConfig() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    try {
        const cfg = JSON.parse(raw);
        if (!Array.isArray(cfg.controllers)) cfg.controllers = [];
        if (!Array.isArray(cfg.sensors)) cfg.sensors = [];
        return cfg;
    } catch {
        return defaultConfig();
    }
}

export function saveConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function hasController(cfg) {
    return Array.isArray(cfg.controllers) && cfg.controllers.length > 0;
}

export function hasSensor(cfg) {
    return Array.isArray(cfg.sensors) && cfg.sensors.length > 0;
}
