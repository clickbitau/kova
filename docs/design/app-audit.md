# Kova phone app: design audit

Every screen of the Expo app (`mobile/`) rendered with its web build at 390×844 against the demo hub, plus
the device panels for every kind of device. Screenshots: `docs/design/screens/before/` and `…/after/`.

The visual language stays: dark, amber `#f2b14c` for light and "on", blue for media and air, green for
healthy and present, red for alerts, Manrope. The gap is execution: the app looked like a set of
hand-built screens rather than one system, and it didn't say enough about what was happening.

## Priorities

**P0: broken or misleading**
1. **No real states.** No loading design at all: the first connect showed the word "Connecting…" on a blank
   page. If the hub was unreachable at launch, the app sat on "Can't reach your hub. Trying again…" for good,
   with no way to retry or pick another hub. Camera tiles were grey boxes until the snapshot came. Ask
   gave no sign it was thinking. Web pages showed a bare spinner.
2. **Empty sections disappear or go blank.** "Just happened" on Now rendered a heading and nothing under it
   when nothing had happened yet. Activity said "Nothing here yet." in body text.
3. **Offline banner covers the header.** "Reconnecting to your hub…" floated over the home name and the
   people avatars, and nothing said when the connection came back.
4. **No feedback between tap and result.** A tile flipped optimistically, but if the hub refused, it
   snapped back with only a toast; nothing showed a command in flight. Buttons that call the hub (fixes,
   Skip tonight, overlays, room "All off") gave no pending or done state; double taps sent twice.
5. **Contrast.** Timeline hour labels and the version line used `#6f6d69` on `#0e0f10` (about 3.6:1) at
   10–11 px. Placeholder text the same.

**P1: system**
6. **No type scale.** 25 distinct sizes (10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 17, 22,
   27, 30, 32, 34, 38, 40…), weights chosen per call. Titles were 32 on tabs, 27 on pushed screens and
   30 on Ask.
7. **No spacing or radius scale.** Radii 8, 9, 10, 11, 12, 14, 16, 17, 18, 20, 22, 28 for similar
   things; gaps 2–22 picked per view; negative margins to pull rows together on Devices.
8. **Flat depth.** Every surface was `#16171a` on `#0e0f10` with no edge, so cards blurred into the page,
   sheets had a weak scrim, and nothing felt raised. No top highlight, no elevation steps.
9. **Headers don't behave.** Large titles scrolled away with nothing left behind; pushed screens lost
   their back button on scroll. Tapping the active tab didn't scroll to top.
10. **Tab bar.** Static: no indicator, no motion on select, no `tab` role or selected state for screen
    readers; the More badge had no label.
11. **Inconsistent components.** Five button styles hand-built in screens (findings, Skip tonight, Set up,
    Play, Save), three chip styles, three list-row styles, two kinds of section label (17/700 title vs
    11/700 caps).

**P2: screens**
12. **Now.** The day timeline was a strip of near-black bands with no labels: you couldn't tell which mode
    was which. Overlays were a scrolling row with the 4th cut off and no "ends …" line. People were
    initials with no presence cue. "3 lights on" wasn't actionable.
13. **Devices.** Two pill rows plus search took a third of the screen before the first device; type filter
    chips were a different style from room pills. Tiles were all the same weight; a dimmer's level was
    only text; an offline device looked like an off one.
14. **Device panels.** Brightness and volume sliders were thin 8 px tracks; the AC was − / 23° / + with a
    command per tap; fan speed was an overflowing pill row; vacuum was two flat buttons; the camera panel
    had no picture; a sensor panel was just settings. Settings mixed labels, a text field, a pill row
    and switches with no grouping.
15. **Ask.** Big empty middle; suggestions vanished after two messages; no typing indicator; bubbles
    without shape; the source line read as noise.
16. **Security.** Cameras: grey boxes, a red play icon labelled "Live" (it's a still). Who's home and
    Network as plain cards; "Nothing yet today." as body text.
17. **More.** One long list mixing places (Modes, Activity), setup (Integrations, Customise) and this phone;
    connection status as grey footnote text.
18. **Modes.** Findings looked like any card; open/close had no affordance (no chevron); the 14-day
    squares had no legend.
19. **Activity.** No grouping, filter pills reused room style, no empty state.
20. **This phone.** "Disconnect this phone" was one tap, no confirmation; switches showed nothing while
    the OS permission prompt ran.
21. **Connect.** Fine bones; buttons had no pressed/busy detail beyond text; error box low contrast; the
    scan screen had no frame to aim at.

**P3: polish**
22. Copy: a few long or technical lines ("Kova replayed your modes on the last 14 days", "only if your hub
    has one (KOVA_TOKEN)"), "Carry on" for resume. Tightened.
23. Accessibility: icon-only buttons missing labels (search clear had one, sheet grabber was "Close" twice,
    swatches said "Colour #ff5a4e"), no `header` roles, toggles in rows not reachable as one element.
    Dynamic type: fixed `lineHeight` multipliers fine; icons don't scale (by design).
24. Android widget: flat tiles with no on/off cue beyond a tint, no icon, no empty state for "no favourites".
    The iOS widget is Swift (native) and can't change over the air; noted for the next store build.

## Shared components: what changes

| Piece | Weak | Change |
|---|---|---|
| `theme.ts` | colours and motion only | add type scale `TYPE`, spacing `SP`, radii `R`, elevation `ELEV`, surface colours with edges; raise small-text grey |
| `Text` | size/weight per call | `variant` from the scale; header role for titles |
| `Screen` | static title in scroll | large title that hands over to a compact bar on scroll (with back), scroll-to-top on tab re-tap, connection banner in flow |
| `Card` / `Surface` | one flat colour | raised surface with hairline edge and top highlight; tinted variant |
| `Button` | three kinds, "Working…" text | primary / secondary / ghost / danger, sm/md, async: spinner while pending, check when done, shake when failed; guards double taps |
| `Pill` / `Segmented` | pills only | pills for many choices; a segmented control with a sliding thumb for few (filters, fan speed, modes) |
| `Row` / `Group` | ad hoc | inset grouped list with section header and footer; switch rows that toggle from anywhere on the row |
| `Skeleton` | none | shimmering placeholders (still with reduced motion) |
| `Empty` | ok | used for every empty list, compact variant |
| `Tile` | one look | pending ring while a command is in flight, shake on failure, level bar for dimmers and volume, offline look, long-press for the panel |
| `Sheet` | thin scrim, plain header | darker scrim, grabber with a11y label, sections via `SheetSection` |
| `FillSlider` | thin track | 52 px "fill" slider: drag anywhere, relative (no jump), value inside, ticks at quarters |
| `ToastHost` | fine | icon for success, keeps undo |
| Tab bar | static | sliding pill indicator, icon pop, tab roles, badge label |

## Device panels, by kind

- **Light (on/off):** header + big power. Nothing else: say what changes it next.
- **Dimmer / colour light:** fill slider for brightness; warmth swatches with a check; colour swatches with ring.
- **Fan / purifier:** segmented Auto / Sleep / Manual.
- **Air conditioner:** arc gauge for target with − / +, room temperature inside; local value with a short
  debounce so tapping + three times sends one command; segmented mode with colours; fan speed segmented.
- **Speaker:** fill slider for volume with mute; now playing card (art, title, artist) and transport; sources grid.
- **Soundbar:** volume, mute, input and sound as tiles (unchanged layout, new tokens), night mode row.
- **TV:** source segmented / pills; Pause / Stop; library search field.
- **Speaker group:** members and sync shown as a row with avatars of the members.
- **Vacuum:** status card with battery meter, Clean / Dock as two big buttons.
- **Camera:** the latest picture in the panel, Watch live.
- **Plug:** power reading as a stat.
- **Sensor:** readings grid as the main content.

## Also in this pass

- **App updates in More.** What's running (version and train), the status (checking, up to date, "Kova 0.x.y
  is ready", couldn't reach the hub), Check now, Restart to update, and what's new. The release notes ride in
  the bundle's config (export-ota adds the last five), so the phone can say what an update brings before it
  restarts. The automatic "ready" toast now has a Restart button.
- **Arrive and leave without location.** When the hub says something already knows a person is home
  (`people[].via`, e.g. Warden or the router), This phone says so and keeps the phone's location as a
  collapsed, optional extra. With nothing else, location stays the way.

## Fixed along the way

- No retry or way out when the hub was unreachable at launch (now Try again / Connect to a different hub).
- "Just happened" rendered an empty heading; camera snapshots that never arrive left a grey box.
- The Now people avatars and favourites "see all" had no destination; they open Security and Devices.
- The AC sent a command per tap of + / −; now one, after the taps stop (600 ms).
- Disconnect this phone was one tap; now it asks for a second.
- Icon-only buttons without labels, tiles' ⋯ unreachable by screen readers (now a "Controls" action).

## Left for later

The iOS widget and Live Activity (native Swift, need a store build), and an Automations entry in More,
which the automations change adds; More's "Your home" group has room for it.
