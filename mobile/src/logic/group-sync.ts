// A speaker group's timing (hub engine/group-sync.ts): how it plays (native groups in perfect sync, speakers played
// alongside), each part's offset (+ earlier, − later) and learned start delay, and the sync test. Free of React
// Native so the tests run it under plain Node. The hub checks everything again.
import type { Device, GroupPart, NativeGroup, SpeakerGroup } from '../api/types';

export const OFFSET_MIN = -1000;
export const OFFSET_MAX = 1000;
export const NUDGES = [-50, -10, -5, 5, 10, 50];

/** A nudge button's words: "50 later", "10 earlier". */
export const nudgeLabel = (n: number) => `${Math.abs(n)} ${n > 0 ? 'earlier' : 'later'}`;

/** An offset as the hub keeps it: 5 ms steps, −1000…+1000. */
export const snapOffset = (v: number) => Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, Math.round(v / 5) * 5)) || 0;

/** "+120 ms", "−40 ms", "0 ms". */
export const msWords = (ms: number) => `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${Math.abs(ms)} ms`;

/** An offset in words: "+120 ms · earlier", "0 ms · in step". */
export const offsetWords = (ms: number) => ms ? `${msWords(ms)} · ${ms > 0 ? 'earlier' : 'later'}` : '0 ms · in step';

export const viaName = (v: string) => ({ cast: 'Google Cast', sonos: 'Sonos', airplay: 'AirPlay', virtual: 'Demo' } as Record<string, string>)[v] ?? v;

/** A part's title: "Google Cast group “Home speakers”", "Sonos group", "Ray (Sonos)". */
export function partTitle(p: Pick<GroupPart, 'kind' | 'via' | 'name'>): string {
  if (p.kind === 'native') return p.via === 'cast' ? `Google Cast group “${p.name}”` : `${viaName(p.via)} group`;
  return `${p.name} (${viaName(p.via)})`;
}

/** How a part plays, in a line. */
export function partSub(p: Pick<GroupPart, 'kind' | 'reference' | 'members'>): string {
  if (p.kind === 'native') return `${p.members.length} speaker${p.members.length === 1 ? '' : 's'}, in perfect sync${p.reference ? ' · the others follow it' : ''}`;
  return p.reference ? 'The main speaker: the others follow it' : 'Played alongside';
}

/** The learned start delay, as the tuning screen reads it. */
export function delayWords(p: Pick<GroupPart, 'latencyMs' | 'latencyN'>): string {
  if (p.latencyMs == null) return 'Measured start delay: not yet. Kova learns it each time the group starts music.';
  return `Measured start delay: ${(p.latencyMs / 1000).toFixed(2)} s (from ${p.latencyN} play${p.latencyN === 1 ? '' : 's'})`;
}

/** "Right now: 40 ms ahead" while the group plays music; null when it isn't known. */
export function driftWords(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  if (Math.abs(ms) <= 20) return 'Right now: in time';
  return `Right now: ${Math.abs(ms)} ms ${ms > 0 ? 'ahead' : 'behind'}${Math.abs(ms) > 40 ? ' (lined up at the next song)' : ''}`;
}

/** How to tune by ear while music plays, for the first part played alongside. */
export function musicSteps(group: string, parts: Pick<GroupPart, 'reference' | 'name' | 'listenWith'>[]): string | null {
  const p = parts.find(x => !x.reference);
  if (!p) return null;
  const near = p.listenWith ?? 'one of the main speakers';
  return `Play a song on ${group}, then stand between ${near} and ${p.name}, where you hear both about as loud. If ${p.name} sounds behind, like an echo after the others, tap Earlier. If it’s ahead of them, tap Later. Each tap moves ${p.name} straight away, so you hear the change. Use 50 until it’s close, then 10, then 5.`;
}

/** What the tuning card says about what the group plays now. */
export function tuneState(playing: { media: string; live: boolean } | null | undefined, testMedia = 'Kova sync test'): { kind: 'none' | 'music' | 'radio' | 'ticks'; text: string } {
  if (!playing) return { kind: 'none', text: '' };
  if (playing.media === testMedia) return { kind: 'ticks', text: 'The tick test is playing.' };
  if (playing.live) return { kind: 'radio', text: `${playing.media} is a live stream: each speaker buffers it by itself, so it can’t be lined up exactly. Pick a song or playlist to tune with.` };
  return { kind: 'music', text: `Playing ${playing.media}. Listen, and nudge below until it sounds like one speaker.` };
}

/** The tick test, in plain words: what it plays, and what to listen for. */
export function testSteps(parts: Pick<GroupPart, 'reference' | 'name' | 'listenWith'>[]): string | null {
  const p = parts.find(x => !x.reference);
  if (!p) return null;
  return `If music is hard to judge, Kova can play a quiet tick once a second on every speaker, for up to 3 minutes. In time, you hear one clean tick. Out of time, you hear a double “tick-tick”: if ${p.name}’s tick comes second, tap Earlier; if first, Later. Afterwards every speaker goes back to what it was playing.`;
}

export const EXPECT = 'Speakers in a native group (a Google Home group, Sonos speakers together) are sample-locked. Speakers played alongside wait for the main group to start, then join it at its place (you may hear one settle in the first second or two), and at every song change Kova lines them up again: one that finishes its song first waits for the others (more than 400 ms out mid-song, it’s moved at once). Live radio gets the timing only: each speaker buffers it by itself, so it can sit up to a second or so apart.';

/** "3:05 left" for a running sync test; null when none runs. */
export function testLeft(until: number | null | undefined, now = Date.now()): string | null {
  if (!until || until <= now) return null;
  const s = Math.round((until - now) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
}

/** How a group plays, in a line: "“Home speakers” in perfect sync · Ray alongside". */
export function groupHow(g: Pick<SpeakerGroup, 'parts' | 'members'>): string {
  const ps = g.parts ?? [];
  if (ps.length < 2) return `${g.members.length} speakers as one stream, in perfect sync`;
  const along = ps.filter(p => !p.reference).map(p => p.name);
  const nat = ps.filter(p => p.kind === 'native').map(p => p.via === 'cast' ? `“${p.name}” in perfect sync` : `${viaName(p.via)} group in perfect sync`);
  return [...nat, ...(along.length ? [`${along.length > 2 ? `${along.length} speakers` : along.join(' and ')} alongside`] : [])].join(' · ') || 'Started together, kept in time';
}

/**
 * Speakers into native groups and lone speakers, with the fewest streams (the hub's partition): a dynamic native
 * group (Sonos) takes any two or more of its speakers; a fixed one (a Cast group) only when every member is here.
 */
export function groupParts(ids: string[], natives: NativeGroup[]): { native?: NativeGroup; ids: string[] }[] {
  const rest = new Set(ids);
  const out: { native?: NativeGroup; ids: string[] }[] = [];
  for (const n of natives.filter(x => x.dynamic)) {
    const m = ids.filter(id => rest.has(id) && n.members.includes(id));
    if (m.length < 2) continue;
    out.push({ native: n, ids: m });
    m.forEach(x => rest.delete(x));
  }
  const c = natives.filter(n => !n.dynamic && new Set(n.members).size >= 2 && n.members.every(m => rest.has(m))).map(n => ({ n, set: new Set(n.members) }))
    .sort((a, b) => b.set.size - a.set.size).slice(0, 24);
  let best = { pick: [] as number[], save: 0, cov: 0 };
  const walk = (i: number, used: Set<string>, pick: number[], save: number, cov: number): void => {
    if (save > best.save || (save === best.save && cov > best.cov)) best = { pick: [...pick], save, cov };
    for (let j = i; j < c.length; j++) {
      const g = c[j]!;
      if ([...g.set].some(m => used.has(m))) continue;
      g.set.forEach(m => used.add(m)); pick.push(j);
      walk(j + 1, used, pick, save + g.set.size - 1, cov + g.set.size);
      pick.pop(); g.set.forEach(m => used.delete(m));
    }
  };
  walk(0, new Set(), [], 0, 0);
  for (const j of best.pick) { out.push({ native: c[j]!.n, ids: ids.filter(id => c[j]!.set.has(id)) }); c[j]!.set.forEach(m => rest.delete(m)); }
  out.sort((a, b) => b.ids.length - a.ids.length);
  for (const id of ids) if (rest.has(id)) out.push({ ids: [id] });
  return out;
}

/**
 * How picked speakers will play, in words, for the group editor: one native group (perfect sync), a native group with
 * others alongside (said by name, honestly: close, not sample-locked), or each on its own, kept in time.
 */
export function draftSyncNote(picked: Pick<Device, 'id' | 'adapter' | 'name' | 'capabilities'>[], natives: NativeGroup[], combined: { deviceId: string; members: string[] }[] = [], all: Pick<Device, 'id' | 'capabilities'>[] = []): { icon: string; tone: 'muted' | 'green' | 'amber' | 'blue'; title: string; text: string } {
  if (picked.length < 2) return { icon: 'speaker_group', tone: 'muted', title: 'Pick at least two speakers', text: 'A group plays the same thing on all of them at once.' };
  const playerOf = (d: Pick<Device, 'id'>) => combined.find(c => c.deviceId === d.id)?.members.find(m => all.find(x => x.id === m)?.capabilities.includes('media')) ?? d.id;
  const byPlayer = new Map(picked.map(d => [playerOf(d), d]));
  const parts = groupParts([...byPlayer.keys()], natives);
  const nat = parts.filter(p => p.native), solo = parts.filter(p => !p.native);
  const natW = (p: { native?: NativeGroup; ids: string[] }) => p.native!.dynamic ? `${viaName(p.native!.via)} plays ${p.ids.length} speakers as one group` : `“${p.native!.name}” (a Google Cast group, ${p.ids.length} speakers)`;
  if (parts.length === 1 && nat.length) return { icon: 'graphic_eq', tone: 'green', title: 'Perfect sync', text: `${natW(nat[0]!)}: Kova plays through it, so they stay locked together.` };
  const names = solo.map(p => { const d = byPlayer.get(p.ids[0]!)!; return `${d.name} (${viaName(d.adapter)})`; });
  const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  if (nat.length) return { icon: 'sync', tone: 'blue', title: 'Native sync, plus speakers alongside', text: `${nat.map(natW).join(' and ')} play${nat.length === 1 ? 's' : ''} in perfect sync. ${list} ${solo.length === 1 ? 'plays' : 'play'} alongside: started at the same moment and kept in time by Kova, close but not sample-locked. Tune ${solo.length === 1 ? 'its' : 'their'} timing by ear, with music, once it’s saved.` };
  if (picked.every(d => d.adapter === 'cast')) return { icon: 'sync', tone: 'amber', title: 'Started together, kept in time', text: 'Each speaker plays its own stream; Kova starts them together and lines them up again if they drift. For perfect sync, make a group with exactly these speakers in the Google Home app: Kova finds it and uses it.' };
  return { icon: 'sync', tone: 'amber', title: 'Started together, kept in time', text: 'Each speaker plays its own stream (different brands can’t share one clock): Kova starts them together and lines them up again if they drift. Tune the timing by ear, with music, once it’s saved.' };
}
