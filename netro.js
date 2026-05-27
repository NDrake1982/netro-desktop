// Netro Public API (NPA) client — calls the Netro service directly from the browser.
// CORS is enabled API-side (Access-Control-Allow-Origin: *).
// Docs: http://www.netrohome.com/en/shop/articles/10
// Auth: each controller's serial number is its API "key".

const BASE = 'https://api.netrohome.com/npa/v1';

async function call(method, path, params = null, body = null) {
    const url = new URL(BASE + path);
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) url.searchParams.set(k, v);
        }
    }
    const init = { method, headers: {} };
    if (body !== null) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const resp = await fetch(url, init);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.status !== 'OK') {
        const msg = (json.errors && json.errors[0] && json.errors[0].message) || `status=${json.status}`;
        throw new Error(msg);
    }
    return json.data;
}

export const netro = {
    async info(serial) {
        const d = await call('GET', '/info.json', { key: serial });
        return d.device;
    },

    // Whisperer plant sensors share the same /info endpoint but the payload is `sensor` not `device`.
    async sensorInfo(serial) {
        const d = await call('GET', '/info.json', { key: serial });
        return d.sensor;
    },

    async sensorData(serial, { start_date, end_date } = {}) {
        const d = await call('GET', '/sensor_data.json', { key: serial, start_date, end_date });
        return d.sensor_data || [];
    },

    async schedules(serial, { start_date, end_date } = {}) {
        const d = await call('GET', '/schedules.json', { key: serial, start_date, end_date });
        return d.schedules || [];
    },

    async water(serial, zones, duration_min, { delay_min, start_time } = {}) {
        const body = { key: serial, zones, duration: duration_min };
        if (delay_min !== undefined) body.delay = delay_min;
        if (start_time !== undefined) body.start_time = start_time;
        await call('POST', '/water.json', null, body);
    },

    async stopWater(serial) {
        await call('POST', '/stop_water.json', null, { key: serial });
    },

    async noWater(serial, days) {
        await call('POST', '/no_water.json', null, { key: serial, days });
    },

    async setStatus(serial, enabled) {
        await call('POST', '/set_status.json', null, { key: serial, status: enabled ? 1 : 0 });
    },
};
