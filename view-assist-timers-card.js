/**
 * View Assist Timers Card
 * Shows all active timers, alarms, and reminders from the View Assist integration.
 *
 * Configuration (Lovelace YAML):
 *   type: custom:view-assist-timers-card
 *   title: "Timers, Alarms & Reminders"   # set to '' to hide header
 *   show_types: [timer, alarm, reminder]   # default: all three
 *   display_mode: bar                      # 'bar' (default) or 'horseshoe'
 *   columns: 2                             # tiles per row in horseshoe mode
 *   max_height: 300                        # px — enables scrolling; 0 = no limit (default)
 *   hide_when_empty: false                 # hide card in-place when no active alarms
 *   float_when_active: false               # hide in dashboard, float as overlay when alarms active
 *   float_position: bottom-right           # bottom-right | bottom-left | top-right | top-left
 *   show_ringing_popup: true               # floating popup when an alarm rings
 *   popup_movable: true                    # allow ringing popup / float card to be dragged
 *   snooze_options: [5, 10]               # snooze minutes in ringing popup
 *   show_add_button: false                 # show + button to manually create timers/alarms
 *   create_service: set_timer             # View Assist service for creating — adjust if needed
 *   refresh_interval: 5                    # seconds between API polls
 *
 * Installation: copy to config/www/ and add to Lovelace resources:
 *   url: /local/view-assist-timers-card.js
 *   type: module
 */

class ViewAssistTimersCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config         = {};
    this._hass           = null;
    this._timers         = [];
    this._loading        = true;
    this._error          = null;
    this._refreshInterval = null;
    this._tickInterval   = null;
    this._finishTimes    = {};
    this._totalSeconds   = {};
    this._popupEl        = null;
    this._popupRingingIds = null;
    this._floatingHost   = null;   // card overlay element when float_when_active
    this._showAddPanel   = false;  // add-timer panel open/closed
    this._addType        = 'timer'; // selected type in add panel
    this._localTimers    = [];     // browser-local timers (no HA service)
  }

  static getConfigElement() {
    return document.createElement('view-assist-timers-card-editor');
  }

  static getStubConfig() {
    return { title: 'Timers, Alarms & Reminders', display_mode: 'bar' };
  }

  setConfig(config) {
    this._config = {
      title:              'title' in config ? config.title : 'Timers, Alarms & Reminders',
      show_types:         config.show_types || ['timer', 'alarm', 'reminder'],
      refresh_interval:   (config.refresh_interval ?? 5) * 1000,
      display_mode:       config.display_mode || 'bar',
      columns:            Math.max(1, config.columns || 2),
      max_height:         config.max_height || 0,
      hide_when_empty:    config.hide_when_empty ?? false,
      float_when_active:  config.float_when_active ?? false,
      float_position:     config.float_position || 'bottom-right',
      show_ringing_popup: config.show_ringing_popup ?? true,
      popup_movable:      config.popup_movable ?? true,
      snooze_options:     config.snooze_options || [5, 10],
      snooze_time:        config.snooze_time || '10 minutes',
      show_add_button:    config.show_add_button ?? false,
      create_service:     config.create_service || 'set_timer',
      // va_entity_ids: array of VA satellite entity IDs to show/create timers for.
      // Empty = show all devices. Migrates legacy va_entity_id string automatically.
      va_entity_ids: config.va_entity_ids
        || (config.va_entity_id ? [config.va_entity_id] : []),
    };
    this._loadLocalTimers();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._fetchTimers();
      this._refreshInterval = setInterval(() => this._fetchTimers(), this._config.refresh_interval);
      this._tickInterval    = setInterval(() => this._tickCountdowns(), 1000);
    }
  }

  disconnectedCallback() {
    clearInterval(this._refreshInterval);
    clearInterval(this._tickInterval);
    this._refreshInterval = null;
    this._tickInterval    = null;
    this._hideRingingPopup();
    this._removeFloatingCard();
  }

  // Horseshoe geometry for r=38: circumference ≈ 238.76, 270° arc ≈ 179.07
  static get _HS_C()   { return 238.76; }
  static get _HS_ARC() { return 179.07; }

  // ── Floating card helpers ──────────────────────────────────────────────────

  _getCardRoot() {
    if (this._config.float_when_active && this._floatingHost) {
      return this._floatingHost.shadowRoot;
    }
    return this.shadowRoot;
  }

  _ensureFloatingCard() {
    if (this._floatingHost) return;
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' });
    const POSITIONS = {
      'bottom-right': 'bottom:24px;right:24px',
      'bottom-left':  'bottom:24px;left:24px',
      'top-right':    'top:80px;right:24px',
      'top-left':     'top:80px;left:24px',
    };
    const pos = POSITIONS[this._config.float_position] || POSITIONS['bottom-right'];
    host.style.cssText = `position:fixed;${pos};z-index:9998;width:340px;`;
    document.body.appendChild(host);
    if (this._config.popup_movable) this._makePopupDraggable(host);
    this._floatingHost = host;
  }

  _removeFloatingCard() {
    if (this._floatingHost) {
      this._floatingHost.remove();
      this._floatingHost = null;
    }
  }

  // ── Data fetching ──────────────────────────────────────────────────────────

  async _fetchTimers() {
    if (!this._hass) return;
    try {
      const wsResult = await this._hass.callWS({
        type: 'call_service',
        domain: 'view_assist',
        service: 'get_timers',
        service_data: { include_expired: true },
        return_response: true,
      });
      const fetchedAt = Date.now();
      const raw = wsResult?.response?.result ?? wsResult?.response?.timers
               ?? wsResult?.result ?? wsResult?.timers ?? wsResult ?? [];
      this._timers  = Array.isArray(raw) ? raw : [];
      this._loading = false;
      this._error   = null;
      // Debug: log raw timer data so field names are visible in the browser console
      if (this._timers.length > 0) {
        console.log('[VATC] timer data sample:', JSON.stringify(this._timers[0]));
        console.log('[VATC] all statuses:', [...new Set(this._timers.map(t => t.status))]);
      }
      this._updateFinishTimes(fetchedAt);
      this._updateTotalSeconds();
    } catch (err) {
      this._loading = false;
      this._error   = 'View Assist unavailable';
      console.error('[view-assist-timers-card]', err);
    }
    this._render();
  }

  // Normalize the timer ID to a string regardless of field name used by the API
  _id(t) {
    const raw = t.id ?? t.timer_id ?? t.uuid ?? t.entity_id;
    return raw != null ? String(raw) : '';
  }

  // In View Assist, a fired alarm/timer has status 'expired' — that IS the ringing state
  _isRinging(t) {
    return String(t.status ?? '').toLowerCase() === 'expired';
  }

  _updateFinishTimes(fetchedAt) {
    const activeIds = new Set(this._timers.map(t => this._id(t)));
    Object.keys(this._finishTimes).forEach(id => {
      if (!activeIds.has(id)) delete this._finishTimes[id];
    });
    this._timers.forEach(t => {
      const id = this._id(t);
      if (!id) return;
      const ft = this._parseFinishTime(t, fetchedAt);
      if (ft) this._finishTimes[id] = ft;
    });
  }

  _updateTotalSeconds() {
    const activeIds = new Set(this._timers.map(t => this._id(t)));
    Object.keys(this._totalSeconds).forEach(id => {
      if (!activeIds.has(id)) delete this._totalSeconds[id];
    });
    this._timers.forEach(t => {
      const id = this._id(t);
      if (!id || this._totalSeconds[id]) return;
      for (const key of ['duration', 'total_duration', 'original_duration']) {
        const n = Number(t[key]);
        if (!isNaN(n) && n > 0) { this._totalSeconds[id] = n; return; }
      }
      for (const key of ['seconds_remaining', 'remaining_seconds', 'remaining', 'time_remaining', 'seconds_left']) {
        if (t[key] != null) { this._totalSeconds[id] = Number(t[key]); return; }
      }
      if (t.expiry?.seconds_remaining != null) {
        this._totalSeconds[id] = Number(t.expiry.seconds_remaining);
      }
    });
  }

  _parseFinishTime(timer, fetchedAt) {
    for (const key of ['finish_time', 'end_time', 'expiry_time', 'due_time', 'expires_at', 'fire_time', 'trigger_time', 'alarm_time']) {
      const val = timer[key];
      if (val == null) continue;
      const ts = typeof val === 'number' ? (val > 1e10 ? val : val * 1000) : new Date(val).getTime();
      if (!isNaN(ts)) return ts;
    }
    if (timer.expiry?.timestamp) {
      const ts = new Date(timer.expiry.timestamp).getTime();
      if (!isNaN(ts)) return ts;
    }
    for (const key of ['seconds_remaining', 'remaining_seconds', 'remaining', 'time_remaining', 'seconds_left']) {
      if (timer[key] != null) return fetchedAt + Number(timer[key]) * 1000;
    }
    if (timer.expiry?.seconds_remaining != null) {
      return fetchedAt + Number(timer.expiry.seconds_remaining) * 1000;
    }
    return null;
  }

  // ── Countdown & progress ───────────────────────────────────────────────────

  _getCountdown(timer) {
    const ft = this._finishTimes[this._id(timer)];
    if (ft != null) {
      const secs = Math.max(0, Math.floor((ft - Date.now()) / 1000));
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return timer.expiry?.text || timer.duration || '—';
  }

  _getProgress(timerId) {
    const ft    = this._finishTimes[timerId];
    const total = this._totalSeconds[timerId];
    if (!ft || !total) return 0;
    const remaining = Math.max(0, (ft - Date.now()) / 1000);
    return Math.min(1, Math.max(0, 1 - remaining / total));
  }

  // ── Tick loop ──────────────────────────────────────────────────────────────

  _tickCountdowns() {
    this._tickLocalTimers();
    const root = this._getCardRoot();
    if (!root) return;

    const allTimers = [...this._timers, ...this._localTimers];
    root.querySelectorAll('[data-timer-id]').forEach(el => {
      const t = allTimers.find(t => this._id(t) === el.dataset.timerId);
      if (t) el.textContent = this._getCountdown(t);
    });

    root.querySelectorAll('[data-progress-id]').forEach(el => {
      const t = allTimers.find(t => this._id(t) === el.dataset.progressId);
      if (t && !this._isRinging(t)) el.style.width = `${this._getProgress(this._id(t)) * 100}%`;
    });

    const { _HS_C: C, _HS_ARC: ARC } = ViewAssistTimersCard;
    root.querySelectorAll('[data-horseshoe-id]').forEach(el => {
      const t = allTimers.find(t => this._id(t) === el.dataset.horseshoeId);
      if (!t || this._isRinging(t)) return;
      const arcLen = this._getProgress(this._id(t)) * ARC;
      el.setAttribute('stroke-dasharray', `${arcLen.toFixed(2)} ${(C - arcLen).toFixed(2)}`);
    });

    this._checkRingingPopup();
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async _cancelTimer(id) {
    try {
      await this._hass.callService('view_assist', 'cancel_timer', { timer_id: id });
    } catch (e) {
      console.error('[view-assist-timers-card] cancel_timer failed', e);
    }
    delete this._finishTimes[id];
    delete this._totalSeconds[id];
    setTimeout(() => this._fetchTimers(), 700);
  }

  async _snoozeTimer(id, minutes) {
    const time = minutes ? `${minutes} minutes` : this._config.snooze_time;
    try {
      await this._hass.callService('view_assist', 'snooze_timer', { timer_id: id, time });
    } catch (e) {
      console.error('[view-assist-timers-card] snooze_timer failed', e);
    }
    setTimeout(() => this._fetchTimers(), 700);
  }

  // ── Local timers (browser-only, no HA service) ────────────────────────────

  _loadLocalTimers() {
    try {
      const raw = localStorage.getItem('vatc-local-timers');
      this._localTimers = raw ? JSON.parse(raw) : [];
    } catch { this._localTimers = []; }
    this._injectLocalFinishTimes();
  }

  _saveLocalTimers() {
    localStorage.setItem('vatc-local-timers', JSON.stringify(this._localTimers));
  }

  _injectLocalFinishTimes() {
    this._localTimers.forEach(t => {
      const total = t.duration_ms / 1000;
      if (t.status === 'active' && t.end_ts) {
        this._finishTimes[t.id]  = t.end_ts;
        this._totalSeconds[t.id] = total;
      } else if (t.status === 'paused' && t.paused_remaining_ms != null) {
        this._finishTimes[t.id]  = Date.now() + t.paused_remaining_ms;
        this._totalSeconds[t.id] = total;
      } else if (t.status === 'expired') {
        this._finishTimes[t.id]  = Date.now();
        this._totalSeconds[t.id] = total;
      }
    });
  }

  _tickLocalTimers() {
    const now = Date.now();
    let changed = false;
    this._localTimers.forEach(t => {
      if (t.status === 'active' && t.end_ts <= now) {
        t.status = 'expired';
        changed = true;
      }
      if (t.status === 'paused' && t.paused_remaining_ms != null) {
        this._finishTimes[t.id] = now + t.paused_remaining_ms;
      }
    });
    if (changed) { this._saveLocalTimers(); this._render(); }
  }

  _createLocalTimer(name, durationMs) {
    const now = Date.now();
    const t = {
      id: `local-${now}`,
      timer_class: 'local',
      name: name || 'Timer',
      status: 'active',
      duration_ms: durationMs,
      end_ts: now + durationMs,
      paused_remaining_ms: null,
    };
    this._localTimers.push(t);
    this._finishTimes[t.id]  = t.end_ts;
    this._totalSeconds[t.id] = durationMs / 1000;
    this._saveLocalTimers();
  }

  _cancelLocalTimer(id) {
    this._localTimers = this._localTimers.filter(t => t.id !== id);
    delete this._finishTimes[id];
    delete this._totalSeconds[id];
    this._saveLocalTimers();
    this._render();
  }

  _pauseLocalTimer(id) {
    const t = this._localTimers.find(t => t.id === id);
    if (!t || t.status !== 'active') return;
    t.paused_remaining_ms = Math.max(0, t.end_ts - Date.now());
    t.status = 'paused';
    this._finishTimes[t.id] = Date.now() + t.paused_remaining_ms;
    this._saveLocalTimers();
    this._render();
  }

  _resumeLocalTimer(id) {
    const t = this._localTimers.find(t => t.id === id);
    if (!t || t.status !== 'paused') return;
    t.end_ts = Date.now() + t.paused_remaining_ms;
    t.paused_remaining_ms = null;
    t.status = 'active';
    this._finishTimes[t.id] = t.end_ts;
    this._saveLocalTimers();
    this._render();
  }

  _restartLocalTimer(id) {
    const t = this._localTimers.find(t => t.id === id);
    if (!t) return;
    t.end_ts = Date.now() + t.duration_ms;
    t.paused_remaining_ms = null;
    t.status = 'active';
    this._finishTimes[t.id] = t.end_ts;
    this._saveLocalTimers();
    this._render();
  }

  async _createTimer() {
    const root = this._getCardRoot();
    const type = this._addType || 'timer';
    const name = root.querySelector('.add-name')?.value?.trim() || '';
    const serviceData = {};
    if (name) serviceData.name = name;

    if (type === 'local') {
      const h = parseInt(root.querySelector('.add-h')?.value) || 0;
      const m = parseInt(root.querySelector('.add-m')?.value) || 0;
      const s = parseInt(root.querySelector('.add-s')?.value) || 0;
      const totalMs = (h * 3600 + m * 60 + s) * 1000;
      if (totalMs === 0) return;
      this._createLocalTimer(name, totalMs);
      this._showAddPanel = false;
      this._render();
      return;
    }

    // All types use view_assist.set_timer; the 'type' field differentiates them
    serviceData.type = type;
    // entity_id is required by the View Assist set_timer service.
    // Always use the first (primary) entity in va_entity_ids.
    const primaryEntity = this._config.va_entity_ids[0] || '';
    if (primaryEntity) serviceData.entity_id = primaryEntity;

    if (type === 'timer') {
      const h = parseInt(root.querySelector('.add-h')?.value) || 0;
      const m = parseInt(root.querySelector('.add-m')?.value) || 0;
      const s = parseInt(root.querySelector('.add-s')?.value) || 0;
      if (h + m + s === 0) return;
      const parts = [];
      if (h > 0) parts.push(`${h} hour${h !== 1 ? 's' : ''}`);
      if (m > 0) parts.push(`${m} minute${m !== 1 ? 's' : ''}`);
      if (s > 0) parts.push(`${s} second${s !== 1 ? 's' : ''}`);
      serviceData.time = parts.join(' ');
    } else {
      const timeVal = root.querySelector('.add-time')?.value; // HH:MM
      if (!timeVal) return;
      serviceData.time = timeVal;
    }

    try {
      await this._hass.callService('view_assist', this._config.create_service, serviceData);
    } catch (e) {
      console.error('[view-assist-timers-card] create timer failed', e);
    }
    this._showAddPanel = false;
    setTimeout(() => this._fetchTimers(), 700);
    this._render();
  }

  // ── Main card rendering ────────────────────────────────────────────────────

  _render() {
    if (!this.shadowRoot) return;

    const { show_types, title, display_mode, max_height,
            hide_when_empty, float_when_active, show_add_button, va_entity_ids } = this._config;

    // Include expired timers — 'expired' IS the fired/ringing state in View Assist.
    // If specific VA entities are configured, filter to those; otherwise show all.
    const active = [
      ...this._timers.filter(t =>
        show_types.includes(t.timer_class) &&
        (va_entity_ids.length === 0 || va_entity_ids.includes(t.entity_id))
      ),
      ...this._localTimers,
    ];

    // Build friendly-name lookup for device badges (shown when timers span multiple devices)
    const deviceLabel = {};
    active.forEach(t => {
      if (t.entity_id && !(t.entity_id in deviceLabel)) {
        const friendly = this._hass?.states?.[t.entity_id]?.attributes?.friendly_name;
        deviceLabel[t.entity_id] = friendly || t.entity_id;
      }
    });
    const multiDevice = Object.keys(deviceLabel).length > 1;

    // ── Float mode: card lives as a body overlay, not in the dashboard grid ──
    if (float_when_active) {
      this.style.display = 'none';
      if (active.length === 0) {
        this._removeFloatingCard();
        return;
      }
      this._ensureFloatingCard();
    } else {
      this.style.display = (hide_when_empty && active.length === 0) ? 'none' : '';
    }

    const root = this._getCardRoot();
    const isFloating = float_when_active && !!this._floatingHost;

    // ── Build META / groups / list HTML (needed by both full and partial render) ──

    const META = {
      timer:    { icon: 'mdi:timer-outline', label: 'Timers',       color: '#039be5' },
      alarm:    { icon: 'mdi:alarm',         label: 'Alarms',       color: '#e53935' },
      reminder: { icon: 'mdi:reminder',      label: 'Reminders',    color: '#fb8c00' },
      local:    { icon: 'mdi:timer-sand',    label: 'Local Timers', color: '#26a69a' },
    };

    const groups = {
      timer:    active.filter(t => t.timer_class === 'timer'),
      alarm:    active.filter(t => t.timer_class === 'alarm'),
      reminder: active.filter(t => t.timer_class === 'reminder'),
      local:    active.filter(t => t.timer_class === 'local'),
    };

    const listHtml = (() => {
      if (this._loading) {
        return `<div class="state-msg"><ha-circular-progress active indeterminate></ha-circular-progress></div>`;
      }
      if (this._error) {
        return `<div class="state-msg error"><ha-icon icon="mdi:alert-circle-outline"></ha-icon>${this._error}</div>`;
      }
      if (active.length === 0) {
        return `<div class="state-msg muted">
          <ha-icon icon="mdi:check-circle-outline"></ha-icon>
          No active timers, alarms, or reminders
        </div>`;
      }
      if (display_mode === 'horseshoe') {
        const tiles = active.map(t => this._tileHtml(t, META[t.timer_class], multiDevice ? deviceLabel[t.entity_id] : null)).join('');
        return `<div class="tile-grid" style="grid-template-columns:repeat(${this._config.columns},1fr)">${tiles}</div>`;
      }
      return Object.entries(groups)
        .filter(([cls, items]) => items.length > 0 && (show_types.includes(cls) || cls === 'local'))
        .map(([cls, items]) => {
          const meta = META[cls];
          return `<div class="section">
            <div class="section-header" style="color:${meta.color}">
              <ha-icon icon="${meta.icon}" style="color:${meta.color}"></ha-icon>
              <span>${meta.label}</span>
            </div>
            ${items.map(t => this._rowHtml(t, meta, multiDevice ? deviceLabel[t.entity_id] : null)).join('')}
          </div>`;
        }).join('');
    })();

    // ── Partial render: add panel is open — only update the timer list ────────
    // Avoids destroying focused inputs (which closes the keyboard on Android/iOS).
    const existingBody = root.querySelector('.card-body');
    const addPanelEl   = root.querySelector('.add-panel');
    const addPanelCurrentlyVisible = addPanelEl && addPanelEl.style.display !== 'none';
    if (this._showAddPanel && addPanelCurrentlyVisible && existingBody) {
      existingBody.innerHTML = listHtml;
      if (max_height > 0) { existingBody.style.maxHeight = `${max_height}px`; existingBody.style.overflowY = 'auto'; }
      // Re-wire action buttons inside the replaced body (add-panel buttons keep their existing listeners)
      existingBody.querySelectorAll('.btn').forEach(btn => {
        btn.addEventListener('click', e => {
          const { action, id, minutes } = e.currentTarget.dataset;
          if      (action === 'cancel' || action === 'dismiss') this._cancelTimer(id);
          else if (action === 'snooze')        this._snoozeTimer(id, minutes ? parseInt(minutes) : null);
          else if (action === 'local-pause')   this._pauseLocalTimer(id);
          else if (action === 'local-resume')  this._resumeLocalTimer(id);
          else if (action === 'local-restart') this._restartLocalTimer(id);
          else if (action === 'local-cancel')  this._cancelLocalTimer(id);
        });
      });
      this._checkRingingPopup();
      return;
    }

    // ── Full render ───────────────────────────────────────────────────────────

    const showHeader = title !== '' || show_add_button;
    const headerHtml = showHeader ? `
      <div class="card-header">
        ${title !== '' ? `<ha-icon icon="mdi:bell-ring-outline"></ha-icon><span>${title}</span>` : '<span></span>'}
        ${show_add_button ? `
          <button class="btn-add-timer" data-action="toggle-add" title="${this._showAddPanel ? 'Cancel' : 'Add timer, alarm or reminder'}">
            <ha-icon icon="mdi:${this._showAddPanel ? 'close' : 'plus-circle-outline'}"></ha-icon>
          </button>` : ''}
      </div>` : '';

    const addPanelHtml = show_add_button ? `
      <div class="add-panel" data-type="${this._addType}" style="display:${this._showAddPanel ? '' : 'none'}">
        <div class="add-type-tabs">
          <button class="add-tab${this._addType === 'timer'    ? ' active' : ''}" data-type="timer">
            <ha-icon icon="mdi:timer-outline"></ha-icon> Timer
          </button>
          <button class="add-tab${this._addType === 'alarm'    ? ' active' : ''}" data-type="alarm">
            <ha-icon icon="mdi:alarm"></ha-icon> Alarm
          </button>
          <button class="add-tab${this._addType === 'reminder' ? ' active' : ''}" data-type="reminder">
            <ha-icon icon="mdi:reminder"></ha-icon> Reminder
          </button>
          <button class="add-tab${this._addType === 'local'    ? ' active' : ''}" data-type="local">
            <ha-icon icon="mdi:timer-sand"></ha-icon> Local
          </button>
        </div>
        <input class="add-name" type="text" placeholder="Label (optional)">
        <div class="add-dur-wrap">
          <div class="add-dur-row">
            <div class="add-dur-field"><input class="add-h" type="number" min="0" max="23" placeholder="0"><span class="add-dur-lbl">h</span></div>
            <div class="add-dur-field"><input class="add-m" type="number" min="0" max="59" placeholder="0"><span class="add-dur-lbl">m</span></div>
            <div class="add-dur-field"><input class="add-s" type="number" min="0" max="59" placeholder="0"><span class="add-dur-lbl">s</span></div>
          </div>
        </div>
        <div class="add-time-wrap">
          <input class="add-time" type="time">
        </div>
        <div class="add-submit-row">
          <button class="btn btn-set-timer" data-action="create-timer">Set</button>
        </div>
      </div>` : '';

    const bodyStyle = max_height > 0 ? `style="max-height:${max_height}px;overflow-y:auto"` : '';

    const wrapOpen  = isFloating ? '<div class="fc-wrap">' : '<ha-card>';
    const wrapClose = isFloating ? '</div>'               : '</ha-card>';

    root.innerHTML = `
      <style>${this._css()}</style>
      ${wrapOpen}
        ${headerHtml}
        ${addPanelHtml}
        <div class="card-body" ${bodyStyle}>${listHtml}</div>
      ${wrapClose}`;

    // ── Event listeners ───────────────────────────────────────────────────────

    root.querySelectorAll('.btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const { action, id, minutes } = e.currentTarget.dataset;
        if      (action === 'cancel' || action === 'dismiss') this._cancelTimer(id);
        else if (action === 'snooze')        this._snoozeTimer(id, minutes ? parseInt(minutes) : null);
        else if (action === 'create-timer')  this._createTimer();
        else if (action === 'local-pause')   this._pauseLocalTimer(id);
        else if (action === 'local-resume')  this._resumeLocalTimer(id);
        else if (action === 'local-restart') this._restartLocalTimer(id);
        else if (action === 'local-cancel')  this._cancelLocalTimer(id);
      });
    });

    root.querySelector('[data-action="toggle-add"]')?.addEventListener('click', () => {
      this._showAddPanel = !this._showAddPanel;
      this._render();
    });

    root.querySelectorAll('.add-tab').forEach(tab => {
      tab.addEventListener('click', e => {
        const type = e.currentTarget.dataset.type;
        this._addType = type;
        root.querySelectorAll('.add-tab').forEach(t => t.classList.toggle('active', t.dataset.type === type));
        root.querySelector('.add-panel').dataset.type = type;
      });
    });

    this._checkRingingPopup();
  }

  _checkRingingPopup() {
    if (!this._config.show_ringing_popup) return;
    const vaRinging    = this._timers.filter(t => this._isRinging(t) && this._config.show_types.includes(t.timer_class));
    const localRinging = this._localTimers.filter(t => t.status === 'expired');
    const ringing      = [...vaRinging, ...localRinging];
    if (ringing.length > 0) this._showRingingPopup(ringing);
    else this._hideRingingPopup();
  }

  // ── Bar-mode row ───────────────────────────────────────────────────────────

  _rowHtml(timer, meta, deviceName = null) {
    const isRinging = this._isRinging(timer);
    const id   = this._id(timer);
    const name = timer.name || timer.extra_info?.sentence || timer.duration || timer.timer_class;
    const pct  = isRinging ? 100 : this._getProgress(id) * 100;

    let actions;
    if (timer.timer_class === 'local') {
      if (timer.status === 'active') {
        actions = `<button class="btn btn-snooze" data-action="local-pause" data-id="${id}" title="Pause"><ha-icon icon="mdi:pause"></ha-icon></button>` +
                  `<button class="btn btn-cancel" data-action="local-cancel" data-id="${id}" title="Cancel"><ha-icon icon="mdi:close"></ha-icon></button>`;
      } else if (timer.status === 'paused') {
        actions = `<button class="btn btn-set-timer" data-action="local-resume" data-id="${id}" title="Resume"><ha-icon icon="mdi:play"></ha-icon></button>` +
                  `<button class="btn btn-cancel" data-action="local-cancel" data-id="${id}" title="Cancel"><ha-icon icon="mdi:close"></ha-icon></button>`;
      } else {
        actions = `<button class="btn btn-set-timer" data-action="local-restart" data-id="${id}">Restart</button>` +
                  `<button class="btn btn-dismiss" data-action="local-cancel" data-id="${id}">Dismiss</button>`;
      }
    } else if (isRinging) {
      actions = this._config.snooze_options.map(m =>
          `<button class="btn btn-snooze" data-action="snooze" data-id="${id}" data-minutes="${m}">+${m}m</button>`
        ).join('') + `<button class="btn btn-dismiss" data-action="dismiss" data-id="${id}">Stop</button>`;
    } else {
      actions = `<button class="btn btn-cancel" data-action="cancel" data-id="${id}" title="Cancel"><ha-icon icon="mdi:close"></ha-icon></button>`;
    }

    return `
      <div class="timer-row${isRinging ? ' ringing' : ''}">
        <div class="timer-icon" style="background:${meta.color}22">
          <ha-icon icon="${meta.icon}" style="color:${meta.color}"></ha-icon>
        </div>
        <div class="timer-info">
          ${deviceName ? `<div class="timer-device">${deviceName}</div>` : ''}
          <div class="timer-name" title="${name}">${name}</div>
          <div class="timer-countdown" style="color:${meta.color}" data-timer-id="${id}">
            ${this._getCountdown(timer)}
          </div>
          <div class="progress-track">
            <div class="progress-fill${isRinging ? ' progress-ringing' : ''}"
              data-progress-id="${id}"
              style="width:${pct}%;background:${meta.color}">
            </div>
          </div>
        </div>
        <div class="timer-actions">${actions}</div>
      </div>`;
  }

  // ── Horseshoe tile ─────────────────────────────────────────────────────────

  _tileHtml(timer, meta, deviceName = null) {
    const isRinging = this._isRinging(timer);
    const id   = this._id(timer);
    const name = timer.name || timer.extra_info?.sentence || timer.duration || timer.timer_class;
    const shortName = name.length > 14 ? name.slice(0, 13) + '…' : name;
    const { _HS_C: C, _HS_ARC: ARC } = ViewAssistTimersCard;
    const arcLen = (isRinging ? 1 : this._getProgress(id)) * ARC;

    let actions;
    if (timer.timer_class === 'local') {
      if (timer.status === 'active') {
        actions = `<button class="btn btn-snooze btn-sm" data-action="local-pause" data-id="${id}" title="Pause"><ha-icon icon="mdi:pause"></ha-icon></button>` +
                  `<button class="btn btn-cancel btn-sm" data-action="local-cancel" data-id="${id}" title="Cancel"><ha-icon icon="mdi:close"></ha-icon></button>`;
      } else if (timer.status === 'paused') {
        actions = `<button class="btn btn-set-timer btn-sm" data-action="local-resume" data-id="${id}" title="Resume"><ha-icon icon="mdi:play"></ha-icon></button>` +
                  `<button class="btn btn-cancel btn-sm" data-action="local-cancel" data-id="${id}" title="Cancel"><ha-icon icon="mdi:close"></ha-icon></button>`;
      } else {
        actions = `<button class="btn btn-set-timer btn-sm" data-action="local-restart" data-id="${id}">Restart</button>` +
                  `<button class="btn btn-dismiss btn-sm" data-action="local-cancel" data-id="${id}">Dismiss</button>`;
      }
    } else if (isRinging) {
      actions = this._config.snooze_options.map(m =>
          `<button class="btn btn-snooze btn-sm" data-action="snooze" data-id="${id}" data-minutes="${m}">+${m}m</button>`
        ).join('') + `<button class="btn btn-dismiss btn-sm" data-action="dismiss" data-id="${id}">Stop</button>`;
    } else {
      actions = `<button class="btn btn-cancel btn-sm" data-action="cancel" data-id="${id}" title="Cancel"><ha-icon icon="mdi:close"></ha-icon></button>`;
    }

    return `
      <div class="tile${isRinging ? ' ringing' : ''}">
        <div class="tile-type-icon" style="color:${meta.color}">
          <ha-icon icon="${meta.icon}"></ha-icon>
        </div>
        <svg class="horseshoe-svg" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="38" fill="none"
            stroke="${meta.color}33" stroke-width="9" stroke-linecap="round"
            stroke-dasharray="${ARC.toFixed(2)} ${(C - ARC).toFixed(2)}"
            transform="rotate(135 50 50)" />
          <circle cx="50" cy="50" r="38" fill="none"
            stroke="${meta.color}" stroke-width="9" stroke-linecap="round"
            stroke-dasharray="${arcLen.toFixed(2)} ${(C - arcLen).toFixed(2)}"
            transform="rotate(135 50 50)"
            data-horseshoe-id="${id}" />
          <text x="50" y="50" class="hs-countdown" data-timer-id="${id}">
            ${this._getCountdown(timer)}
          </text>
        </svg>
        <div class="tile-name" style="color:${meta.color}" title="${name}">${shortName}</div>
        ${deviceName ? `<div class="tile-device">${deviceName}</div>` : ''}
        <div class="tile-actions">${actions}</div>
      </div>`;
  }

  // ── Ringing popup ──────────────────────────────────────────────────────────

  _ensurePopupStyles() {
    if (document.getElementById('vatc-popup-styles')) return;
    const s = document.createElement('style');
    s.id = 'vatc-popup-styles';
    s.textContent = `
      .vatc-popup {
        position: fixed; bottom: 24px; right: 24px; z-index: 9999;
        background: var(--ha-card-background, var(--card-background-color, #fff));
        border: 1px solid var(--divider-color, rgba(0,0,0,.15));
        border-radius: 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,.25), 0 2px 8px rgba(0,0,0,.12);
        padding: 16px 20px; min-width: 280px; max-width: 380px;
        color: var(--primary-text-color, #212121);
        font-family: var(--mdc-typography-body1-font-family, Roboto, sans-serif);
        user-select: none;
      }
      .vatc-popup.vatc-movable { cursor: grab; }
      .vatc-popup.vatc-movable:active { cursor: grabbing; }
      .vatc-popup-header {
        display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
        font-size: 1em; font-weight: 700; color: #e53935;
      }
      .vatc-bell { display: inline-block; animation: vatc-ring .45s ease-in-out infinite alternate; }
      @keyframes vatc-ring { 0%{transform:rotate(-18deg)} 100%{transform:rotate(18deg)} }
      .vatc-alarm-row { padding: 10px 0; border-top: 1px solid var(--divider-color, rgba(0,0,0,.1)); }
      .vatc-alarm-name {
        font-size: .95em; font-weight: 600; margin-bottom: 8px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-transform: capitalize;
      }
      .vatc-alarm-btns { display: flex; gap: 6px; flex-wrap: wrap; }
      .vatc-btn {
        border: none; border-radius: 8px; padding: 7px 16px;
        font-size: .82em; font-weight: 600; cursor: pointer;
        font-family: inherit; transition: filter .15s;
      }
      .vatc-btn:hover  { filter: brightness(1.12); }
      .vatc-btn:active { filter: brightness(.90); }
      .vatc-btn-snooze { background: #fb8c00; color: #fff; }
      .vatc-btn-stop   { background: #e53935; color: #fff; }
    `;
    document.head.appendChild(s);
  }

  _showRingingPopup(ringingTimers) {
    const ids = ringingTimers.map(t => this._id(t)).sort().join(',');
    if (this._popupEl && this._popupRingingIds === ids) return;
    this._popupRingingIds = ids;
    this._ensurePopupStyles();
    if (!this._popupEl) {
      this._popupEl = document.createElement('div');
      this._popupEl.className = `vatc-popup${this._config.popup_movable ? ' vatc-movable' : ''}`;
      document.body.appendChild(this._popupEl);
      if (this._config.popup_movable) this._makePopupDraggable(this._popupEl);
    }
    const META_COLOR = { timer: '#039be5', alarm: '#e53935', reminder: '#fb8c00' };
    const rows = ringingTimers.map(t => {
      const name    = t.name || t.extra_info?.sentence || t.duration || t.timer_class;
      const color   = META_COLOR[t.timer_class] || '#e53935';
      const tid     = this._id(t);
      const isLocal = t.timer_class === 'local';
      const actionBtns = isLocal
        ? `<button class="vatc-btn vatc-btn-snooze" data-action="local-restart" data-id="${tid}">Restart</button>
           <button class="vatc-btn vatc-btn-stop" data-action="local-cancel" data-id="${tid}">Dismiss</button>`
        : this._config.snooze_options.map(m =>
            `<button class="vatc-btn vatc-btn-snooze" data-action="snooze" data-id="${tid}" data-minutes="${m}">Snooze ${m}m</button>`
          ).join('') +
          `<button class="vatc-btn vatc-btn-stop" data-action="stop" data-id="${tid}">Stop</button>`;
      return `<div class="vatc-alarm-row">
        <div class="vatc-alarm-name" style="color:${color}">${name}</div>
        <div class="vatc-alarm-btns">${actionBtns}</div>
      </div>`;
    }).join('');
    this._popupEl.innerHTML = `
      <div class="vatc-popup-header">
        <span class="vatc-bell">🔔</span>
        <span>${ringingTimers.length > 1 ? `${ringingTimers.length} Alarms` : 'Alarm'} going off!</span>
      </div>
      ${rows}`;
    this._popupEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const { action, id, minutes } = e.currentTarget.dataset;
        if      (action === 'snooze')        this._snoozeTimer(id, parseInt(minutes));
        else if (action === 'stop')          this._cancelTimer(id);
        else if (action === 'local-restart') this._restartLocalTimer(id);
        else if (action === 'local-cancel')  this._cancelLocalTimer(id);
      });
    });
  }

  _hideRingingPopup() {
    if (this._popupEl) {
      this._popupEl.remove();
      this._popupEl         = null;
      this._popupRingingIds = null;
    }
  }

  _makePopupDraggable(el) {
    let startX = 0, startY = 0, initLeft = 0, initTop = 0;
    const onMove = e => {
      e.preventDefault();
      const pt = e.touches ? e.touches[0] : e;
      el.style.left   = `${initLeft + pt.clientX - startX}px`;
      el.style.top    = `${initTop  + pt.clientY - startY}px`;
      el.style.right  = 'auto';
      el.style.bottom = 'auto';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend',  onUp);
    };
    const onDown = e => {
      // composedPath() sees through shadow DOM boundaries; plain .target is retargeted at shadow hosts
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (path.some(n => n.dataset?.action)) return;
      e.preventDefault();
      const pt = e.touches ? e.touches[0] : e;
      const rect = el.getBoundingClientRect();
      startX = pt.clientX; startY = pt.clientY;
      initLeft = rect.left; initTop = rect.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend',  onUp);
    };
    el.addEventListener('mousedown',  onDown);
    el.addEventListener('touchstart', onDown, { passive: false });
  }

  // ── CSS ────────────────────────────────────────────────────────────────────

  _css() {
    return `
      :host { display: block; }
      ha-card { overflow: hidden; }
      .fc-wrap {
        overflow: hidden;
        border-radius: var(--ha-card-border-radius, 12px);
        background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
        box-shadow: 0 8px 32px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.15);
        color: var(--primary-text-color, #e1e1e1);
      }

      .card-header {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 14px 10px;
        font-size: 1.05em; font-weight: 500; color: var(--primary-text-color);
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.12));
      }
      .card-header ha-icon { color: var(--primary-color); --mdc-icon-size: 20px; }
      .card-header span:first-of-type { flex: 1; }

      .btn-add-timer {
        margin-left: auto; flex-shrink: 0;
        background: none; border: none; cursor: pointer; padding: 3px;
        border-radius: 50%; color: var(--primary-color);
        display: flex; align-items: center; justify-content: center;
        transition: background .15s; --mdc-icon-size: 22px;
      }
      .btn-add-timer:hover { background: var(--secondary-background-color); }

      /* ── Add Timer panel ────────────────────────────────────────────────── */
      .add-panel {
        padding: 12px 14px 14px;
        background: var(--secondary-background-color, rgba(0,0,0,.03));
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.1));
      }
      .add-type-tabs { display: flex; gap: 5px; margin-bottom: 10px; }
      .add-tab {
        flex: 1; display: flex; align-items: center; justify-content: center; gap: 4px;
        padding: 6px 4px; border: 1px solid var(--divider-color, rgba(0,0,0,.15));
        border-radius: 7px; background: none; cursor: pointer;
        font-size: .74em; font-weight: 600; color: var(--secondary-text-color);
        font-family: inherit; transition: all .15s; --mdc-icon-size: 14px;
      }
      .add-tab.active { background: var(--primary-color); color: #fff; border-color: transparent; }
      .add-tab.active ha-icon { color: #fff; }

      .add-name, .add-time {
        width: 100%; box-sizing: border-box; margin-bottom: 8px;
        padding: 7px 10px;
        background: var(--card-background-color, #fff);
        border: 1px solid var(--divider-color, rgba(0,0,0,.2));
        border-radius: 6px; color: var(--primary-text-color);
        font-size: .88em; font-family: inherit; outline: none;
      }
      .add-name:focus, .add-time:focus { border-color: var(--primary-color); }

      .add-dur-row { display: flex; gap: 6px; margin-bottom: 8px; }
      .add-dur-field { display: flex; align-items: center; gap: 4px; flex: 1; }
      .add-h, .add-m, .add-s {
        flex: 1; width: 0; padding: 7px 4px; text-align: center;
        background: var(--card-background-color, #fff);
        border: 1px solid var(--divider-color, rgba(0,0,0,.2));
        border-radius: 6px; color: var(--primary-text-color);
        font-size: .88em; font-family: inherit; outline: none;
      }
      .add-h:focus, .add-m:focus, .add-s:focus { border-color: var(--primary-color); }
      .add-dur-lbl { font-size: .78em; color: var(--secondary-text-color); flex-shrink: 0; }

      /* Show/hide duration row vs time picker based on selected type */
      .add-panel[data-type="timer"]    .add-time-wrap { display: none; }
      .add-panel[data-type="local"]    .add-time-wrap { display: none; }
      .add-panel[data-type="alarm"]    .add-dur-wrap  { display: none; }
      .add-panel[data-type="reminder"] .add-dur-wrap  { display: none; }

      .add-submit-row { display: flex; justify-content: flex-end; margin-top: 2px; }
      .btn-set-timer { background: var(--primary-color, #03a9f4); color: #fff; }

      /* ── Card body ──────────────────────────────────────────────────────── */
      .card-body { padding: 6px 0 8px; }
      .card-body::-webkit-scrollbar { width: 4px; }
      .card-body::-webkit-scrollbar-thumb {
        background: var(--divider-color, rgba(0,0,0,.2)); border-radius: 4px;
      }

      .section { padding: 2px 0; }
      .section-header {
        display: flex; align-items: center; gap: 5px; padding: 6px 16px 3px;
        font-size: .7em; font-weight: 700; text-transform: uppercase; letter-spacing: .09em;
      }
      .section-header ha-icon { --mdc-icon-size: 13px; }

      /* ── Bar mode ───────────────────────────────────────────────────────── */
      .timer-row {
        display: flex; align-items: center; gap: 12px;
        padding: 7px 12px 6px; margin: 1px 6px;
        border-radius: 8px; transition: background .15s;
      }
      .timer-row:hover { background: var(--secondary-background-color); }

      .timer-icon {
        flex-shrink: 0; width: 38px; height: 38px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
      }
      .timer-icon ha-icon { --mdc-icon-size: 20px; }

      .timer-info { flex: 1; min-width: 0; }
      .timer-device {
        font-size: .68em; color: var(--secondary-text-color); opacity: .7;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        line-height: 1.2; margin-bottom: 1px;
      }
      .timer-name {
        font-size: .85em; color: var(--secondary-text-color);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        line-height: 1.3; text-transform: capitalize;
      }
      .timer-countdown {
        font-size: 1.3em; font-weight: 700;
        font-variant-numeric: tabular-nums; line-height: 1.25;
      }
      .progress-track {
        height: 3px; margin-top: 5px;
        background: var(--divider-color, rgba(0,0,0,.1));
        border-radius: 3px; overflow: hidden;
      }
      .progress-fill { height: 100%; border-radius: 3px; transition: width .9s linear; }
      .progress-ringing { animation: progress-flash .6s ease-in-out infinite alternate; }
      @keyframes progress-flash { 0%{opacity:1} 100%{opacity:.2} }

      .timer-actions { flex-shrink: 0; display: flex; gap: 5px; align-items: center; }

      /* ── Horseshoe tile mode ────────────────────────────────────────────── */
      .tile-grid { display: grid; gap: 8px; padding: 8px 10px; }
      .tile {
        display: flex; flex-direction: column; align-items: center; gap: 2px;
        padding: 8px 4px 6px; border-radius: 10px; transition: background .15s; position: relative;
      }
      .tile:hover { background: var(--secondary-background-color); }
      .tile-type-icon { position: absolute; top: 5px; left: 5px; --mdc-icon-size: 14px; opacity: .7; }
      .horseshoe-svg { width: 90px; height: 90px; overflow: visible; }
      .hs-countdown {
        fill: var(--primary-text-color);
        font-size: 16px; font-weight: 700;
        font-family: var(--mdc-typography-body1-font-family, Roboto, sans-serif);
        font-variant-numeric: tabular-nums; dominant-baseline: middle; text-anchor: middle;
      }
      .tile-name {
        font-size: .75em; font-weight: 600; text-align: center; max-width: 90px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        text-transform: capitalize; margin-top: 1px;
      }
      .tile-device {
        font-size: .62em; color: var(--secondary-text-color); opacity: .7;
        text-align: center; max-width: 90px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .tile-actions { display: flex; gap: 4px; flex-wrap: wrap; justify-content: center; margin-top: 2px; }

      /* ── Buttons ────────────────────────────────────────────────────────── */
      .btn {
        border: none; border-radius: 6px; padding: 5px 12px;
        font-size: .78em; font-weight: 600; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: filter .15s; font-family: inherit;
      }
      .btn:hover  { filter: brightness(1.12); }
      .btn:active { filter: brightness(.92); }
      .btn-sm { padding: 3px 8px; font-size: .72em; }
      .btn-cancel {
        background: var(--secondary-background-color, rgba(0,0,0,.06));
        color: var(--secondary-text-color); padding: 5px 7px;
      }
      .btn-cancel ha-icon { --mdc-icon-size: 17px; }
      .btn-dismiss   { background: #e53935; color: #fff; }
      .btn-snooze    { background: #fb8c00; color: #fff; }
      .btn-set-timer { background: #26a69a; color: #fff; }
      .btn-snooze ha-icon, .btn-cancel ha-icon, .btn-set-timer ha-icon { --mdc-icon-size: 17px; }

      /* ── State messages ─────────────────────────────────────────────────── */
      .state-msg {
        display: flex; flex-direction: column; align-items: center;
        gap: 8px; padding: 28px 16px; text-align: center;
        font-size: .9em; color: var(--secondary-text-color);
      }
      .state-msg ha-icon { --mdc-icon-size: 32px; opacity: .5; }
      .state-msg.error   { color: var(--error-color, #e53935); }
      .state-msg.error ha-icon { opacity: .8; }

      /* ── Ringing pulse ──────────────────────────────────────────────────── */
      .ringing { animation: pulse 1.2s ease-in-out infinite; }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.45} }
    `;
  }
}

// ── Visual config editor ───────────────────────────────────────────────────

class ViewAssistTimersCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
  }

  setConfig(config) {
    this._config = {
      title: 'Timers, Alarms & Reminders',
      display_mode: 'bar',
      columns: 2,
      max_height: 0,
      hide_when_empty: false,
      float_when_active: false,
      float_position: 'bottom-right',
      show_ringing_popup: true,
      popup_movable: true,
      snooze_options: [5, 10],
      refresh_interval: 5,
      show_types: ['timer', 'alarm', 'reminder'],
      show_add_button: false,
      create_service: 'set_timer',
      va_entity_ids: [],
      ...config,
      // migrate legacy single-value field
      va_entity_ids: config.va_entity_ids
        || (config.va_entity_id ? [config.va_entity_id] : []),
    };
    this._render();
  }

  set hass(h) {
    const first = !this._hass;
    this._hass = h;
    if (first) this._render(); // re-render once hass arrives so entity list populates
  }

  _getVAEntities() {
    if (!this._hass) return [];
    return Object.entries(this._hass.states)
      .filter(([id, state]) => {
        if (!id.startsWith('sensor.')) return false;
        const t = state.attributes?.type;
        return t === 'view_audio' || t === 'vaca' || t === 'audio_only'
          || state.attributes?.mediaplayer_device !== undefined;
      })
      .map(([id, state]) => ({
        id,
        name: state.attributes.friendly_name || id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  _fire() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: { ...this._config } },
      bubbles: true,
      composed: true,
    }));
  }

  _vaEntityRowsHtml() {
    const entities = this._getVAEntities();
    if (entities.length === 0) {
      return `<p class="field-hint" style="margin:0">No View Assist entities detected — make sure the integration is installed.</p>`;
    }
    const selected = this._config.va_entity_ids || [];
    // Show one row per selected entity plus one empty "add" row (unless all are already selected)
    const rows = selected.length < entities.length ? [...selected, ''] : [...selected];
    return rows.map((val, i) => {
      const isAdd = val === '';
      // Each dropdown lists entities not already chosen elsewhere, plus the current row's value
      const opts = entities.filter(e => !selected.includes(e.id) || e.id === val);
      return `
        <div class="va-row">
          <span class="va-row-label">${i === 0 ? 'Primary' : `+${i}`}</span>
          <select class="va-sel" data-index="${i}">
            <option value="">— ${i === 0 ? 'Select primary device' : 'Add a device'} —</option>
            ${opts.map(e => `<option value="${e.id}" ${e.id === val ? 'selected' : ''}>${e.name}</option>`).join('')}
          </select>
          ${!isAdd ? `<button class="va-remove-btn" data-index="${i}" title="Remove">✕</button>` : ''}
        </div>`;
    }).join('');
  }

  _render() {
    const c  = this._config;
    const st = c.show_types || ['timer', 'alarm', 'reminder'];
    const isHorseshoe  = c.display_mode === 'horseshoe';
    const showPopup    = c.show_ringing_popup !== false;
    const floatActive  = c.float_when_active === true;
    const showAddSvc   = c.show_add_button === true;

    this.shadowRoot.innerHTML = `
      <style>${this._css()}</style>
      <div class="editor">

        <div class="section-title">General</div>
        <div class="field">
          <label>Card title (blank to hide)</label>
          <input type="text" name="title" value="${this._esc(c.title ?? 'Timers, Alarms &amp; Reminders')}">
        </div>
        <div class="field">
          <label>Refresh interval (seconds)</label>
          <input type="number" name="refresh_interval" min="1" max="120" value="${c.refresh_interval ?? 5}">
        </div>

        <div class="section-title">Display</div>
        <div class="field">
          <label>Display mode</label>
          <select name="display_mode">
            <option value="bar"       ${!isHorseshoe ? 'selected' : ''}>Progress Bar</option>
            <option value="horseshoe" ${ isHorseshoe ? 'selected' : ''}>Horseshoe</option>
          </select>
        </div>
        <div class="field row-columns" style="display:${isHorseshoe ? '' : 'none'}">
          <label>Tiles per row (horseshoe mode)</label>
          <input type="number" name="columns" min="1" max="8" value="${c.columns ?? 2}">
        </div>
        <div class="field">
          <label>Max card height px (0 = unlimited)</label>
          <input type="number" name="max_height" min="0" max="2000" step="50" value="${c.max_height ?? 0}">
        </div>

        <div class="section-title">Show Types</div>
        <div class="checkboxes">
          <label class="checkbox-item">
            <input type="checkbox" name="show_timer"    ${st.includes('timer')    ? 'checked' : ''}> Timers
          </label>
          <label class="checkbox-item">
            <input type="checkbox" name="show_alarm"    ${st.includes('alarm')    ? 'checked' : ''}> Alarms
          </label>
          <label class="checkbox-item">
            <input type="checkbox" name="show_reminder" ${st.includes('reminder') ? 'checked' : ''}> Reminders
          </label>
        </div>

        <div class="section-title">Behaviour</div>
        <div class="toggle-row">
          <span class="toggle-label">Hide card when no alarms</span>
          <label class="toggle-switch">
            <input type="checkbox" name="hide_when_empty" ${c.hide_when_empty ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Float as overlay when alarms are active</span>
          <label class="toggle-switch">
            <input type="checkbox" name="float_when_active" ${floatActive ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="field row-float-pos" style="display:${floatActive ? '' : 'none'}">
          <label>Float position</label>
          <select name="float_position">
            <option value="bottom-right" ${(c.float_position||'bottom-right')==='bottom-right' ? 'selected':''}>Bottom right</option>
            <option value="bottom-left"  ${(c.float_position||'') === 'bottom-left'  ? 'selected':''}>Bottom left</option>
            <option value="top-right"    ${(c.float_position||'') === 'top-right'    ? 'selected':''}>Top right</option>
            <option value="top-left"     ${(c.float_position||'') === 'top-left'     ? 'selected':''}>Top left</option>
          </select>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Show popup when alarm rings</span>
          <label class="toggle-switch">
            <input type="checkbox" name="show_ringing_popup" ${showPopup ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="toggle-row row-popup-movable" style="display:${showPopup ? '' : 'none'}">
          <span class="toggle-label">Allow ringing popup &amp; float card to be dragged</span>
          <label class="toggle-switch">
            <input type="checkbox" name="popup_movable" ${c.popup_movable !== false ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="section-title">Snooze</div>
        <div class="field">
          <label>Snooze options — minutes, comma-separated (e.g. 5, 10, 15)</label>
          <input type="text" name="snooze_options" value="${(c.snooze_options || [5, 10]).join(', ')}">
        </div>

        <div class="section-title">View Assist Devices</div>
        <p class="field-hint">The <strong>first device</strong> is primary — new timers are always created for it. Add more to display and control their timers too. Leave empty to show timers from all devices.</p>
        <div class="va-rows">${this._vaEntityRowsHtml()}</div>

        <div class="section-title">Add Timer Button</div>
        <div class="toggle-row">
          <span class="toggle-label">Show + button to create timers/alarms</span>
          <label class="toggle-switch">
            <input type="checkbox" name="show_add_button" ${c.show_add_button ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="field row-create-svc" style="display:${showAddSvc ? '' : 'none'}">
          <label>View Assist create service name (default: set_timer)</label>
          <input type="text" name="create_service" value="${this._esc(c.create_service || 'set_timer')}">
        </div>

      </div>`;

    this._attachListeners();
  }

  _attachListeners() {
    const root = this.shadowRoot;

    root.querySelector('[name=title]').addEventListener('input', e => {
      this._config = { ...this._config, title: e.target.value };
      this._fire();
    });
    root.querySelector('[name=refresh_interval]').addEventListener('change', e => {
      this._config = { ...this._config, refresh_interval: Math.max(1, parseFloat(e.target.value) || 5) };
      this._fire();
    });
    root.querySelector('[name=max_height]').addEventListener('change', e => {
      this._config = { ...this._config, max_height: Math.max(0, parseInt(e.target.value) || 0) };
      this._fire();
    });
    root.querySelector('[name=columns]').addEventListener('change', e => {
      this._config = { ...this._config, columns: Math.max(1, parseInt(e.target.value) || 2) };
      this._fire();
    });
    root.querySelector('[name=display_mode]').addEventListener('change', e => {
      this._config = { ...this._config, display_mode: e.target.value };
      root.querySelector('.row-columns').style.display = e.target.value === 'horseshoe' ? '' : 'none';
      this._fire();
    });
    root.querySelector('[name=float_position]').addEventListener('change', e => {
      this._config = { ...this._config, float_position: e.target.value };
      this._fire();
    });

    ['timer', 'alarm', 'reminder'].forEach(type => {
      root.querySelector(`[name=show_${type}]`).addEventListener('change', () => {
        const types = ['timer', 'alarm', 'reminder'].filter(
          t => root.querySelector(`[name=show_${t}]`).checked
        );
        this._config = { ...this._config, show_types: types.length ? types : ['timer', 'alarm', 'reminder'] };
        this._fire();
      });
    });

    root.querySelector('[name=hide_when_empty]').addEventListener('change', e => {
      this._config = { ...this._config, hide_when_empty: e.target.checked };
      this._fire();
    });
    root.querySelector('[name=float_when_active]').addEventListener('change', e => {
      this._config = { ...this._config, float_when_active: e.target.checked };
      root.querySelector('.row-float-pos').style.display = e.target.checked ? '' : 'none';
      this._fire();
    });
    root.querySelector('[name=show_ringing_popup]').addEventListener('change', e => {
      this._config = { ...this._config, show_ringing_popup: e.target.checked };
      root.querySelector('.row-popup-movable').style.display = e.target.checked ? '' : 'none';
      this._fire();
    });
    root.querySelector('[name=popup_movable]').addEventListener('change', e => {
      this._config = { ...this._config, popup_movable: e.target.checked };
      this._fire();
    });
    root.querySelector('[name=snooze_options]').addEventListener('change', e => {
      const opts = e.target.value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
      this._config = { ...this._config, snooze_options: opts.length ? opts : [5, 10] };
      this._fire();
    });
    root.querySelector('[name=show_add_button]').addEventListener('change', e => {
      this._config = { ...this._config, show_add_button: e.target.checked };
      root.querySelector('.row-create-svc').style.display = e.target.checked ? '' : 'none';
      this._fire();
    });
    root.querySelector('[name=create_service]').addEventListener('change', e => {
      this._config = { ...this._config, create_service: e.target.value.trim() || 'set_timer' };
      this._fire();
    });
    root.querySelectorAll('.va-sel').forEach(sel => {
      sel.addEventListener('change', e => {
        const idx = parseInt(e.target.dataset.index);
        const val = e.target.value;
        const ids = [...(this._config.va_entity_ids || [])];
        if (val) { ids[idx] = val; } else { ids.splice(idx, 1); }
        this._config = { ...this._config, va_entity_ids: ids.filter(Boolean) };
        this._fire();
        this._render();
      });
    });
    root.querySelectorAll('.va-remove-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const idx = parseInt(e.currentTarget.dataset.index);
        const ids = [...(this._config.va_entity_ids || [])];
        ids.splice(idx, 1);
        this._config = { ...this._config, va_entity_ids: ids };
        this._fire();
        this._render();
      });
    });
  }

  _esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _css() {
    return `
      :host { display: block; }
      .editor { padding: 2px 0 8px; }

      .section-title {
        font-size: .7em; font-weight: 700; text-transform: uppercase;
        letter-spacing: .08em; color: var(--secondary-text-color);
        margin: 18px 0 10px; padding-bottom: 5px;
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.1));
      }
      .section-title:first-child { margin-top: 4px; }

      .field { margin-bottom: 12px; }
      .field label {
        display: block; font-size: .82em;
        color: var(--secondary-text-color); margin-bottom: 5px;
      }
      .field input[type=text],
      .field input[type=number],
      .field select {
        width: 100%; box-sizing: border-box; padding: 8px 10px;
        background: var(--input-fill-color, var(--secondary-background-color, rgba(0,0,0,.05)));
        border: 1px solid var(--input-ink-color, var(--divider-color, rgba(0,0,0,.2)));
        border-radius: 6px; color: var(--primary-text-color);
        font-size: .9em; font-family: inherit; outline: none; transition: border-color .15s;
      }
      .field input:focus, .field select:focus { border-color: var(--primary-color, #03a9f4); }
      .field select { cursor: pointer; }

      .field-hint {
        font-size: .82em; color: var(--secondary-text-color);
        margin: 0 0 10px; line-height: 1.4;
      }
      .checkboxes { display: flex; gap: 16px; flex-wrap: wrap; padding: 4px 0 14px; }

      .va-rows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
      .va-row { display: flex; align-items: center; gap: 7px; }
      .va-row-label {
        font-size: .72em; font-weight: 700; color: var(--secondary-text-color);
        min-width: 46px; text-align: right; flex-shrink: 0;
      }
      .va-sel {
        flex: 1; padding: 7px 8px; cursor: pointer;
        background: var(--input-fill-color, var(--secondary-background-color, rgba(0,0,0,.05)));
        border: 1px solid var(--input-ink-color, var(--divider-color, rgba(0,0,0,.2)));
        border-radius: 6px; color: var(--primary-text-color);
        font-size: .88em; font-family: inherit; outline: none; transition: border-color .15s;
      }
      .va-sel:focus { border-color: var(--primary-color, #03a9f4); }
      .va-remove-btn {
        flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%;
        border: none; background: var(--secondary-background-color, rgba(0,0,0,.06));
        color: var(--secondary-text-color); cursor: pointer;
        font-size: .85em; line-height: 1; display: flex; align-items: center; justify-content: center;
        transition: background .15s;
      }
      .va-remove-btn:hover { background: var(--error-color, #e53935); color: #fff; }
      .checkbox-item {
        display: flex; align-items: center; gap: 6px;
        font-size: .88em; color: var(--primary-text-color); cursor: pointer;
      }
      .checkbox-item input[type=checkbox] {
        accent-color: var(--primary-color); width: 16px; height: 16px; cursor: pointer;
      }

      .toggle-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 9px 0; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.06));
      }
      .toggle-row:last-of-type { border-bottom: none; }
      .toggle-label { font-size: .88em; color: var(--primary-text-color); }

      .toggle-switch {
        position: relative; display: inline-block;
        width: 38px; height: 22px; flex-shrink: 0; margin-left: 12px;
      }
      .toggle-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
      .toggle-slider {
        position: absolute; inset: 0;
        background: var(--disabled-text-color, #bdbdbd);
        border-radius: 11px; cursor: pointer; transition: background .2s;
      }
      .toggle-switch input:checked + .toggle-slider { background: var(--primary-color, #03a9f4); }
      .toggle-slider::before {
        content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px;
        background: #fff; border-radius: 50%; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .2s;
      }
      .toggle-switch input:checked + .toggle-slider::before { transform: translateX(16px); }
    `;
  }
}

// ── Registration ───────────────────────────────────────────────────────────

if (!customElements.get('view-assist-timers-card')) {
  customElements.define('view-assist-timers-card', ViewAssistTimersCard);
}
if (!customElements.get('view-assist-timers-card-editor')) {
  customElements.define('view-assist-timers-card-editor', ViewAssistTimersCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.find(c => c.type === 'view-assist-timers-card')) {
  window.customCards.push({
    type: 'view-assist-timers-card',
    name: 'View Assist Timers Card',
    description: 'Shows active timers, alarms, and reminders from View Assist',
    preview: false,
  });
}
