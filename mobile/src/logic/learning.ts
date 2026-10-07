import type { Finding, Learned, Snapshot } from '../api/types';

// What Kova learned from what people do (hub engine/learn.ts), for the cards that show it: Worth a look on Modes, an
// automation's own screen, and Settings → What Kova has learned. Pure, so it's tested without React.

/** The tag on a finding's card: the automation it's about, else the mode. */
export function findingTag(f: Finding, s: Pick<Snapshot, 'modes'> & { automations?: { id: string; name: string }[] }): { text: string; color: string | null } | null {
  const a = f.automationId ? s.automations?.find(x => x.id === f.automationId) : undefined;
  if (a) return { text: a.name, color: null };
  const m = s.modes.find(x => x.id === f.modeId);
  return m ? { text: m.name, color: m.color } : null;
}

/** The link that opens the days a suggestion is based on. */
export const evidenceLabel = (n: number, open: boolean) => open ? 'Hide the days' : `See the ${n} day${n === 1 ? '' : 's'}`;

/** The hub call for each button: apply, "Not now" (learned ones come back in a week; others are kept as they are), never. */
export function findingCall(f: Pick<Finding, 'id' | 'learned'>, what: 'fix' | 'alt' | 'never' | 'restore', id = f.id): string {
  const op = what === 'alt' ? (f.learned ? 'snooze' : 'dismiss') : what === 'never' ? 'dismiss' : what;
  return `/api/findings/${encodeURIComponent(id)}/${op}`;
}

/** What the toast says after each button. */
export function findingToast(f: Pick<Finding, 'id' | 'learned' | 'done'>, what: 'fix' | 'alt' | 'never' | 'restore', modeName?: string): string {
  if (what === 'alt') return f.learned ? 'Kova will ask again in a week' : 'Kept as is';
  if (what === 'never') return 'Kova won’t suggest that again';
  if (what === 'restore') return 'Suggested again';
  return f.done ?? (f.id.startsWith('learn:moment:') ? 'Added to your day' : `${modeName ?? 'Mode'} updated`);
}

/** The question the "Why?" button asks Ask Kova. */
export const whyQuestion = (f: Pick<Finding, 'title'>) => `Why do you suggest “${f.title.replace(/\?$/, '')}”?`;

/** Settings → What Kova has learned: each suggestion, where it stands, and what its button does. */
export function learnedRows(l: Learned | undefined, tz?: string): { id: string; title: string; status: string; tone: 'amber' | 'stone'; action: 'review' | 'restore'; automationId?: string }[] {
  return (l?.items ?? []).map(it => {
    const until = it.status === 'later' && it.until ? new Date(it.until).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', ...(tz ? { timeZone: tz } : {}) }).replace(',', '') : '';
    return {
      id: it.id, title: it.title, automationId: it.automationId,
      status: it.status === 'never' ? 'You said not to suggest it' : it.status === 'later' ? `Put off until ${until}` : 'Waiting in Worth a look',
      tone: it.status === 'new' ? 'amber' : 'stone',
      action: it.status === 'new' ? 'review' : 'restore',
    };
  });
}
