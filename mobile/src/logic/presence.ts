// Whether this phone's location is needed for Kova to know its person is home. Plain TypeScript, tested under Node.
//
// The hub says what already tells it, per person (`people[].via`: e.g. ['Warden'], ['your router'],
// ['a network check']). When something does, location is an optional extra (it notices leaving a little
// sooner); when nothing does (or an older hub doesn't say), location is how Kova knows.

export interface LocationPlan {
  /** Location is the way this person's coming and going is known. */
  needed: boolean;
  /** What already tells Kova, joined for a sentence ("Warden and your router"), when something does. */
  by: string | null;
  /** The line to show. */
  text: string;
}

/** "Warden", "Warden and your router", "Warden, your router and a network check". */
export function joinNames(names: string[]): string {
  const n = names.filter(Boolean);
  if (n.length <= 1) return n[0] ?? '';
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;

/**
 * The plan for a person (or nobody chosen yet). `you` reads it to the phone's owner ("when you're home");
 * otherwise it's by name.
 */
export function locationPlan(person: { name: string; via?: string[] } | null | undefined, you = true): LocationPlan {
  const via = (person?.via ?? []).filter(v => typeof v === 'string' && v.trim());
  if (!person || !via.length) {
    return { needed: true, by: null, text: person ? `This phone’s location tells Kova when ${you ? 'you get' : `${person.name} gets`} home or go${you ? '' : 'es'} out, even with the app closed.` : 'Choose whose phone this is first.' };
  }
  const by = joinNames(via);
  const verb = via.length === 1 ? 'tells' : 'tell';
  return { needed: false, by, text: `${cap(by)} already ${verb} Kova when ${you ? 'you’re' : `${person.name}’s`} home. Location isn’t needed.` };
}
