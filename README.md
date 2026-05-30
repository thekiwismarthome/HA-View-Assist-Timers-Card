# View Assist Timers Card

A Home Assistant Lovelace custom card that displays all active timers, alarms, and reminders from the [View Assist](https://github.com/dinki/view-assist) integration. Supports real-time countdowns, progress indicators, a ringing popup overlay, and full visual configuration via the HA card editor.

---

## Installation

1. Copy `view-assist-timers-card.js` to your Home Assistant `config/www/` directory.
2. Add it as a Lovelace resource:

```yaml
resources:
  - url: /local/view-assist-timers-card.js
    type: module
```

3. Add the card to a dashboard:

```yaml
type: custom:view-assist-timers-card
```

---

## Visual Editor

All options can be configured through the built-in card editor — click the pencil icon on the card in your dashboard. No YAML editing required.

---

## Configuration Options

| Option | Default | Description |
|---|---|---|
| `title` | `Timers, Alarms & Reminders` | Card header text. Set to `''` to hide the header. |
| `show_types` | `[timer, alarm, reminder]` | Which types to display. |
| `display_mode` | `bar` | `bar` — list rows with a linear progress bar. `horseshoe` — tile grid with a circular arc. |
| `columns` | `2` | Tiles per row in horseshoe mode. |
| `max_height` | `0` | Maximum card body height in px before it scrolls. `0` = no limit. |
| `hide_when_empty` | `false` | Collapse the card in-place when there are no active timers/alarms/reminders. |
| `float_when_active` | `false` | Hide the card in the dashboard entirely; float it as a screen overlay when alarms are active. |
| `float_position` | `bottom-right` | Where the float card appears: `bottom-right`, `bottom-left`, `top-right`, `top-left`. |
| `show_ringing_popup` | `true` | Show a floating popup overlay when an alarm is ringing. |
| `popup_movable` | `true` | Allow the ringing popup to be dragged around the screen. |
| `snooze_options` | `[5, 10]` | Snooze durations (minutes) offered in the ringing popup and on ringing rows. |
| `va_entity_id` | `''` | Your View Assist satellite entity ID (e.g. `view_assist.living_room`). Required when using the `+` button to create timers — the VA `set_timer` service needs this to associate the new timer with a device. |
| `show_add_button` | `false` | Show a `+` button in the header to manually create a timer, alarm, or reminder. |
| `create_service` | `set_timer` | The View Assist service called when creating a new timer. Adjust if your VA version uses a different name. |
| `refresh_interval` | `5` | Seconds between API polls. |

### Example YAML

```yaml
type: custom:view-assist-timers-card
title: "Timers, Alarms & Reminders"
display_mode: horseshoe
columns: 3
max_height: 400
hide_when_empty: true
show_ringing_popup: true
popup_movable: true
snooze_options:
  - 5
  - 10
  - 15
refresh_interval: 5
show_types:
  - timer
  - alarm
  - reminder
```

---

## Features

### Display Modes

**Bar mode** (default)

Timers are shown as a grouped list. Each row has a type icon, the timer name, a live countdown, and a thin progress bar that fills as time elapses. When a timer is ringing the bar flashes at full width.

**Horseshoe mode**

Each timer is shown as a tile containing a 270° SVG arc progress indicator. The arc fills clockwise as time elapses. The countdown is centred inside the arc; the timer name appears below. The number of tiles per row is controlled by `columns`.

### Progress Tracking

Both modes show elapsed progress. The card derives the total duration from the View Assist API response (`duration`, `total_duration`, or the first-observed `seconds_remaining`). Progress is updated every second without re-fetching from the API.

### Scrollable Card

Set `max_height` to a pixel value (e.g. `300`) to cap the card body height. A thin scrollbar appears when the content overflows.

### Hide When Empty

Set `hide_when_empty: true` to collapse the card in-place when there are no active timers. The card reappears as soon as one becomes active.

### Float When Active

Set `float_when_active: true` to remove the card from the dashboard grid entirely. When any timer, alarm, or reminder becomes active the card appears as a fixed overlay at the position set by `float_position` (`bottom-right` by default). It disappears again once all alarms are cleared.

This is the recommended mode for an "always-available but non-intrusive" timer display. When combined with `popup_movable: true`, the floating card can be dragged to any screen position.

### Ringing Popup

When `show_ringing_popup: true` (the default), a floating panel appears in the bottom-right corner of the screen whenever one or more alarms are ringing. The popup:

- Lists each ringing alarm by name with colour-coded labels.
- Offers configurable snooze buttons (e.g. Snooze 5m, Snooze 10m).
- Has a **Stop** button to dismiss the alarm immediately.
- Disappears automatically once all ringing alarms have been snoozed or stopped.

The popup escapes the card's shadow DOM so it overlays the full screen, regardless of where the card sits on the dashboard.

### Draggable Popup

With `popup_movable: true`, the ringing popup can be dragged to any position on screen using mouse or touch. Button clicks inside the popup are never treated as drag actions.

### Ringing Actions (Main Card)

Ringing timers in the main card also show action buttons directly in the row/tile — snooze options and a Stop button — so you can act without relying on the popup.

---

## Timer Types

| Type | Colour |
|---|---|
| Timer | Blue `#039be5` |
| Alarm | Red `#e53935` |
| Reminder | Orange `#fb8c00` |

---

## Theming

The card uses Home Assistant CSS variables throughout (`--primary-text-color`, `--secondary-text-color`, `--primary-color`, `--divider-color`, `--secondary-background-color`, `--ha-card-background`) so it adapts automatically to light and dark themes.

### Add Timer Button

Enable `show_add_button: true` to show a `+` icon in the card header. Clicking it opens an inline panel with:

- **Type tabs** — Timer, Alarm, or Reminder
- **Label** — optional name for the timer
- **Duration** (timer type) — hours, minutes, seconds fields
- **Time picker** (alarm/reminder type) — standard HH:MM picker
- **Set** button — calls `view_assist.<create_service>` with the entered values

The panel stays open across data-poll re-renders so you can type without interruption. The `create_service` config option lets you match the exact service name your View Assist version exposes.

---

## Planned

- Confirmation feedback when a new timer is successfully created.
- Editable timer/alarm from the detail view.
