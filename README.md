# HA-View-Assist-Timers-Card

feat: add progress bars, horseshoe mode, ringing popup, and display config options
New config options:

| Option | Default | What it does |
| display_mode	bar	bar = rows with linear progress bar; horseshoe = tile grid with SVG arc
| columns	2	Tiles per row in horseshoe mode
| max_height	0	Max px before card body scrolls; 0 = no limit
| hide_when_empty	false	Collapses the card entirely when no active alarms
show_ringing_popup	true	Floating popup overlay when an alarm rings
popup_movable	true	Popup can be dragged around the screen
snooze_options	[5, 10]	Minutes offered as snooze buttons (popup + ringing rows)


Feature details:

1. Bar mode — unchanged layout, now with a thin 3px progress bar below each countdown that fills as time elapses; flashes at full width when ringing
2. Horseshoe mode — SVG arc (270°, gap at bottom) per tile; arc fills clockwise as time elapses; countdown centred inside; tile name below
3. Scrollable — max_height: 300 adds overflow-y: auto + styled scrollbar to card body
4. Hide when empty — sets this.style.display = 'none' on the host element when no active alarms
5. Ringing popup — appended to document.body (escapes shadow DOM); appears in bottom-right corner; shows all currently ringing alarms with snooze buttons per snooze_options + Stop; re-renders only when the ringing timer set changes
6. Draggable popup — mousedown/touchstart drag on the popup body (skips drag when clicking buttons)

TODO comment — at top of file noting the future manual alarm/timer creation button
