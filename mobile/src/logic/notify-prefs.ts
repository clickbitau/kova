// What each person hears about, and how often (hub services/notify-prefs.ts). Free of React Native so the tests run
// it under plain Node. The hub checks every choice again.

export type NotifyPref = 'on' | 'off' | 1 | 6 | 24;
export interface NotifyKindView { id: string; label: string; help: string; icon: string; group: 'home' | 'network' | 'kova' }
export interface NotifyPrefsView {
  who: string | null; name: string;
  kinds: NotifyKindView[]; choices: { value: NotifyPref; label: string }[];
  prefs: Record<string, NotifyPref>;
  /** Kinds the household switched off for everyone (Integrations → Notifications). */
  offForAll: string[];
  /** The owner: the household's choices (phones of no one in particular, ntfy, anyone who hasn't chosen). */
  household?: Record<string, NotifyPref>; canHousehold: boolean;
}

export const GROUP_TITLE: Record<NotifyKindView['group'], string> = { home: 'The home', network: 'The network', kova: 'Kova itself' };

/** A choice in a few words, for a row's right side: "Every time", "Every 6 h at most", "Never". */
export function prefShort(v: NotifyPref | undefined): string {
  if (v === 'off') return 'Never';
  if (v === 1) return 'Hourly at most';
  if (v === 6) return 'Every 6 h at most';
  if (v === 24) return 'Daily at most';
  return 'Every time';
}

/** The kinds by group, in order, each with what it's set to and whether it's off for everyone. */
export function prefRows(v: NotifyPrefsView, household = false) {
  const set = household ? v.household ?? v.prefs : v.prefs;
  return (['home', 'network', 'kova'] as const).map(g => ({
    group: g, title: GROUP_TITLE[g],
    rows: v.kinds.filter(k => k.group === g).map(k => {
      const off = v.offForAll.includes(k.id);
      return { ...k, value: set[k.id] ?? 'on', short: off ? 'Off for everyone' : prefShort(set[k.id]), off };
    }),
  })).filter(g => g.rows.length);
}
