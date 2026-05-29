/**
 * View Assist Timers Card
 * Shows all active timers, alarms, and reminders from the View Assist integration.
 *
 * Configuration (Lovelace YAML):
 *   type: custom:view-assist-timers-card
 *   title: "Timers, Alarms & Reminders"   # set to '' to hide header
 *   show_types:                            # default: all three
 *     - timer
 *     - alarm
 *     - reminder
 *   display_mode: bar                      # 'bar' (default) or 'horseshoe'
 *   columns: 2                             # tiles per row in horseshoe mode (default 2)
 *   max_height: 300                        # px — enables scrolling; 0 = no limit (default)
 *   hide_when_empty: false                 # hide card entirely when no active alarms (default false)
 *   show_ringing_popup: true               # floating popup when an alarm rings (default true)
 *   popup_movable: true                    # allow popup to be dragged (default true)
 *   snooze_options: [5, 10]               # snooze minutes offered in ringing popup (default [5,10])
 *   refresh_interval: 5                    # seconds between API polls (default 5)
 *   snooze_time: "10 minutes"             # fallback snooze used by main-card snooze button
 *
 * Installation: copy to config/www/ and add to Lovelace resources:
 *   url: /local/view-assist-timers-card.js
 *   type: module
 *
 * TODO (future): add a button to manually create a timer, alarm, or reminder
 *   via the view_assist/create_timer (or equivalent) service call.
 */

class ViewAssistTimersCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._timers = [];
    this._loading = true;
    this._error = null;
    this._refreshInterval = null;
    this._tickInterval = null;
    this._finishTimes = {};
    this._totalSeconds = {};      // id → total duration in seconds (for progress bars)
    this._popupEl = null;         // ringing popup DOM element (appended to document.body)
    this._popupRingingIds = null; // comma-joined sorted IDs currently shown in popup
  }

  static getConfigElement() {
    return document.createElement('view-assist-timers-card-editor');
  }

  static getStubConfig() {
    return { title: 'Timers, Alarms & Reminders', display_mode: 'bar' };
  }

  setConfig(config) {
    this._config = {
      title:             'title' in config ? config.title : 'Timers, Alarms & Reminders',
      show_types:        config.show_types || ['timer', 'alarm', 'reminder'],
      refresh_interval:  (config.refresh_interval ?? 5) * 1000,
      display_mode:      config.display_mode || 'bar',
      columns:           Math.max(1, config.columns || 2),
      max_height:        config.max_height || 0,
      hide_when_empty:   config.hide_when_empty ?? false,
      show_ringing_popup: config.show_ringing_popup ?? true,
      popup_movable:     config.popup_movable ?? true,
      snooze_options:    config.snooze_options || [5, 10],
      snooze_time:       config.snooze_time || '10 minutes',
    };
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
  }

  // Horseshoe geometry for r=38: circumference ≈ 238.76, 270° arc ≈ 179.07
  static get _HS_C()   { return 238.76; }
  static get _HS_ARC() { return 179.07; }

  // ── Data fetching ──────────────────────────────────────────────────────────

  async _fetchTimers() {
    if (!this._hass) return;
    try {
      const wsResult = await this._hass.callWS({
        type: 'call_service',
        domain: 'view_assist',
        service: 'get_timers',
        service_data: {},
        return_response: true,
      });
      const fetchedAt = Date.now();
      const raw = wsResult?.response?.result ?? wsResult?.result ?? wsResult ?? [];
      this._timers  = Array.isArray(raw) ? raw : [];
      this._loading = false;
      this._error   = null;
      this._updateFinishTimes(fetchedAt);
      this._updateTotalSeconds();
    } catch (err) {
      this._loading = false;
      this._error   = 'View Assist unavailable';
      console.error('[view-assist-timers-card]', err);
    }
    this._render();
  }

  _updateFinishTimes(fetchedAt) {
    const activeIds = new Set(this._timers.map(t => t.id));
    Object.keys(this._finishTimes).forEach(id => {
      if (!activeIds.has(id)) delete this._finishTimes[id];
    });
    this._timers.forEach(t => {
      const ft = this._parseFinishTime(t, fetchedAt);
      if (ft) this._finishTimes[t.id] = ft;
    });
  }

  _updateTotalSeconds() {
    const activeIds = new Set(this._timers.map(t => t.id));
    Object.keys(this._totalSeconds).forEach(id => {
      if (!activeIds.has(id)) delete this._totalSeconds[id];
    });
    this._timers.forEach(t => {
      if (this._totalSeconds[t.id]) return;
      // Prefer an explicit numeric duration field
      for (const key of ['duration', 'total_duration', 'original_duration']) {
        const n = Number(t[key]);
        if (!isNaN(n) && n > 0) { this._totalSeconds[t.id] = n; return; }
      }
      // Fall back to first-observed seconds_remaining as proxy for total
      for (const key of ['seconds_remaining', 'remaining_seconds', 'remaining']) {
        if (t[key] != null) { this._totalSeconds[t.id] = Number(t[key]); return; }
      }
      if (t.expiry?.seconds_remaining != null) {
        this._totalSeconds[t.id] = Number(t.expiry.seconds_remaining);
      }
    });
  }

  _parseFinishTime(timer, fetchedAt) {
    for (const key of ['finish_time', 'end_time', 'expiry_time', 'due_time']) {
      const val = timer[key];
      if (val == null) continue;
      const ts = typeof val === 'number' ? (val > 1e10 ? val : val * 1000) : new Date(val).getTime();
      if (!isNaN(ts)) return ts;
    }
    if (timer.expiry?.timestamp) {
      const ts = new Date(timer.expiry.timestamp).getTime();
      if (!isNaN(ts)) return ts;
    }
    for (const key of ['seconds_remaining', 'remaining_seconds', 'remaining']) {
      if (timer[key] != null) return fetchedAt + Number(timer[key]) * 1000;
    }
    if (timer.expiry?.seconds_remaining != null) {
      return fetchedAt + Number(timer.expiry.seconds_remaining) * 1000;
    }
    return null;
  }

  // ── Countdown & progress ───────────────────────────────────────────────────

  _getCountdown(timer) {
    const ft = this._finishTimes[timer.id];
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
    if (!this.shadowRoot) return;

    // Countdown text (works for both bar rows and horseshoe SVG text)
    this.shadowRoot.querySelectorAll('[data-timer-id]').forEach(el => {
      const t = this._timers.find(t => t.id === el.dataset.timerId);
      if (t) el.textContent = this._getCountdown(t);
    });

    // Linear progress bar fills
    this.shadowRoot.querySelectorAll('[data-progress-id]').forEach(el => {
      const t = this._timers.find(t => t.id === el.dataset.progressId);
      if (t && t.status !== 'ringing') {
        el.style.width = `${this._getProgress(t.id) * 100}%`;
      }
    });

    // Horseshoe SVG arc lengths
    const { _HS_C: C, _HS_ARC: ARC } = ViewAssistTimersCard;
    this.shadowRoot.querySelectorAll('[data-horseshoe-id]').forEach(el => {
      const t = this._timers.find(t => t.id === el.dataset.horseshoeId);
      if (!t || t.status === 'ringing') return;
      const arcLen = this._getProgress(t.id) * ARC;
      el.setAttribute('stroke-dasharray', `${arcLen.toFixed(2)} ${(C - arcLen).toFixed(2)}`);
    });

    // Ringing popup
    if (this._config.show_ringing_popup) {
      const ringing = this._timers.filter(
        t => t.status === 'ringing' && this._config.show_types.includes(t.timer_class)
      );
      if (ringing.length > 0) this._showRingingPopup(ringing);
      else this._hideRingingPopup();
    }
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

  // ── Main card rendering ────────────────────────────────────────────────────

  _render() {
    if (!this.shadowRoot) return;

    const { show_types, title, display_mode, max_height, hide_when_empty } = this._config;

    const active = this._timers.filter(
      t => show_types.includes(t.timer_class) && t.status !== 'expired'
    );

    // Collapse entire card when empty (option 6)
    this.style.display = (hide_when_empty && active.length === 0) ? 'none' : '';

    const META = {
      timer:    { icon: 'mdi:timer-outline', label: 'Timers',    color: '#039be5' },
      alarm:    { icon: 'mdi:alarm',         label: 'Alarms',    color: '#e53935' },
      reminder: { icon: 'mdi:reminder',      label: 'Reminders', color: '#fb8c00' },
    };

    const groups = {
      timer:    active.filter(t => t.timer_class === 'timer'),
      alarm:    active.filter(t => t.timer_class === 'alarm'),
      reminder: active.filter(t => t.timer_class === 'reminder'),
    };

    const bodyStyle = max_height > 0
      ? `style="max-height:${max_height}px;overflow-y:auto"`
      : '';

    const bodyHtml = (() => {
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
        const tiles = active.map(t => this._tileHtml(t, META[t.timer_class])).join('');
        return `<div class="tile-grid" style="grid-template-columns:repeat(${this._config.columns},1fr)">${tiles}</div>`;
      }

      // Bar mode: grouped sections with linear progress bars
      return Object.entries(groups)
        .filter(([cls, items]) => items.length > 0 && show_types.includes(cls))
        .map(([cls, items]) => {
          const meta = META[cls];
          return `<div class="section">
            <div class="section-header" style="color:${meta.color}">
              <ha-icon icon="${meta.icon}" style="color:${meta.color}"></ha-icon>
              <span>${meta.label}</span>
            </div>
            ${items.map(t => this._rowHtml(t, meta)).join('')}
          </div>`;
        }).join('');
    })();

    this.shadowRoot.innerHTML = `
      <style>${this._css()}</style>
      <ha-card>
        ${title !== ''
          ? `<div class="card-header">
               <ha-icon icon="mdi:bell-ring-outline"></ha-icon>
               <span>${title}</span>
             </div>`
          : ''}
        <div class="card-body" ${bodyStyle}>${bodyHtml}</div>
      </ha-card>`;

    this.shadowRoot.querySelectorAll('.btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const { action, id, minutes } = e.currentTarget.dataset;
        if (action === 'cancel' || action === 'dismiss') this._cancelTimer(id);
        else if (action === 'snooze') this._snoozeTimer(id, minutes ? parseInt(minutes) : null);
      });
    });
  }

  // ── Bar-mode row (with linear progress bar) ────────────────────────────────

  _rowHtml(timer, meta) {
    const isRinging = timer.status === 'ringing';
    const name = timer.name || timer.extra_info?.sentence || timer.duration || timer.timer_class;
    const pct  = isRinging ? 100 : this._getProgress(timer.id) * 100;

    const actions = isRinging
      ? this._config.snooze_options.map(m =>
          `<button class="btn btn-snooze" data-action="snooze" data-id="${timer.id}" data-minutes="${m}">+${m}m</button>`
        ).join('') +
        `<button class="btn btn-dismiss" data-action="dismiss" data-id="${timer.id}">Stop</button>`
      : `<button class="btn btn-cancel" data-action="cancel" data-id="${timer.id}" title="Cancel">
           <ha-icon icon="mdi:close"></ha-icon>
         </button>`;

    return `
      <div class="timer-row${isRinging ? ' ringing' : ''}">
        <div class="timer-icon" style="background:${meta.color}22">
          <ha-icon icon="${meta.icon}" style="color:${meta.color}"></ha-icon>
        </div>
        <div class="timer-info">
          <div class="timer-name" title="${name}">${name}</div>
          <div class="timer-countdown" style="color:${meta.color}" data-timer-id="${timer.id}">
            ${this._getCountdown(timer)}
          </div>
          <div class="progress-track">
            <div class="progress-fill${isRinging ? ' progress-ringing' : ''}"
              data-progress-id="${timer.id}"
              style="width:${pct}%;background:${meta.color}">
            </div>
          </div>
        </div>
        <div class="timer-actions">${actions}</div>
      </div>`;
  }

  // ── Horseshoe tile (SVG arc + countdown centred inside) ────────────────────

  _tileHtml(timer, meta) {
    const isRinging = timer.status === 'ringing';
    const name = timer.name || timer.extra_info?.sentence || timer.duration || timer.timer_class;
    const shortName = name.length > 14 ? name.slice(0, 13) + '…' : name;
    const { _HS_C: C, _HS_ARC: ARC } = ViewAssistTimersCard;
    const arcLen = (isRinging ? 1 : this._getProgress(timer.id)) * ARC;

    const actions = isRinging
      ? this._config.snooze_options.map(m =>
          `<button class="btn btn-snooze btn-sm" data-action="snooze" data-id="${timer.id}" data-minutes="${m}">+${m}m</button>`
        ).join('') +
        `<button class="btn btn-dismiss btn-sm" data-action="dismiss" data-id="${timer.id}">Stop</button>`
      : `<button class="btn btn-cancel btn-sm" data-action="cancel" data-id="${timer.id}" title="Cancel">
           <ha-icon icon="mdi:close"></ha-icon>
         </button>`;

    return `
      <div class="tile${isRinging ? ' ringing' : ''}">
        <div class="tile-type-icon" style="color:${meta.color}">
          <ha-icon icon="${meta.icon}"></ha-icon>
        </div>
        <svg class="horseshoe-svg" viewBox="0 0 100 100">
          <!-- Background horseshoe (270°, gap at bottom) -->
          <circle cx="50" cy="50" r="38" fill="none"
            stroke="${meta.color}33" stroke-width="9" stroke-linecap="round"
            stroke-dasharray="${ARC.toFixed(2)} ${(C - ARC).toFixed(2)}"
            transform="rotate(135 50 50)" />
          <!-- Progress arc — updated by _tickCountdowns -->
          <circle cx="50" cy="50" r="38" fill="none"
            stroke="${meta.color}" stroke-width="9" stroke-linecap="round"
            stroke-dasharray="${arcLen.toFixed(2)} ${(C - arcLen).toFixed(2)}"
            transform="rotate(135 50 50)"
            data-horseshoe-id="${timer.id}" />
          <!-- Countdown centred inside the arc -->
          <text x="50" y="50" class="hs-countdown" data-timer-id="${timer.id}">
            ${this._getCountdown(timer)}
          </text>
        </svg>
        <div class="tile-name" style="color:${meta.color}" title="${name}">${shortName}</div>
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
        position: fixed;
        bottom: 24px; right: 24px;
        z-index: 9999;
        background: var(--ha-card-background, var(--card-background-color, #fff));
        border: 1px solid var(--divider-color, rgba(0,0,0,.15));
        border-radius: 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,.25), 0 2px 8px rgba(0,0,0,.12);
        padding: 16px 20px;
        min-width: 280px; max-width: 380px;
        color: var(--primary-text-color, #212121);
        font-family: var(--mdc-typography-body1-font-family, Roboto, sans-serif);
        user-select: none;
      }
      .vatc-popup.vatc-movable { cursor: grab; }
      .vatc-popup.vatc-movable:active { cursor: grabbing; }
      .vatc-popup-header {
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 6px;
        font-size: 1em; font-weight: 700; color: #e53935;
      }
      .vatc-bell {
        display: inline-block;
        animation: vatc-ring .45s ease-in-out infinite alternate;
      }
      @keyframes vatc-ring {
        0%   { transform: rotate(-18deg); }
        100% { transform: rotate(18deg);  }
      }
      .vatc-alarm-row {
        padding: 10px 0;
        border-top: 1px solid var(--divider-color, rgba(0,0,0,.1));
      }
      .vatc-alarm-name {
        font-size: .95em; font-weight: 600; margin-bottom: 8px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        text-transform: capitalize;
      }
      .vatc-alarm-btns { display: flex; gap: 6px; flex-wrap: wrap; }
      .vatc-btn {
        border: none; border-radius: 8px; padding: 7px 16px;
        font-size: .82em; font-weight: 600; cursor: pointer;
        font-family: inherit; transition: filter .15s;
      }
      .vatc-btn:hover  { filter: brightness(1.12); }
      .vatc-btn:active { filter: brightness(.90);  }
      .vatc-btn-snooze { background: #fb8c00; color: #fff; }
      .vatc-btn-stop   { background: #e53935; color: #fff; }
    `;
    document.head.appendChild(s);
  }

  _showRingingPopup(ringingTimers) {
    // Skip re-render if the same set of timers is already showing
    const ids = ringingTimers.map(t => t.id).sort().join(',');
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
      const name  = t.name || t.extra_info?.sentence || t.duration || t.timer_class;
      const color = META_COLOR[t.timer_class] || '#e53935';
      const snooze = this._config.snooze_options.map(m =>
        `<button class="vatc-btn vatc-btn-snooze" data-action="snooze" data-id="${t.id}" data-minutes="${m}">Snooze ${m}m</button>`
      ).join('');
      return `<div class="vatc-alarm-row">
        <div class="vatc-alarm-name" style="color:${color}">${name}</div>
        <div class="vatc-alarm-btns">
          ${snooze}
          <button class="vatc-btn vatc-btn-stop" data-action="stop" data-id="${t.id}">Stop</button>
        </div>
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
        if (action === 'snooze') this._snoozeTimer(id, parseInt(minutes));
        else if (action === 'stop') this._cancelTimer(id);
      });
    });
  }

  _hideRingingPopup() {
    if (this._popupEl) {
      this._popupEl.remove();
      this._popupEl        = null;
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
      if (e.target.closest('[data-action]')) return; // don't drag when clicking buttons
      e.preventDefault();
      const pt   = e.touches ? e.touches[0] : e;
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

      .card-header {
        display: flex; align-items: center; gap: 8px;
        padding: 14px 16px 10px;
        font-size: 1.05em; font-weight: 500;
        color: var(--primary-text-color);
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.12));
      }
      .card-header ha-icon { color: var(--primary-color); --mdc-icon-size: 20px; }

      .card-body { padding: 6px 0 8px; }
      .card-body::-webkit-scrollbar { width: 4px; }
      .card-body::-webkit-scrollbar-thumb {
        background: var(--divider-color, rgba(0,0,0,.2)); border-radius: 4px;
      }

      .section { padding: 2px 0; }
      .section-header {
        display: flex; align-items: center; gap: 5px;
        padding: 6px 16px 3px;
        font-size: .7em; font-weight: 700;
        text-transform: uppercase; letter-spacing: .09em;
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
      .progress-fill {
        height: 100%; border-radius: 3px;
        transition: width .9s linear;
      }
      .progress-ringing {
        animation: progress-flash .6s ease-in-out infinite alternate;
      }
      @keyframes progress-flash { 0%{opacity:1} 100%{opacity:.2} }

      .timer-actions { flex-shrink: 0; display: flex; gap: 5px; align-items: center; }

      /* ── Horseshoe tile mode ────────────────────────────────────────────── */
      .tile-grid { display: grid; gap: 8px; padding: 8px 10px; }
      .tile {
        display: flex; flex-direction: column; align-items: center; gap: 2px;
        padding: 8px 4px 6px; border-radius: 10px; transition: background .15s;
        position: relative;
      }
      .tile:hover { background: var(--secondary-background-color); }

      .tile-type-icon {
        position: absolute; top: 5px; left: 5px;
        --mdc-icon-size: 14px; opacity: .7;
      }

      .horseshoe-svg { width: 90px; height: 90px; overflow: visible; }

      .hs-countdown {
        fill: var(--primary-text-color);
        font-size: 16px; font-weight: 700;
        font-family: var(--mdc-typography-body1-font-family, Roboto, sans-serif);
        font-variant-numeric: tabular-nums;
        dominant-baseline: middle; text-anchor: middle;
      }

      .tile-name {
        font-size: .75em; font-weight: 600; text-align: center;
        max-width: 90px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        text-transform: capitalize;
        margin-top: 1px;
      }
      .tile-actions {
        display: flex; gap: 4px; flex-wrap: wrap; justify-content: center;
        margin-top: 2px;
      }

      /* ── Buttons ────────────────────────────────────────────────────────── */
      .btn {
        border: none; border-radius: 6px; padding: 5px 12px;
        font-size: .78em; font-weight: 600; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: filter .15s; font-family: inherit;
      }
      .btn:hover  { filter: brightness(1.12); }
      .btn:active { filter: brightness(.92);  }
      .btn-sm { padding: 3px 8px; font-size: .72em; }

      .btn-cancel {
        background: var(--secondary-background-color, rgba(0,0,0,.06));
        color: var(--secondary-text-color); padding: 5px 7px;
      }
      .btn-cancel ha-icon { --mdc-icon-size: 17px; }
      .btn-dismiss { background: #e53935; color: #fff; }
      .btn-snooze  { background: #fb8c00; color: #fff; }

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

  // Called by HA when the user opens the card editor
  setConfig(config) {
    this._config = {
      title: 'Timers, Alarms & Reminders',
      display_mode: 'bar',
      columns: 2,
      max_height: 0,
      hide_when_empty: false,
      show_ringing_popup: true,
      popup_movable: true,
      snooze_options: [5, 10],
      refresh_interval: 5,
      show_types: ['timer', 'alarm', 'reminder'],
      ...config,
    };
    this._render();
  }

  // HA passes hass to editors; we don't need it but must accept it
  set hass(_) {}

  _fire() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: { ...this._config } },
      bubbles: true,
      composed: true,
    }));
  }

  _render() {
    const c  = this._config;
    const st = c.show_types || ['timer', 'alarm', 'reminder'];
    const isHorseshoe = c.display_mode === 'horseshoe';
    const showPopup   = c.show_ringing_popup !== false;

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
          <label>Max card height px (0 = unlimited / no scroll)</label>
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
          <span class="toggle-label">Show popup when alarm rings</span>
          <label class="toggle-switch">
            <input type="checkbox" name="show_ringing_popup" ${showPopup ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="toggle-row row-popup-movable" style="display:${showPopup ? '' : 'none'}">
          <span class="toggle-label">Allow ringing popup to be dragged</span>
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

    ['timer', 'alarm', 'reminder'].forEach(type => {
      root.querySelector(`[name=show_${type}]`).addEventListener('change', () => {
        const types = ['timer', 'alarm', 'reminder'].filter(
          t => root.querySelector(`[name=show_${t}]`).checked
        );
        // Always keep at least one type active
        this._config = { ...this._config, show_types: types.length ? types : ['timer', 'alarm', 'reminder'] };
        this._fire();
      });
    });

    root.querySelector('[name=hide_when_empty]').addEventListener('change', e => {
      this._config = { ...this._config, hide_when_empty: e.target.checked };
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
      const opts = e.target.value.split(',')
        .map(s => parseInt(s.trim()))
        .filter(n => !isNaN(n) && n > 0);
      this._config = { ...this._config, snooze_options: opts.length ? opts : [5, 10] };
      this._fire();
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
        width: 100%; box-sizing: border-box;
        padding: 8px 10px;
        background: var(--input-fill-color, var(--secondary-background-color, rgba(0,0,0,.05)));
        border: 1px solid var(--input-ink-color, var(--divider-color, rgba(0,0,0,.2)));
        border-radius: 6px;
        color: var(--primary-text-color);
        font-size: .9em; font-family: inherit;
        outline: none; transition: border-color .15s;
      }
      .field input:focus,
      .field select:focus { border-color: var(--primary-color, #03a9f4); }
      .field select { cursor: pointer; }

      .checkboxes {
        display: flex; gap: 16px; flex-wrap: wrap;
        padding: 4px 0 14px;
      }
      .checkbox-item {
        display: flex; align-items: center; gap: 6px;
        font-size: .88em; color: var(--primary-text-color); cursor: pointer;
      }
      .checkbox-item input[type=checkbox] {
        accent-color: var(--primary-color); width: 16px; height: 16px; cursor: pointer;
      }

      .toggle-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 9px 0;
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.06));
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
        content: ''; position: absolute;
        width: 16px; height: 16px; left: 3px; top: 3px;
        background: #fff; border-radius: 50%;
        box-shadow: 0 1px 3px rgba(0,0,0,.3);
        transition: transform .2s;
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
