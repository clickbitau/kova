import { mediaWords } from '../engine/announce.ts';

// Careful automation edits for Ask Kova, whichever AI runs it. A model that changes one volume by rewriting a whole
// step loses what it didn't copy (the owner's recording, a speaker, a per-speaker level); here it says only the change
// ("then.0.vol": 30), the hub keeps the rest, and the hub — not the model — says what changed, so a slip shows.

/** An automation as the model writes it: when (triggers), if (conditions), then (actions). */
export interface AutoDef { when: unknown[]; if: unknown[]; then: unknown[] }

const seg = (path: string): (string | number)[] => path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).map(s => /^\d+$/.test(s) ? Number(s) : s);

/**
 * Apply edits — path → new value — to a copy of an automation. Paths are dots through when/if/then
 * ("then.0.vol", "then.0.targets.soundbar.vol", "when.2"); a number is a place in a list; null removes the entry; a
 * place one past the end of a list adds to it. Throws, in words a model can act on, on a path that isn't there.
 */
export function applyEdits(def: AutoDef, edits: Record<string, unknown>): AutoDef {
  const out = JSON.parse(JSON.stringify(def)) as AutoDef;
  for (const [path, value] of Object.entries(edits)) {
    const parts = seg(path);
    if (!['when', 'if', 'then'].includes(String(parts[0]))) throw new Error(`Edit “${path}”: a path starts with when, if or then (e.g. "then.0.vol")`);
    if (parts.length < 2) throw new Error(`Edit “${path}”: say which entry, e.g. "${parts[0]}.0" — to replace the whole list, send ${parts[0]} itself`);
    let node: unknown = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]!;
      const next = (node as Record<string | number, unknown>)[k];
      if (next === undefined || next === null) {
        if (Array.isArray(node)) throw new Error(`Edit “${path}”: ${parts.slice(0, i).join('.')} has ${node.length} entr${node.length === 1 ? 'y' : 'ies'}${node.length ? ` (0–${node.length - 1})` : ''}`);
        if (i < 1) throw new Error(`Edit “${path}”: there’s no ${parts.slice(0, i + 1).join('.')} in this automation`);
        (node as Record<string | number, unknown>)[k] = typeof parts[i + 1] === 'number' ? [] : {};
      } else if (typeof next !== 'object') throw new Error(`Edit “${path}”: ${parts.slice(0, i + 1).join('.')} is a value, not something with parts`);
      node = (node as Record<string | number, unknown>)[k];
    }
    const last = parts[parts.length - 1]!;
    if (Array.isArray(node)) {
      if (typeof last !== 'number') throw new Error(`Edit “${path}”: ${parts.slice(0, -1).join('.')} is a list — use a number for the place in it`);
      if (last > node.length) throw new Error(`Edit “${path}”: ${parts.slice(0, -1).join('.')} has ${node.length} entr${node.length === 1 ? 'y' : 'ies'} (0–${node.length - 1}); ${node.length} adds one`);
      if (value === null) { if (last < node.length) node.splice(last, 1); } else node[last] = value;
    } else {
      const o = node as Record<string, unknown>;
      if (value === null) delete o[String(last)]; else o[String(last)] = value;
    }
  }
  return out;
}

/** One difference between two versions, by path. */
export interface Change { path: string; was: unknown; now: unknown }

/** Every leaf that differs between two versions of an automation (an added or removed entry is one change). */
export function changesBetween(a: unknown, b: unknown, path = ''): Change[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const obj = (v: unknown) => v !== null && typeof v === 'object';
  if (!obj(a) || !obj(b) || Array.isArray(a) !== Array.isArray(b)) return [{ path, was: a, now: b }];
  const keys = Array.isArray(a) ? [...Array(Math.max(a.length, (b as unknown[]).length)).keys()] : [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
  return keys.flatMap(k => changesBetween((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : String(k)));
}

const short = (v: unknown): string => {
  if (v === undefined) return 'nothing';
  const s = typeof v === 'string' ? `“${v}”` : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
};

/**
 * What changed, in the owner's words: "Volume 20% → 30%", "Speakers: Kitchen added, Whole home removed",
 * "Audio: Adhan (feat. …) → The Adhan – Aaqib Azeez". Steps are counted from 1, as the app shows them.
 */
export function changeWords(before: AutoDef, after: AutoDef, o: { name: (id: string) => string; clipName?: (id: string) => string | undefined; when: (t: unknown) => string; if: (c: unknown) => string }): string[] {
  const out: string[] = [];
  for (const part of ['when', 'if'] as const) {
    const w = (xs: unknown[]) => xs.map(x => o[part](x));
    const was = w(before[part]), now = w(after[part]);
    const gone = was.filter(x => !now.includes(x)), added = now.filter(x => !was.includes(x));
    const label = part === 'when' ? 'Starts' : 'Only if';
    const lc = (x: string) => x[0]!.toLowerCase() + x.slice(1);
    if (gone.length === 1 && added.length === 1) out.push(`${label === 'Starts' ? 'Starts' : 'Only if'} ${lc(added[0]!)} instead of ${lc(gone[0]!)}`);
    else if (gone.length || added.length) out.push(`${label}: ${[...added.map(x => `${x} added`), ...gone.map(x => `${x} removed`)].join(', ')}`);
  }
  const n = Math.max(before.then.length, after.then.length);
  const many = n > 1;
  for (let i = 0; i < n; i++) {
    const a = before.then[i] as Record<string, unknown> | undefined, b = after.then[i] as Record<string, unknown> | undefined;
    const step = many ? `Step ${i + 1} ` : '';
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (!a || !b || a.kind !== b.kind) { out.push(`${step || 'A step '}${!a ? 'added' : !b ? 'removed' : 'replaced'}`.trim()); continue; }
    const cs = changesBetween(a, b);
    const said = new Set<string>();
    const media = (m: unknown) => mediaWords(typeof m === 'string' ? m : undefined, o.clipName);
    if (cs.some(c => c.path === 'media')) { out.push(`${step}audio: ${media(a.media)} → ${media(b.media)}`); said.add('media'); }
    if (cs.some(c => c.path.startsWith('mediaFor'))) {
      const fa = (a.mediaFor as Record<string, string> | undefined)?.fajr, fb = (b.mediaFor as Record<string, string> | undefined)?.fajr;
      out.push(`${step}Fajr audio: ${fa ? media(fa) : 'the same as the rest'} → ${fb ? media(fb) : 'the same as the rest'}`);
      said.add('mediaFor');
    }
    if (cs.some(c => c.path === 'vol')) { out.push(`${step}volume ${a.vol ?? '—'}% → ${b.vol ?? '—'}%`); said.add('vol'); }
    const ta = (a.targets ?? {}) as Record<string, Record<string, unknown>>, tb = (b.targets ?? {}) as Record<string, Record<string, unknown>>;
    if (cs.some(c => c.path.startsWith('targets'))) {
      const added = Object.keys(tb).filter(k => !(k in ta)), gone = Object.keys(ta).filter(k => !(k in tb));
      const bits = [...added.map(k => `${o.name(k)} added`), ...gone.map(k => `${o.name(k)} removed`)];
      for (const k of Object.keys(tb).filter(k => k in ta)) {
        for (const c of changesBetween(ta[k], tb[k])) bits.push(c.path === 'vol' ? `${o.name(k)}’s volume ${c.was ?? '—'}${c.was == null ? '' : '%'} → ${c.now ?? 'the step’s'}${c.now == null ? '' : '%'}` : `${o.name(k)}’s ${c.path || 'setting'} ${short(c.was)} → ${short(c.now)}`);
      }
      const label = b.kind === 'announce' ? 'speakers' : 'devices';
      if (bits.length) out.push(`${step}${label}: ${bits.join(', ')}`);
      said.add('targets');
    }
    if (cs.some(c => c.path.startsWith('pause'))) {
      const pa = (a.pause ?? []) as string[], pb = (b.pause ?? []) as string[];
      out.push(`${step}paused for it: ${pa.length ? pa.map(o.name).join(', ') : 'nothing'} → ${pb.length ? pb.map(o.name).join(', ') : 'nothing'}`);
      said.add('pause');
    }
    for (const c of cs) {
      const top = c.path.split('.')[0]!;
      if (said.has(top)) continue;
      out.push(`${step}${c.path}: ${short(c.was)} → ${short(c.now)}`);
    }
  }
  return out.map(s => s[0]!.toUpperCase() + s.slice(1));
}

/** Words for what an announcement plays. */
const AUDIO = '(audio|recording|adhan|azan|athan|sound|song|track|clip|voice|reciter|muezzin|chime|file|link|url|station)';
/** Asking for other audio without naming it: "use another recording", "a different adhan", "replace the sound". */
const AUDIO_CHANGE = new RegExp(`\\b(different|another|other|new|swap|replace)\\b[^.?!\\n]{0,20}\\b${AUDIO}|\\b${AUDIO}\\b[^.?!\\n]{0,15}\\binstead\\b`, 'i');
/** Words too common in names to say which one is meant. */
const GENERIC = new Set(['speaker', 'speakers', 'room', 'display', 'home', 'whole', 'the', 'and', 'audio', 'adhan', 'feat', 'song', 'with', 'from', 'call', 'prayer', 'hub', 'mini', 'nest', 'google']);
/** Does the owner's text name this (a word of the name, not a generic one)? */
export const mentions = (said: string, name: string): boolean => {
  const words = new Set(said.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  return name.toLowerCase().split(/[^\p{L}\p{N}]+/u).some(w => w.length >= 3 && !GENERIC.has(w) && words.has(w));
};
/** Narrowing what something plays on: "only on the kitchen", "just the bedroom", "not the soundbar", "remove …". */
const NARROW = /\b(only|just|remove|without|not on|not in|not the|exclude|drop|take (it )?(off|out)|no longer|leave out|skip)\b/i;

/**
 * Changes the owner's words don't account for: the audio swapped, or speakers taken out, when nothing in what they
 * said (this message and the turns just before it) asks for that. Each is a sentence the model is sent back.
 */
export function unasked(before: AutoDef, after: AutoDef, said: string, name: (id: string) => string, mediaName: (m: string) => string = m => mediaWords(m)): string[] {
  const out: string[] = [];
  for (let i = 0; i < before.then.length; i++) {
    const a = before.then[i] as Record<string, unknown> | undefined;
    if (!a || a.kind !== 'announce' && a.kind !== 'set') continue;
    // The same step after the change: at its place, or the only one of its kind.
    const same = after.then.filter(x => (x as Record<string, unknown>)?.kind === a.kind) as Record<string, unknown>[];
    const b = ((after.then[i] as Record<string, unknown> | undefined)?.kind === a.kind ? after.then[i] : same.length === 1 ? same[0] : undefined) as Record<string, unknown> | undefined;
    if (!b) continue;
    if (a.kind === 'announce' && a.media) {
      const fa = (a.mediaFor ?? {}) as Record<string, string>, fb = (b.mediaFor ?? {}) as Record<string, string>;
      const swapped = [b.media !== a.media ? String(b.media ?? '') : null, ...Object.keys({ ...fa, ...fb }).filter(k => fa[k] !== fb[k]).map(k => fb[k] ?? '')].filter((x): x is string => x !== null);
      // Asked for: in so many words, or by naming the new audio ("the Azeez one").
      const asked = AUDIO_CHANGE.test(said) || swapped.every(m => m && mentions(said, mediaName(m)));
      if (swapped.length && !asked) out.push(`The owner didn’t ask to change what it plays (it plays ${mediaName(String(a.media))}${fa.fajr ? `, and ${mediaName(fa.fajr)} at Fajr` : ''}): keep media and mediaFor exactly as they are.`);
    }
    const ta = Object.keys((a.targets ?? {}) as object), tb = new Set(Object.keys((b.targets ?? {}) as object));
    const gone = ta.filter(k => !tb.has(k));
    const named = (k: string) => mentions(said, name(k));
    // Asked for: each one named, or "only/just/not …" naming what's meant.
    if (gone.length && !gone.every(named) && !(NARROW.test(said) && [...tb, ...gone].some(named))) {
      out.push(`The owner didn’t ask to take ${gone.map(name).join(', ')} out of it: keep every ${a.kind === 'announce' ? 'speaker' : 'device'} it already has.`);
    }
  }
  return out;
}

/** "no", "nope", "don't", "leave it": the owner turning down what was offered. */
export const DECLINED = /^\s*(no|nope|nah|no thanks|no thank you|don[’']?t|do not|not now|leave it|never ?mind|cancel|stop)\s*[.!]*\s*$/i;
