import { netro } from './netro.js';
import { loadConfig, saveConfig, hasController, hasSensor, defaultConfig } from './config.js';

// ---------- State ----------
let config = loadConfig();
let runCtx = null;

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        switchTab(tab.dataset.tab);
    });
});

function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === name));
    if (name === 'settings') renderSettings();
    if (name === 'timeline') loadTimeline();
}

// ---------- Timeline ----------
const CONTROLLER_COLORS = ['#4cc2ff', '#b794f6', '#f6ad55', '#68d391', '#fc8181', '#f6e05e'];

function colorFor(serial) {
    if (!colorFor._map) colorFor._map = new Map();
    if (!colorFor._map.has(serial)) {
        colorFor._map.set(serial, CONTROLLER_COLORS[colorFor._map.size % CONTROLLER_COLORS.length]);
    }
    return colorFor._map.get(serial);
}

function toIsoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

async function loadTimeline() {
    const container = document.getElementById('timeline-content');
    const legend = document.getElementById('timeline-legend');

    if (!hasController(config)) {
        container.innerHTML = `<div class="placeholder">Add a controller in Settings first.</div>`;
        legend.innerHTML = '';
        return;
    }

    container.innerHTML = `<div class="loading">Loading…</div>`;

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const startStr = toIsoDate(start);
    const endStr = toIsoDate(end);

    // Look up zone names so blocks can be labelled.
    const infoByController = new Map();
    const schedulesByController = new Map();
    const errors = [];

    await Promise.all(config.controllers.map(async c => {
        try {
            const [info, schedules] = await Promise.all([
                netro.info(c.serial),
                netro.schedules(c.serial, { start_date: startStr, end_date: endStr }),
            ]);
            infoByController.set(c.serial, info);
            schedulesByController.set(c.serial, schedules);
        } catch (e) {
            errors.push(`${c.nickname}: ${e.message}`);
            schedulesByController.set(c.serial, []);
        }
    }));

    // Legend
    legend.innerHTML = config.controllers.map(c => `
        <span class="legend-item">
            <span class="legend-swatch" style="background:${colorFor(c.serial)}"></span>
            ${escapeHtml(c.nickname || c.serial)}
        </span>
    `).join('');

    // Build days
    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        days.push(d);
    }

    container.innerHTML = days.map(d => renderDayCard(d, schedulesByController, infoByController)).join('');

    if (errors.length) toast('Some schedules failed: ' + errors.join('; '), 'error');
}

function renderDayCard(dayDate, schedulesByController, infoByController) {
    const dayStart = new Date(dayDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const now = new Date();
    const isToday = now >= dayStart && now < dayEnd;
    const isPast = dayEnd <= now;

    const todayMidnight = new Date(); todayMidnight.setHours(0,0,0,0);
    const dayDiff = Math.round((dayStart - todayMidnight) / 86400000);
    let label;
    if (dayDiff === 0) label = 'Today';
    else if (dayDiff === 1) label = 'Tomorrow';
    else label = dayDate.toLocaleDateString(undefined, { weekday: 'long' });

    const dateStr = dayDate.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

    // Collect blocks per controller for this day.
    const lanes = config.controllers.map(c => {
        const scheds = (schedulesByController.get(c.serial) || []).filter(s => {
            const st = new Date(s.start_time);
            const en = new Date(s.end_time);
            return en > dayStart && st < dayEnd;
        });
        return { cfg: c, info: infoByController.get(c.serial), scheds };
    });

    const totalScheds = lanes.reduce((n, l) => n + l.scheds.length, 0);

    // Hour ruler (00, 06, 12, 18, 24)
    const hourTicks = [0, 6, 12, 18, 24].map(h => `
        <span class="hour-tick" style="left:${(h / 24) * 100}%"></span>
        <span class="hour-label" style="left:${(h / 24) * 100}%">${String(h).padStart(2, '0')}</span>
    `).join('');

    // "Now" line only for today
    let nowMarker = '';
    if (isToday) {
        const pct = ((now - dayStart) / 86400000) * 100;
        nowMarker = `<span class="timeline-now" style="left:${pct}%"></span>`;
    }

    const laneRows = lanes.map(({ cfg, info, scheds }) => {
        if (!scheds.length) {
            return `
                <div class="controller-lane">
                    <div class="lane-label">${escapeHtml(cfg.nickname || cfg.serial)}</div>
                    <div class="lane-track">${nowMarker}</div>
                </div>`;
        }
        const blocks = scheds.map(s => {
            const st = Math.max(new Date(s.start_time), dayStart);
            const en = Math.min(new Date(s.end_time), dayEnd);
            const leftPct = ((st - dayStart) / 86400000) * 100;
            const widthPct = Math.max(0.3, ((en - st) / 86400000) * 100);
            const zoneName = info?.zones?.find(z => z.ith === s.zone)?.name || `Zone ${s.zone}`;
            const past = en <= now ? 'past' : '';
            const tooltip = `${zoneName} · ${formatTime(new Date(s.start_time))}–${formatTime(new Date(s.end_time))} · ${Math.round((new Date(s.end_time) - new Date(s.start_time)) / 60000)} min`;
            return `
                <div class="water-block ${past}"
                     style="left:${leftPct}%; width:${widthPct}%; background:${colorFor(cfg.serial)}"
                     title="${escapeHtml(tooltip)}">${escapeHtml(zoneName)}</div>`;
        }).join('');
        return `
            <div class="controller-lane">
                <div class="lane-label">${escapeHtml(cfg.nickname || cfg.serial)}</div>
                <div class="lane-track">${nowMarker}${blocks}</div>
            </div>`;
    }).join('');

    return `
        <div class="day-card">
            <div class="day-header">
                <div>
                    <span class="day-name ${isToday ? 'today' : ''}">${label}</span>
                    <span class="day-date">${dateStr}</span>
                </div>
                ${totalScheds === 0 ? `<span class="day-empty">No waterings scheduled</span>` : ''}
            </div>
            ${totalScheds > 0 ? `
                <div class="hour-ruler">${hourTicks}</div>
                ${laneRows}
            ` : ''}
        </div>`;
}

function formatTime(d) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ---------- Toast ----------
function toast(msg, kind = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.hidden = true, 2800);
}

// ---------- Dashboard ----------
async function loadDashboard() {
    const refresh = document.getElementById('refresh-btn');
    refresh.classList.add('spinning');
    try {
        await Promise.all([loadControllers(), loadSensors()]);
    } catch (e) {
        toast('Failed to load: ' + e.message, 'error');
    } finally {
        refresh.classList.remove('spinning');
    }
}

async function loadControllers() {
    const container = document.getElementById('controllers');

    if (!hasController(config)) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No controllers yet</h3>
                <p>Add your first Netro controller in Settings to get started.</p>
                <button class="btn-primary" id="empty-go-settings">Open Settings</button>
            </div>`;
        document.getElementById('empty-go-settings').addEventListener('click', () => switchTab('settings'));
        return;
    }

    const cards = await Promise.all(config.controllers.map(async c => {
        try {
            const info = await netro.info(c.serial);
            return renderControllerCard(c, info, null);
        } catch (e) {
            return renderControllerCard(c, null, e.message);
        }
    }));

    container.innerHTML = cards.join('');
    wireCardEvents();
}

async function loadSensors() {
    const section = document.getElementById('sensors-section');
    const grid = document.getElementById('sensors');

    if (!hasSensor(config)) {
        section.hidden = true;
        return;
    }
    section.hidden = false;

    const cards = await Promise.all(config.sensors.map(async s => {
        try {
            const [info, dataArr] = await Promise.all([
                netro.sensorInfo(s.serial),
                netro.sensorData(s.serial).catch(() => []),
            ]);
            const latest = dataArr.length ? dataArr[dataArr.length - 1] : null;
            return renderSensorCard(s, info, latest, null);
        } catch (e) {
            return renderSensorCard(s, null, null, e.message);
        }
    }));

    grid.innerHTML = cards.join('');
}

function renderSensorCard(cfg, info, latest, errorMsg) {
    const name = cfg.nickname || info?.name || 'Sensor';

    if (errorMsg) {
        return `
            <div class="sensor-card">
                <div class="sensor-card-header">
                    <div>
                        <h3 class="sensor-name">${escapeHtml(name)}</h3>
                        <div class="sensor-serial">${escapeHtml(cfg.serial)}</div>
                    </div>
                    <span class="status-pill offline">error</span>
                </div>
                <div class="sensor-footer">${escapeHtml(errorMsg)}</div>
            </div>`;
    }

    const status = (info.status || '').toUpperCase();
    const isOffline = status === 'OFFLINE';
    const statusClass = isOffline ? 'offline' : '';
    const statusText = isOffline ? 'offline' : status.toLowerCase() || 'online';

    const batteryPct = info.battery_level != null ? Math.round(info.battery_level * 100) : null;
    const batteryClass = batteryPct == null ? '' : (batteryPct < 20 ? 'bad' : (batteryPct < 40 ? 'warn' : ''));
    const batteryDisplay = batteryPct != null ? `${batteryPct}%` : '—';

    // Latest reading: moisture (%) and temperature (°C). Light if present.
    const moisture = latest?.moisture != null ? `${Math.round(latest.moisture)}%` : '—';
    const temp = latest?.celsius != null
        ? `${latest.celsius.toFixed(1)}°C`
        : (latest?.fahrenheit != null ? `${(((latest.fahrenheit - 32) * 5) / 9).toFixed(1)}°C` : '—');

    const lastSeen = info.last_active ? formatAgo(info.last_active) : 'never';

    return `
        <div class="sensor-card">
            <div class="sensor-card-header">
                <div>
                    <h3 class="sensor-name">${escapeHtml(name)}</h3>
                    <div class="sensor-serial">${escapeHtml(cfg.serial)}</div>
                </div>
                <span class="status-pill ${statusClass}">${statusText}</span>
            </div>
            <div class="sensor-metrics">
                <div class="metric">
                    <div class="metric-label">Moisture</div>
                    <div class="metric-value">${moisture}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Temperature</div>
                    <div class="metric-value">${temp}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Battery</div>
                    <div class="metric-value ${batteryClass}">${batteryDisplay}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Last seen</div>
                    <div class="metric-value" style="font-size:13px;">${lastSeen}</div>
                </div>
            </div>
        </div>`;
}

function formatAgo(iso) {
    const then = new Date(iso);
    if (isNaN(then)) return iso;
    const diffMs = Date.now() - then.getTime();
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr ago`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day} day${day > 1 ? 's' : ''} ago`;
    const mo = Math.floor(day / 30);
    if (mo < 12) return `${mo} mo ago`;
    const yr = Math.floor(day / 365);
    return `${yr} yr${yr > 1 ? 's' : ''} ago`;
}

function renderControllerCard(cfg, info, errorMsg) {
    if (errorMsg) {
        return `
            <div class="controller-card">
                <div class="controller-card-header">
                    <div>
                        <h3 class="controller-name">${escapeHtml(cfg.nickname || 'Unnamed')}</h3>
                        <div class="controller-serial">${escapeHtml(cfg.serial)}</div>
                    </div>
                    <span class="status-pill offline">offline</span>
                </div>
                <div class="placeholder" style="padding:14px;">Couldn't reach controller: ${escapeHtml(errorMsg)}</div>
            </div>`;
    }

    const enabled = (info.status || '').toUpperCase() !== 'STANDBY';
    const statusClass = enabled ? '' : 'disabled';
    const statusText = enabled ? 'online' : 'standby';

    const activeZones = info.zones.filter(z => z.enabled);
    const zoneRows = activeZones.map(z => `
        <div class="zone-row" data-zone="${z.ith}">
            <div class="zone-info">
                <span class="zone-num">${z.ith}</span>
                <span class="zone-name">${escapeHtml(z.name)}</span>
            </div>
            <div class="zone-actions">
                <button data-action="run" data-serial="${cfg.serial}" data-zone="${z.ith}" data-zname="${escapeHtml(z.name)}">Run</button>
            </div>
        </div>
    `).join('');

    return `
        <div class="controller-card">
            <div class="controller-card-header">
                <div>
                    <h3 class="controller-name">${escapeHtml(cfg.nickname || info.name)}</h3>
                    <div class="controller-serial">${escapeHtml(cfg.serial)} · ${activeZones.length} of ${info.zone_num} zones active</div>
                </div>
                <span class="status-pill ${statusClass}">${statusText}</span>
            </div>
            <div class="zone-list">${zoneRows}</div>
            <div class="controller-actions">
                <button class="btn-secondary" data-action="stop" data-serial="${cfg.serial}">Stop all</button>
                <button class="btn-secondary" data-action="skip" data-serial="${cfg.serial}">Skip day…</button>
                <button class="btn-secondary" data-action="toggle" data-serial="${cfg.serial}" data-enabled="${enabled}">${enabled ? 'Disable' : 'Enable'}</button>
            </div>
        </div>`;
}

function wireCardEvents() {
    document.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', handleCardAction);
    });
}

async function handleCardAction(e) {
    const action = e.currentTarget.dataset.action;
    const serial = e.currentTarget.dataset.serial;
    try {
        if (action === 'run') {
            openRunModal(serial, +e.currentTarget.dataset.zone, e.currentTarget.dataset.zname);
        } else if (action === 'stop') {
            await netro.stopWater(serial);
            toast('Stopped', 'success');
        } else if (action === 'skip') {
            const days = prompt('Skip watering for how many days? (1-100)', '1');
            const n = parseInt(days);
            if (!n || n < 1 || n > 100) return;
            await netro.noWater(serial, n);
            toast(`Skipping ${n} day${n > 1 ? 's' : ''}`, 'success');
        } else if (action === 'toggle') {
            const wasEnabled = e.currentTarget.dataset.enabled === 'true';
            await netro.setStatus(serial, !wasEnabled);
            toast(wasEnabled ? 'Disabled' : 'Enabled', 'success');
            loadDashboard();
        }
    } catch (err) {
        toast('Error: ' + err.message, 'error');
    }
}

// ---------- Run modal ----------
function openRunModal(serial, zone, zname) {
    runCtx = { serial, zone };
    document.getElementById('run-modal-body').textContent = `Zone ${zone}: ${zname}`;
    document.getElementById('run-duration').value = '10';
    document.getElementById('run-modal').hidden = false;
    document.getElementById('run-duration').focus();
}

function closeRunModal() {
    document.getElementById('run-modal').hidden = true;
    runCtx = null;
}

document.getElementById('run-confirm').addEventListener('click', async () => {
    if (!runCtx) return;
    const min = parseInt(document.getElementById('run-duration').value);
    if (!min || min < 1) { toast('Enter a duration', 'error'); return; }
    try {
        await netro.water(runCtx.serial, [runCtx.zone], min);
        toast(`Watering started (${min} min)`, 'success');
        closeRunModal();
    } catch (e) {
        toast('Error: ' + e.message, 'error');
    }
});

document.querySelectorAll('[data-close-modal]').forEach(b =>
    b.addEventListener('click', closeRunModal)
);

document.getElementById('run-modal').addEventListener('click', (e) => {
    if (e.target.id === 'run-modal') closeRunModal();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('run-modal').hidden) closeRunModal();
});

// ---------- Settings ----------
function renderSettings() {
    document.getElementById('borehole-lpm').value = config.borehole_capacity_lpm ?? '';

    renderEditList(
        'controller-edit-list',
        config.controllers,
        'controller',
        'Cart Lodge',
        i => {
            captureSettingsToConfig();
            config.controllers.splice(i, 1);
            renderSettings();
        }
    );

    renderEditList(
        'sensor-edit-list',
        config.sensors,
        'sensor',
        'Yew Hedge sensor',
        i => {
            captureSettingsToConfig();
            config.sensors.splice(i, 1);
            renderSettings();
        }
    );
}

function renderEditList(elementId, items, kind, nicknamePlaceholder, onRemove) {
    const list = document.getElementById(elementId);
    if (!items.length) {
        list.innerHTML = `<p class="hint">No ${kind}s added yet. Click + Add ${kind} below.</p>`;
        return;
    }
    list.innerHTML = items.map((c, i) => `
        <div class="controller-edit-row" data-i="${i}">
            <div class="row-head">
                <label class="field">
                    <span>Nickname</span>
                    <input class="ec-nick-${kind}" type="text" value="${escapeHtml(c.nickname || '')}" placeholder="e.g. ${escapeHtml(nicknamePlaceholder)}">
                </label>
                <label class="field">
                    <span>Serial number</span>
                    <input class="ec-serial-${kind}" type="text" value="${escapeHtml(c.serial || '')}" placeholder="12-char hex">
                </label>
                <button class="btn-danger" data-remove="${i}">Remove</button>
            </div>
        </div>
    `).join('');

    list.querySelectorAll('[data-remove]').forEach(b => {
        b.addEventListener('click', () => onRemove(+b.dataset.remove));
    });
}

function captureSettingsToConfig() {
    const cNicks = [...document.querySelectorAll('.ec-nick-controller')];
    const cSerials = [...document.querySelectorAll('.ec-serial-controller')];
    config.controllers = cNicks.map((n, i) => ({
        serial: cSerials[i].value.trim().toLowerCase(),
        nickname: n.value.trim() || 'Controller',
        zone_flow_lpm: config.controllers[i]?.zone_flow_lpm ?? {},
    }));

    const sNicks = [...document.querySelectorAll('.ec-nick-sensor')];
    const sSerials = [...document.querySelectorAll('.ec-serial-sensor')];
    config.sensors = sNicks.map((n, i) => ({
        serial: sSerials[i].value.trim().toLowerCase(),
        nickname: n.value.trim(),
    }));

    const bh = document.getElementById('borehole-lpm').value;
    config.borehole_capacity_lpm = bh ? parseFloat(bh) : null;
}

document.getElementById('add-controller').addEventListener('click', () => {
    captureSettingsToConfig();
    config.controllers.push({ serial: '', nickname: '', zone_flow_lpm: {} });
    renderSettings();
});

document.getElementById('add-sensor').addEventListener('click', () => {
    captureSettingsToConfig();
    config.sensors.push({ serial: '', nickname: '' });
    renderSettings();
});

document.getElementById('save-config').addEventListener('click', async () => {
    captureSettingsToConfig();

    // Drop rows without a serial.
    config.controllers = config.controllers.filter(c => c.serial);
    config.sensors = config.sensors.filter(s => s.serial);

    const status = document.getElementById('save-status');
    status.textContent = 'Validating…';

    // Quick validation: ping each device; flag any that fail.
    const failures = [];
    for (const c of config.controllers) {
        try { await netro.info(c.serial); }
        catch (e) { failures.push(`${c.nickname || c.serial}: ${e.message}`); }
    }
    for (const s of config.sensors) {
        try { await netro.sensorInfo(s.serial); }
        catch (e) { failures.push(`${s.nickname || s.serial}: ${e.message}`); }
    }

    saveConfig(config);
    status.textContent = failures.length ? 'Saved with warnings' : 'Saved';
    if (failures.length) {
        toast('Saved, but some devices failed: ' + failures.join('; '), 'error');
    } else {
        toast('Settings saved', 'success');
    }
    setTimeout(() => status.textContent = '', 2500);
    loadDashboard();
});

// ---------- Refresh ----------
document.getElementById('refresh-btn').addEventListener('click', loadDashboard);

// ---------- Utils ----------
function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

// ---------- Init ----------
if (!hasController(config)) switchTab('settings');
loadDashboard();
