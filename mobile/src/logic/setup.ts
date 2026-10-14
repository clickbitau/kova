// First run: what this phone knows about how its person writes dates, times and temperatures, offered to the new home
// in one tap. Free of React Native so the tests run it under plain Node.
import { phoneZone } from './settings.ts';

/** Countries that read temperatures in °F. */
const FAHRENHEIT = ['US', 'LR', 'MM'];

/** The region in a BCP-47 tag ("en-US" → "US"); when there's none ("en"), the likely one for the language. */
export function regionOf(tag: string): string | undefined {
  try { const r = new Intl.Locale(tag).maximize().region; if (r) return r; } catch { /* an engine without Intl.Locale */ }
  return /[-_]([A-Za-z]{2})\b/.exec(tag)?.[1]?.toUpperCase();
}

export interface PhoneSettings { locale: string; hour12: boolean; fahrenheit: boolean; timezone?: string }

/** The body for PUT /api/home that sets the home to this phone's language, clock, temperature unit and time zone. */
export function phoneSettings(): PhoneSettings {
  let locale = 'en-US', hour12 = false;
  try {
    const o = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
    locale = o.locale || locale;
    hour12 = o.hourCycle === 'h12' || o.hourCycle === 'h11' || o.hour12 === true;
  } catch { /* keep the defaults */ }
  const region = regionOf(locale);
  return { locale, hour12, fahrenheit: !!region && FAHRENHEIT.includes(region), ...(phoneZone() ? { timezone: phoneZone() } : {}) };
}

/** The phone's settings in a line, for the button that applies them: "English (United States) · 12-hour · °F · America/Chicago". */
export function phoneSettingsLine(p: PhoneSettings): string {
  let name = p.locale;
  try { name = new Intl.DisplayNames([p.locale], { type: 'language', languageDisplay: 'dialect' }).of(p.locale) ?? p.locale; } catch { /* keep the tag */ }
  return [name, p.hour12 ? '12-hour' : '24-hour', p.fahrenheit ? '°F' : '°C', p.timezone?.replace(/_/g, ' ')].filter(Boolean).join(' · ');
}
