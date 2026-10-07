// The Media screen: players, speaker groups, sources and Helix music, as the web app does them (web/index.html).
// Free of React Native so the tests run it under plain Node.
import type { Command, MediaSource, SpeakerGroup } from '../api/types';
import { has, isPlayer, type Dev } from './devices.ts';

/** Speakers, TVs and speaker groups, by name, groups last. */
export function playersOf(all: Record<string, Dev>, groups: Pick<SpeakerGroup, 'deviceId'>[]): { players: Dev[]; groups: Dev[] } {
  const gids = new Set(groups.map(g => g.deviceId));
  const list = Object.values(all).filter(d => isPlayer(d) && !d.hidden && !d.archived || gids.has(d.id));
  const byName = (a: Dev, b: Dev) => a.name.localeCompare(b.name);
  return { players: list.filter(d => !gids.has(d.id)).sort(byName), groups: list.filter(d => gids.has(d.id)).sort(byName) };
}

/** The player the screen is about: the one picked, else the first one playing, else the first. */
export function pickPlayer(list: Dev[], sel?: string | null): Dev | undefined {
  return list.find(d => d.id === sel) ?? list.find(d => d.on && has(d, 'media')) ?? list.find(d => d.on) ?? list[0];
}

export const playingCount = (list: Dev[]) => list.filter(d => d.on && !d.paused).length;

/** What's on a player, for the now-playing card. */
export function nowPlaying(P: Dev, room: string): { title: string; sub: string; art: string | null; queue: boolean; playing: boolean; canPause: boolean } {
  const T = P.on ? P.track : null;
  const queue = has(P, 'queue') && !!T;
  const playing = !!P.on && !P.paused;
  if (T) return { title: T.title, sub: [T.artist, P.media].filter(Boolean).join(' · ') + (P.shuffle ? ' · shuffled' : ''), art: T.art ?? null, queue, playing, canPause: has(P, 'pause') };
  const what = !P.on ? 'Nothing playing' : P.paused ? `Paused${P.media ? ` · ${P.media}` : ''}` : P.media ? P.media : 'On';
  return { title: P.name, sub: [room, what].filter(Boolean).join(' · '), art: null, queue, playing, canPause: has(P, 'pause') };
}

/** Play or pause: pause when it can, else start the first source or stop. */
export function playPause(P: Dev, sources: { name: string }[]): { cmd: Command; done?: string } {
  if (P.on && has(P, 'pause')) return { cmd: { paused: !P.paused } };
  if (P.on) return { cmd: { on: false, media: null }, done: `${P.name} stopped` };
  if (!has(P, 'media')) return { cmd: { on: true } };
  const media = P.media || sources[0]?.name || 'Radio';
  return { cmd: { on: true, media, vol: P.vol ?? 30 }, done: `Playing ${media} on ${P.name}` };
}

export const STOP: Command = { on: false, media: null };

/** The speakers in a group, each in or out of what's playing (a speaker that's on is in). */
export function groupMembers(g: Pick<SpeakerGroup, 'members'> | undefined, all: Record<string, Dev>): { d: Dev; in: boolean }[] {
  return (g?.members ?? []).map(id => all[id]).filter((d): d is Dev => !!d).map(d => ({ d, in: !!d.on }));
}

/**
 * Taking a speaker out of a playing group stops it; putting it back plays what the group plays (at its own volume).
 * Nothing to join while the group plays nothing.
 */
export function memberToggle(m: Dev, P: Dev): { cmd: Command; done: string } | { error: string } {
  if (m.on) return { cmd: { on: false, media: null }, done: `${m.name} left ${P.name}` };
  if (!P.on || !P.media) return { error: `Play something on ${P.name} first` };
  return { cmd: { on: true, media: P.media, shuffle: !!P.shuffle, vol: m.vol ?? 30 }, done: `${m.name} joined ${P.name}` };
}

/** Helix music on a player: only speakers that play a queue (Google Cast, Sonos, AirPlay, and their groups). */
export function musicCommand(P: Dev | undefined, item: { name: string; kind: 'all' | 'loved' | 'playlist' }, shuffle: boolean): { cmd: Command; done: string } | { error: string } {
  if (!P) return { error: 'Pick a speaker first' };
  if (!has(P, 'queue')) return { error: `${P.name} can’t play Helix music (Google Cast, Sonos and AirPlay speakers can)` };
  const sh = item.kind === 'all' || shuffle;
  return { cmd: { on: true, media: item.name, shuffle: sh }, done: `Playing ${item.name}${sh && item.kind !== 'all' ? ' on shuffle' : ''} on ${P.name}` };
}

/** A station from an artist, album or song, always shuffled. */
export function stationCommand(P: Dev | undefined, words: string): { cmd: Command; done: string } | { error: string } | null {
  const w = words.trim();
  if (!w) return null;
  const r = musicCommand(P, { name: `Station: ${w}`, kind: 'playlist' }, true);
  return 'error' in r ? r : { cmd: r.cmd, done: `Playing a station from ${w} on ${P!.name}` };
}

/** A source on a player, at the player's volume. */
export function sourceCommand(P: Dev, s: Pick<MediaSource, 'name'>): { cmd: Command; done: string } {
  return { cmd: { on: true, media: s.name, vol: P.vol ?? 30 }, done: `Playing ${s.name} on ${P.name}` };
}

/** The address speakers stream a source from: http(s), or empty to clear it. */
export function streamUrlError(url: string): string | null {
  const u = url.trim();
  return !u || /^https?:\/\/\S+$/.test(u) ? null : 'Use an http(s) stream address';
}

/** The line under a source: where it streams from and whether it repeats. */
export function sourceSub(s: MediaSource): { text: string; missing: boolean } {
  if (!s.url) return { text: 'No stream address yet', missing: true };
  let host = s.url;
  try { host = new URL(s.url).host || s.url; } catch { /* keep it as typed */ }
  return { text: `${s.loop ? 'Repeats' : 'Plays once'} · ${host}`, missing: false };
}

/** The toast after the Repeats / Plays once switch. */
export const loopDone = (s: Pick<MediaSource, 'name'>, loop: boolean) => loop ? `${s.name} repeats until you stop it` : `${s.name} plays once`;
