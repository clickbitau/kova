// Asking for location the way Google Play requires (the "prominent disclosure" for location, background location
// in particular): Kova shows its own full-screen explanation, and the person taps Continue, before EVERY system
// location prompt, the foreground one and the upgrade to "all the time". Not now, and no system prompt is shown at
// all. Kept free of React Native so the tests can check the order under plain Node; native/arrive-leave.ts and
// the Settings screen run it with expo-location's calls.

/** Which prompt is next: the first one ("while using the app"), the upgrade to background ("all the time"), or a one-off. */
export type LocationStage = 'foreground' | 'background' | 'once';

export interface PermissionState { granted: boolean; canAskAgain?: boolean }

export interface LocationAsk {
  /** Read the permission without prompting. */
  getForeground(): Promise<PermissionState>;
  getBackground(): Promise<PermissionState>;
  /** The system prompts. */
  requestForeground(): Promise<PermissionState>;
  requestBackground(): Promise<PermissionState>;
  /** Kova's own full-screen disclosure for this stage. Resolves true for Continue, false for Not now. */
  disclose(stage: LocationStage): Promise<boolean>;
}

export type ConsentResult =
  | { ok: true }
  | { ok: false; reason: 'declined' | 'denied' | 'blocked'; stage: LocationStage; why: string };

/** Play's required wording for background location, word for word where it matters (see screens/LocationDisclosure.tsx). */
export const DISCLOSURE = {
  title: 'Use your location to know when you’re home?',
  /** The sentence Play asks for: what is collected, for which feature, and that it happens in the background. */
  lead: 'Kova collects location data to detect when you arrive and leave home, even when the app is closed or not in use.',
  points: [
    ['home', 'Only “home” or “away”', 'This phone checks whether it is inside a circle around your home. It sends your own Kova hub only “arrived” or “left”, never where you are.'],
    ['lock', 'Never to ClickBIT or anyone else', 'Your location isn’t sent to ClickBIT, advertisers or any other company, and it isn’t used for ads.'],
    ['toggle_on', 'Your choice', 'It’s off until you turn it on. Turn it off any time in More → This phone.'],
  ] as const,
  /** Shown with the upgrade to background ("all the time"). */
  background: {
    title: 'Allow location “all the time”',
    lead: 'Kova collects location data to detect when you arrive and leave home, even when the app is closed or not in use.',
    step: 'On the next screen, choose “Allow all the time” so Kova notices when you arrive or leave with the app closed. It still only tells your own hub “home” or “away”.',
  },
  /** The one-off use: setting where the home is (Settings). Foreground only, never in the background. */
  once: {
    title: 'Use this phone’s location once?',
    lead: 'Kova uses this phone’s location once, now, to save where your home is on your own hub, so sunrise, sunset and prayer times are right for it.',
    step: 'It isn’t used in the background or tracked. It goes to your own hub only, never to ClickBIT.',
  },
  cta: 'Continue',
  no: 'Not now',
} as const;

const blocked = (stage: LocationStage): ConsentResult => ({
  ok: false, reason: 'blocked', stage,
  why: stage === 'background' ? 'Location is set to “Only while using the app”. Choose “Allow all the time” for Kova in Settings to use arrive and leave.' : 'Location is off for Kova. Turn it on in Settings to use this.',
});

/**
 * Ask for location for `need`: 'background' (arrive and leave: the foreground prompt, then the upgrade) or 'once'
 * (foreground only). Each system prompt comes only after Kova's own disclosure for it, and only on Continue.
 * A permission already granted is not asked again (no prompt, so no disclosure); one the system won't ask for any
 * more is reported as `blocked`, with where to change it.
 */
export async function askLocation(need: 'background' | 'once', a: LocationAsk): Promise<ConsentResult> {
  const fgStage: LocationStage = need === 'once' ? 'once' : 'foreground';
  let fg = await a.getForeground();
  if (!fg.granted) {
    if (fg.canAskAgain === false) return blocked(fgStage);
    if (!(await a.disclose(fgStage))) return { ok: false, reason: 'declined', stage: fgStage, why: 'Kova won’t use your location.' };
    fg = await a.requestForeground();
    if (!fg.granted) return fg.canAskAgain === false ? blocked(fgStage) : { ok: false, reason: 'denied', stage: fgStage, why: 'Kova needs your location to know when you arrive and leave.' };
  }
  if (need === 'once') return { ok: true };
  const bg = await a.getBackground();
  if (bg.granted) return { ok: true };
  if (bg.canAskAgain === false) return blocked('background');
  if (!(await a.disclose('background'))) return { ok: false, reason: 'declined', stage: 'background', why: 'Kova won’t use your location in the background, so arrive and leave stays off.' };
  const got = await a.requestBackground();
  if (!got.granted) return got.canAskAgain === false ? blocked('background') : { ok: false, reason: 'denied', stage: 'background', why: 'Choose “Allow all the time” for Location in Settings, so Kova notices when the app is closed.' };
  return { ok: true };
}
