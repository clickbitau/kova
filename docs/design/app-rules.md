# Phone app design rules

How a screen in the phone app (`mobile/`) is put together, so new work looks like the rest of it. The tokens
live in `mobile/src/theme.ts`; the parts in `mobile/src/ui/kit.tsx`, `Screen.tsx`, `Tile.tsx` and `Text.tsx`.
Compose those parts; don't hand-build a button, a row or a card in a screen.

Check every screen at 320 and 390 pt wide, and with the system text size set larger (about 1.3×). Nothing may
be cut off, spill out of its card, or break a word in two.

## Type

- Every piece of text is `<T v="…">`, a step of the scale in `TYPE`. Don't set `size`/`weight` for a new kind of
  text; pick the nearest step. (A few big readings, like the climate dial or energy numbers, are the exception.)
- `largeTitle` is the screen's title (Screen does it), `heading` a section, `headline` a card or row title,
  `body`/`callout` reading text, `footnote` secondary lines, `label`/`labelSm` controls, `overline` captions above
  a group, `eyebrow` small capitals inside a card, `micro` badges and tab labels.
- Colour carries the hierarchy: `C.bone` titles, `C.bone2` values, `C.stone` secondary text, `C.stone2` captions.
  `C.stone3` is never text.
- Big display numbers may cap their growth with `maxFontSizeMultiplier` (1.15–1.3). Reading text never does.

## Spacing and layout

- The 4 pt grid: `SP`. Pages have an 18 pt gutter (`SP.gutter`) and 28 pt between sections (`SP.section`), both
  from `Screen`. Inside a card: 16 pt padding (`SP[4]`), 12 pt between parts (`SP[3]`).
- In any row with text beside something else, the text column is `flex: 1, minWidth: 0`, so it shrinks
  instead of pushing the rest off the screen. Fixed widths only for icons and wells.
- Decide for each line whether it wraps or truncates. Names and titles wrap (`numberOfLines` 2–3 at most);
  secondary detail truncates with an ellipsis. Never truncate the one thing a card is about.
- Rows of buttons or chips use `flexWrap: 'wrap'` with `flexGrow: 1` items, so on a small phone they wrap
  into even rows instead of overflowing. A segmented control holds at most four short choices; more go in
  `Chips`.
- Things that sit beside a title (header buttons, a tag) wrap under it when they don't fit.

## Cards

- `Card` is the one surface: `R.lg` corners, a hairline edge a touch lighter on top. Pass `pad` (16 pt) rather
  than leaving content touching the edge. `tint` washes it in a colour for an active or warning state.
- A list of things is a `Group` (one card, rows divided by hairlines) with an `overline` title above and an
  optional note below. Don't stack separate cards for each row.
- Device-like things are `Tile`s, two to a row.

## Notices and actions

- Anything raised for attention (an alert, a warning, a problem with a device) is a `Notice`: a tinted well
  with the icon, an `eyebrow` saying how urgent, the title, at most three lines of detail.
- Its actions are `NoticeAction`s in one row under it: the main one (Open) in the notice's colour, the others
  (Not now, That's expected) quieter. They share the width and wrap together.
- Level colours: red (`C.red`) needs you now, amber warns, blue is good to know, green is fine. Use them for
  the well, the eyebrow and a light wash; text stays bone and stone.
- A screen's main action is a `Button` (primary amber, one per view); secondary actions `kind="secondary"`;
  links in a section header use `Section action`. Buttons are at least 44 pt to touch (`Press` pads small ones).

## List rows

- `Row` (icon well, title, sub, chevron or a control on the right), `SwitchRow` (the whole row flips it) and
  `ExpandRow` (opens in place to show its choices). A long settings list folds each item into an ExpandRow,
  showing what's chosen as its sub line, rather than showing every control at once.
- Wells are 36 pt in rows, 38–40 in cards, 48–52 in a header.

## Sheets

- `Sheet` for anything that comes up over a screen: a `heading` (or `title` for a device) first, then the
  content in sections with `overline` captions, the main action at the bottom, full width.

## Empty and loading states

- Nothing yet: `Empty` (big, alone on a screen) or `Empty compact` (inside a section): an icon, what's missing
  in a few words, what to do, and the action that does it. Say what's true (no devices at all is different from
  no favourites).
- Loading: draw the screen's shape with `Skeleton`s, not a spinner. A `Spinner` is for a command on its way.
