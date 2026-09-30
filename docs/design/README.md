# Handoff: Kova, smart home platform (desktop web app v3)

## Overview
Kova is a local-first smart home platform meant to fully replace Home Assistant (HA). HA is organised around devices and entities. Kova is organised around **time** and **the state of the house**:

- **Now / Home Timeline**: one scrubbable 24-hour line showing what happened (and why), the current mode, and what comes next.
- **Modes**: the home is always in one time-based mode (Day, Evening, Wind down, Night, Dawn). Overlays sit on top (Movie, Date, Party, Good night, Away, Guests) and end by themselves. Behaviours such as "Light the way" attach to modes.
- **Teach, test, trust**: every mode or rule is replayed against the last 14 days of real history before and after it goes live, and findings are shown with one-tap fixes.
- **Why? everywhere**: every device shows what set its current state and what will change it next.
- **Depth levels L1–L4**: everyone sees L1 (control); L2 is personalisation; L3 is automation; L4 (code, entity ids, dev tools) appears only with the Advanced mode switch.

All demo data comes from the owner's real HA config (github.com/clickbitau/kova): 28 devices, 10 rooms, 13 automations, 4 scripts and 24 integrations.

## About the design files
The files in this bundle are **design references created in HTML**. They are prototypes showing the intended look and behaviour, not production code to copy. Recreate them in the target stack. None exists yet; a sensible choice would be React + TypeScript for web (and React Native or native for mobile) on a local backend. Each `.dc.html` opens directly in a browser (it needs `support.js` beside it). The markup is inline-styled, and the behaviour lives in the `class Component` script at the bottom of each file.

## Fidelity
**High-fidelity.** Colours, type, spacing, radii and copy are final for v1. Recreate them pixel-accurately. Data values marked *(demo)* below are placeholders.

## Screens (Kova App v3.dc.html)
Layout: a sticky left sidebar (236px, bg #111214, border-right 1px rgba(255,255,255,.07), full height) plus a main column (padding 30px 40px 80px, flex column, gap 28px). Main is `position:relative; isolation:isolate; overflow:hidden` so the mode glow can sit behind the content.

### Sidebar
- Logo tile: 30×30, radius 9, bg #1d1e21, mark at 22px. "Kova" 18/800, −0.02em. Home name 12px #a3a09a.
- **Current-mode chip**: bg #17181b, radius 12, padding 11px 12px. A 10px dot in the mode colour with a 4px ring in the mode tint, then the mode name (13/700) and "until 20:00" (11px). Clicking it opens Modes.
- Nav items (14/600, padding 8px 12px, radius 10, icon 20px): Now, Modes, Rooms, Energy, Security, Media, Activity (badge = unread inbox count), Ask Kova. After a 14px gap: Integrations, Import (badge = review items left). Developer appears only in Advanced mode. Active item: bg rgba(242,177,76,.12), text #f2b14c. Inactive text: #d8d5cf.
- Footer: a "Mirroring Home Assistant" status card (green dot #7fd4a0), and an Advanced mode switch (34×20, amber track when on).

### 1. Now (home)
- **Ambient glow**: an absolute radial gradient behind the header in the current mode colour at about 19% alpha (`color + '30'`).
- **Preview banner** (only while previewing): bg mode tint, 1px mode line. Text: "Previewing 23:40 · Night. This is what the home will look like." Button: "Back to now".
- **Header**: date line (13px #a3a09a), then the mode icon (42px, filled, mode colour) and mode name at 46/700, −0.03em. Below that, "Until 20:00, then Wind down" (15px #c9c6c0). An optional overlay chip reads "Movie is on · ends when the TV turns off" with an End button. On the right: a weather card and a people card ("Both home", "8 lights on").
- **Timeline card** (bg #16171a, radius 20, padding 20px 22px):
  - Band row: 44px tall, radius 12, one segment per mode (width = hours/24), bg = mode colour + alpha 22 (current mode 40). The mode name (12/700, mode colour) shows only if the band is longer than 2.5h.
  - Event row: 152px tall. Each event is a 10px dot plus a label (11.5/600), one row per event in the evening cluster (25px step). Past events: filled #f1efea. Future events: outlined and labelled in the mode colour at that time. Skipped events: opacity .35.
  - Now line: 2px white, spanning the band row.
  - **Scrub**: clicking anywhere sets the preview hour to x/width × 24. It snaps back to "now" if within 0.3h. The preview line is 3px in the mode colour, with a time chip (mono 11px, dark text on the mode colour).
- **Just happened** / **Coming up** (two auto-fit columns, min 360px). Rows show a mono time, a title (14/600) and the cause ("↳ Light the way · doorbell camera saw someone"). Coming-up rows have a "Skip tonight" / "Undo" button; a skipped row gets line-through, opacity .5 and the text "Skipped tonight".
- **Switch the home to**: 6 overlay cards (min 150px) with an icon well, name and "Ends …" line. The active card has an amber tint and border.
- **Rooms**: compact cards (min 140px) showing an icon and "3 on" / "Playing" / "All off". They reflect the preview state.
- **Kova checked your modes** card: shows while any findings are open. Its Review button opens Modes.

### 2. Modes
- Header: "5 modes · 6 overlays · 1 behaviour, replacing 17 HA items", with a link to "Imported rules (13)" (the legacy automation list).
- **Findings** (auto-fit, min 300px). Each card has a kind, a mode pill, a title, a body, a primary fix button and a secondary dismiss button:
  1. *Evening lights come on when nobody's home*. Fix: "Only when someone's home". The Evening start becomes "10 min before sunset, if someone's home".
  2. *Kitchen ceiling stays on all night*. This is real: Evening turns on kitchen_switch_1, but Wind down only turns off switches 2 and 3. Fix adds kitchen_ceiling off to Wind down.
  3. *"After sunset" stops working at midnight*. This is a real HA gotcha. Fix: "Use after dark" (sunset to sunrise).
- Two columns: a left column of 300px and an editor column of 1fr.
  - Left: the "Through the day" list (5 modes; the selected one has a border in the mode colour at alpha 66 and a NOW pill on the current mode), an "On top" list of overlays, and a "Light the way" behaviour card.
  - **Mode editor** (bg #16171a, radius 20, with a 6px top bar in the mode colour):
    - Header: icon well, name 24/700, time span, and a Preview button (jumps to Now with a preview at the mode start + 0.25h).
    - "Starts [chip in mode colour] ends [chip]".
    - **How the home should be**: grouped by room (110px label column plus chips, e.g. "Lamp 78% · 3000K").
    - Night and Dawn also list what is inherited from earlier modes ("Still on from earlier: …").
    - **Moments in this mode**: time-based one-offs, e.g. 21:00 Rain sounds.
    - Light the way switch for this mode.
    - **Tested on the last 14 days**: 14 squares (colour = ran OK, #ff6b5e = problem, #26272b = skipped) plus a summary sentence. The results update after a fix.

### 3. Rooms
- Room filter pills (selected: bg #f1efea, text #141517).
- Device tiles (min 210px, radius 18, padding 16px). Tapping the icon or name toggles the device; ⋯ opens the drawer.
  - Light on: bg rgba(242,177,76,.11), border rgba(242,177,76,.28), icon well in amber (or the light's colour).
  - Media playing: blue tint.
  - Camera: green icon.
  - Off: #16171a with a muted icon.
  - Entity id (mono 10.5px) shows only in Advanced mode.
- **Device drawer**: 420px from the right, bg #141517, over a scrim rgba(0,0,0,.55). Tabs: Simple, Details, and Code (Advanced only).
  - Simple: a hero toggle, then the **Why card** ("Why it's like this" = the last mode event that set it; "What's next" = the next scheduled change), then a brightness slider and warmth presets (2200/2700/3000/4000K).
  - Details: facts plus "Used in".
  - Code: JSON state with the HA alias.

### 4. Energy · 5. Security · 6. Media · 7. Activity · 8. Ask Kova · 9. Integrations · 10. Import · 11. Developer
These are carried over from v2 (same visual language). See the file for details:
- **Energy**: right-now flow (Solar → Home ← Grid), 4 stat cards, a 24h bar chart (solar amber over use #4a4b50), and measured devices. *(demo numbers)*
- **Security**: main camera (16:9 placeholder) plus a thumbnail switcher, who's home, today's events, and an empty state for locks.
- **Media**: a now-playing card (blue play button #7cb8f0, volume, sources), plus a player list.
- **Activity**: filter pills, a cause-annotated timeline, and a "Needs you" inbox (repair, update, suggestion).
- **Ask Kova**: a chat with canned intents: "downstairs" (asks, then learns), "garage" (explains why), "power", and "movie".
- **Integrations**: search, filters (All / Needs attention / Local / Cloud), and cards with a status dot (green ok, amber attention, blue linked to Warden or Helix).
- **Import**: HA migration steps, stats, a review list and suite hand-offs.
- **Developer**: a filterable entity table.

## Phone app (Kova Phone.dc.html, iPhone, 402×874)
The file shows two frames: the interactive app and the lock screen. The frame comes from `ios-frame.jsx`; `IOSDevice` takes `time`, and the lock screen passes an empty value. The visual language is the same as desktop. Content padding is 62px 18px 20px (to clear the status bar). All scrollers hide their scrollbars.

- **Tab bar**: Now, Rooms, **Ask** (centre: 46px amber circle raised 20px, icon #1a1408), Modes, Activity.
  - Bar: bg rgba(17,18,20,.96), top hairline, bottom padding 30px for the home indicator.
  - Active tab: filled icon (Modes uses the mode colour, others amber).
- **Now**:
  - Header: home name and avatars, then the date line, then the mode icon plus name (38/700), then "Until 20:00, then Wind down · 8 lights on".
  - A 30px day band with a now line.
  - **Coming up**: horizontal cards, 200px wide, each with Skip tonight.
  - **Favourites**: 2×2 tiles (Lamp, TV backlight, Porch, Garage).
  - **Switch the home to**: horizontal overlay chips.
  - Findings row, then **Just happened**.
  - The mode glow is a radial gradient at the top-left.
- **Rooms**: horizontal room pills, then a summary line with "All lights off", then a 2-column tile grid. Tapping a tile toggles it; ⋯ opens the bottom sheet.
- **Device sheet**: radius 28 top, bg #141517. Contains a grabber, the room and name, a 52×32 switch, a brightness slider (dimmers), and the Why / What's next card.
- **Modes**: findings cards (fix / later), then 5 expandable mode cards. An expanded card shows target chips and the 14-day test strip. The NOW pill sits on the current mode.
- **Activity**: filter pills, then rows with a 32px tinted icon, what, why, and time on the right.
- **Ask**: see Assistant below. The input bar is pinned above the tab bar.
- **Lock screen**: 92px clock.
  - Live Activity card (radius 24, bg rgba(28,29,32,.88)): mark tile, then "Evening · 8 lights on", then "20:00 Wind down · lamp to 5%", then a progress bar and a Skip button.
  - Doorbell notification: camera thumbnail plus "View camera" and "Talk" buttons.

## Assistant (Ask): must work with NO AI
Kova does not ship with AI. The assistant is a deterministic intent parser running on the home server, with optional AI layered on top.

**Built-in (the default, offline)** handles:
- Device control by name or room, including brightness ("lamp to 30%")
- Overlays and modes ("I'm leaving", "movie")
- "Why is X on", answered from the event log's cause chain
- "What's happening tonight", answered from the mode schedule
- "Who's home", answered from presence
- Clarifying labels such as "downstairs": Kova asks once, then stores the answer as a label

**Understood preview**: as the user types, the parse shows as chips before running (e.g. [Turn off] [Kitchen lights] [3 devices]). Unparsed input gets a plain fallback message.

**Every reply carries a source tag**: From the activity log, From your modes, Device control, or Built-in · nothing left your home.

**Engines (Assistant settings sheet)**:
1. **Built-in**: default.
2. **Local AI**: a model on the user's own server (e.g. via Dockbit).
3. **Cloud AI**: the user's own API key.

**AI rules**:
- AI only receives requests that the built-in parser cannot handle.
- "What the AI can see" toggles:
  - Device and room names: on
  - Current device states: on
  - Activity history: off
  - Who's home: off
  - Cameras: locked off, never shared
- Every AI request is logged in Activity.

**Suggested implementation**: an intent grammar with slots (action, target, value, time), fuzzy matching against device, room and label names plus synonyms, and question handlers that query the event log and mode schedule directly.

## Interactions & behaviour
- Scene or overlay activation snapshots the previous device state. A toast (bottom centre, inverted #f1efea on #141517, 5s) offers Undo. Ending an overlay restores the snapshot.
- Preview mode is read-only: it runs the day simulation and does not change real devices.
- Transitions: 120ms for hover and press (press scales to .97); 200ms ease-out for state changes; 280ms for the drawer.
- Every destructive or bulk action is undoable.

## State (see `class Component` in the file)
- `devs`: map of id → {type, on, bri, k, color, mode, media, vol}.
- `preview`: hour or null.
- `overlay`, `overlayPrev`.
- `skip`: {eventId: bool}.
- `modeSel`.
- `fixed` / `dismissed`: findings.
- `ltw`: {modeId: bool}.
- `drawer`, `tab`, `advanced`, plus v2 screen state.

### Simulation
`sim(base, hour)`:
1. Start from a baseline: all lights off, media off, purifiers Auto.
2. Apply mode and moment events in day order, beginning from sunrise at 05:56. Order them with `rel(h) = h < 5.93 ? h + 24 : h`.
3. Skip any event the user has marked skipped.

The same event list drives Coming up, the Why card and the mode editor.

### Backend model to support this
- Home, Space (room, zone, floor), Device, Capability (entity, keeping the HA id as an alias).
- Mode: time window driven by Rhythms (sun, prayer times, fixed times), with target states.
- Overlay: temporary mode with an end condition.
- Behaviour: rule attached to modes and rooms.
- Moment: one-off timed action inside a mode.
- Event log: every state change with its cause.
- History replay: dry-running any mode or rule against the stored event log.

## Design tokens
All tokens are in `styles.css` and `tokens/*.css`; the visual spec is in `Kova Design Language.dc.html`.

**Surfaces:** #0e0f10 page, #111214 nav, #16171a card, #1c1d20 inset, #232428 control, #2a2b2f selected, #35363a switch off.

**Text:** #f1efea primary, #d8d5cf secondary, #a3a09a muted, #6f6d69 faint.

**State colours:**
- Amber #f2b14c: on, primary action, triggers. Hover #f7cb82; text on amber #1a1408.
- Blue #7cb8f0: media and air.
- Green #7fd4a0: ok and present.
- Red #ff6b5e: alert.
- Violet #d9a3f0: developer.
- Tints are the colour at 13–15% alpha.

**Mode colours:** Day #dcd27e, Evening #f2b14c, Wind down #ef8f6e, Night #8aaef0, Dawn #d8a6e0. Derived values: tint = colour + "24", line = colour + "55", glow = colour + "30".

**Type** (Manrope, with JetBrains Mono for ids and times):
- Hero mode name 46/700 at −3%
- H1 30/700 at −2%
- H2 17/700
- Title 15/700
- Body 14/500–600
- Label 13/600
- Caption 12/500
- Overline 12/700, uppercase, +6%

**Radii:** 6 badge, 9 tab, 10 button, 12 input, 16 card, 18 tile, 20 hero card, pill.

**Spacing:** 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40.

**Shadow:** floating layers only, `0 10px 30px rgba(0,0,0,.4)`.

## Assets
- `assets/logo/`: the chevron mark on dark and on light, the app icon and the favicon (original to Kova).
- Icons: Material Symbols Rounded (Google Fonts). Outline for off or nav; FILL 1 for on or active.
- Camera and artwork areas are striped placeholders.
- The logo sting is in `Kova Logo Motion.dc.html`, built with `kova-sting.jsx` and `animations-v3.jsx`.

## Files
- `Kova App v3.dc.html`: the main prototype. All screens and state are here.
- `Kova Phone.dc.html` + `ios-frame.jsx`: iPhone app and lock screen.
- `Kova Direction.dc.html`: product rationale (Timeline, Modes, Test on history).
- `Kova Sitemap.dc.html`: 49 pages mapped to HA features and to levels L1–L4.
- `Kova Design Language.dc.html`: foundations and component specs.
- `Kova Logo Motion.dc.html` + `kova-sting.jsx`: logo animation.
- `styles.css`, `tokens/`, `assets/`
- `support.js`: runtime needed to open the `.dc.html` files locally.
