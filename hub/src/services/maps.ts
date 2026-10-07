import { randomUUID } from 'node:crypto';
import { parseLocationText, recoverPlusCode, resolveShortLink, type Parsed, type Point, type ResolveOptions } from './location-parse.ts';
import { TZ_PLACES } from '../util/tz-places.ts';
import type { HomeConfig, HomeLocation } from '../model/types.ts';

// Finding the home on a map, through the hub so no API key ever reaches a browser or phone.
//
// Places come from providers, tried in order:
// - Google with the owner's own key (entered in Settings → Home, or GOOGLE_MAPS_API_KEY): Places Autocomplete
//   (New) and Place Details, the Geocoding API as a fallback, and Static Maps for the confirm map;
// - ClickBIT's location proxy (KOVA_LOCATION_PROXY_URL), Google behind ClickBIT's own key, signed in with this
//   hub's licence. It doesn't exist yet: the client is here so a hub only needs the URL when it does;
// - OpenStreetMap's Nominatim, always last, needing no key (its policy: an identifying User-Agent, at most one
//   request a second, no autocomplete-as-you-type).
//
// Google's terms shape what happens with its answers:
// - a search shows Google's matches as text only; coordinates come from Place Details once one is picked;
// - Google's points are only ever drawn on Google's own map (Static Maps through the hub), never on the
//   OpenStreetMap one. Moving the pin makes the point the owner's own (source "map"), with Google's id dropped;
// - Google's coordinates are kept at most 30 days: the home keeps the place id (allowed indefinitely) and the hub
//   asks Place Details again when they're older (refresh()).
// What someone pastes (a link's coordinates, typed coordinates, a Plus Code) and a phone's location are theirs.

export type Provider = 'google' | 'osm';
export interface Found { label: string; latitude?: number; longitude?: number; placeId?: string; provider: Provider }
export interface Detail { label: string; latitude: number; longitude: number; placeId: string; provider: 'google' }
export interface Located { latitude: number; longitude: number; label?: string; address?: string; via: string; provider?: Provider; placeId?: string }
export interface StaticMapRequest extends Point { radiusM?: number; width: number; height: number; zoom?: number }
export type SearchVia = 'google-places' | 'google-geocoding' | 'clickbit' | 'osm';

/** One source of places. A Google provider's answers carry Google's terms (see above). */
export interface PlaceProvider {
  readonly id: 'google-key' | 'clickbit' | 'osm';
  readonly google: boolean;
  /** Matches, or null when this provider can't answer now (the next one is tried). */
  search(q: string, o: { lang: string; near: Point | null; session: string }): Promise<{ results: Found[]; via: SearchVia } | null>;
  details?(placeId: string, o: { lang: string; session?: string }): Promise<Detail>;
  staticMap?(r: StaticMapRequest): Promise<{ type: string; body: Buffer }>;
  timezone?(p: Point): Promise<string | null>;
  lastError(): string | null;
}

interface KV { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }
export interface MapsOptions {
  store: KV;
  /** Where the home is now: searches prefer matches near it, and a short Plus Code is made full from it. */
  near: () => Point | null;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** OpenStreetMap asks for at most one request a second. */
  nominatimGapMs?: number;
  resolve?: Omit<ResolveOptions, 'fetch'>;
  now?: () => number;
}

const UA = 'Kova smart home hub (https://github.com/clickbitau/kova)';
const STORE_KEY = 'maps';
const DAY = 86_400_000;
/** Google's terms: its coordinates may be kept 30 days. Refreshed a little before. */
export const GOOGLE_KEEP_MS = 29 * DAY;
/** What a Google API key looks like (Google's start "AIza"; others are allowed, but nothing with spaces or quotes). */
export const KEY_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;
export const PLACE_ID = /^[A-Za-z0-9_-]{10,400}$/;
const SESSION = /^[A-Za-z0-9-]{8,64}$/;

export class MapsError extends Error {
  constructor(message: string, readonly code = 400) { super(message); }
}

type Fetch = typeof fetch;
const errText = async (res: Response) => {
  const j = await res.json().catch(() => ({})) as { error?: { message?: string }; error_message?: string; status?: string };
  return j.error?.message ?? j.error_message ?? `HTTP ${res.status}`;
};

/** A circle as a polygon, for Static Maps' path (it has no circles). */
export function circlePath(p: Point, radiusM: number, steps = 36): string {
  const out: string[] = [], rad = Math.PI / 180, dLat = radiusM / 111_320;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    out.push(`${(p.latitude + dLat * Math.sin(a)).toFixed(6)},${(p.longitude + dLat * Math.cos(a) / Math.cos(p.latitude * rad)).toFixed(6)}`);
  }
  return out.join('|');
}

/** A zoom that fits the circle in the picture. */
export const zoomFor = (p: Point, radiusM: number, px: number) => {
  const mPerPx = (radiusM * 2.6) / px;
  return Math.max(3, Math.min(19, Math.floor(Math.log2((156_543.03 * Math.cos(p.latitude * Math.PI / 180)) / mPerPx))));
};

// ---------------------------------------------------- Google, owner's key --
export class GoogleKeyProvider implements PlaceProvider {
  readonly id = 'google-key' as const;
  readonly google = true;
  private err: string | null = null;
  constructor(private key: string, private f: Fetch) {}
  lastError() { return this.err; }

  async search(q: string, o: { lang: string; near: Point | null; session: string }) {
    try {
      const body = { input: q, sessionToken: o.session, languageCode: o.lang, ...(o.near ? { locationBias: { circle: { center: o.near, radius: 50_000 } } } : {}) };
      const res = await this.f('https://places.googleapis.com/v1/places:autocomplete', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': this.key }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const j = await res.json() as { suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string } } }[] };
        this.err = null;
        return { via: 'google-places' as const, results: (j.suggestions ?? []).map(s => s.placePrediction).filter(p => p?.placeId && p.text?.text).slice(0, 6).map(p => ({ label: p!.text!.text!, placeId: p!.placeId!, provider: 'google' as const })) };
      }
      this.err = `Places API: ${await errText(res)}`;
    } catch { /* the Geocoding API below */ }
    // Places not enabled for the key: the Geocoding API's matches, as text and an id too.
    try {
      const params: Record<string, string> = { address: q, key: this.key, language: o.lang };
      if (o.near) params.bounds = `${o.near.latitude - 3},${o.near.longitude - 3}|${o.near.latitude + 3},${o.near.longitude + 3}`;
      const res = await this.f(`https://maps.googleapis.com/maps/api/geocode/json?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(10_000) });
      const j = await res.json().catch(() => ({})) as { status?: string; error_message?: string; results?: { formatted_address?: string; place_id?: string }[] };
      if (!res.ok || (j.status !== 'OK' && j.status !== 'ZERO_RESULTS')) { this.err = `${this.err ? `${this.err}; ` : ''}Geocoding API: ${j.error_message ?? j.status ?? `HTTP ${res.status}`}`; return null; }
      return { via: 'google-geocoding' as const, results: (j.results ?? []).filter(r => r.formatted_address && r.place_id).slice(0, 6).map(r => ({ label: r.formatted_address!, placeId: r.place_id!, provider: 'google' as const })) };
    } catch { return null; }
  }

  async details(placeId: string, o: { lang: string; session?: string }): Promise<Detail> {
    const qs = new URLSearchParams({ languageCode: o.lang, ...(o.session && SESSION.test(o.session) ? { sessionToken: o.session } : {}) });
    let why = '';
    try {
      const res = await this.f(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?${qs}`, { headers: { 'X-Goog-Api-Key': this.key, 'X-Goog-FieldMask': 'id,formattedAddress,location,displayName' }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const j = await res.json() as { formattedAddress?: string; displayName?: { text?: string }; location?: { latitude?: number; longitude?: number } };
        const lat = Number(j.location?.latitude), lon = Number(j.location?.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lon)) { this.err = null; return { label: j.formattedAddress ?? j.displayName?.text ?? '', latitude: lat, longitude: lon, placeId, provider: 'google' }; }
      } else why = `Places API: ${await errText(res)}`;
    } catch { why = 'Places API didn’t answer'; }
    // The Geocoding API looks up the same place ids.
    try {
      const res = await this.f(`https://maps.googleapis.com/maps/api/geocode/json?${new URLSearchParams({ place_id: placeId, key: this.key, language: o.lang })}`, { signal: AbortSignal.timeout(10_000) });
      const j = await res.json().catch(() => ({})) as { status?: string; error_message?: string; results?: { formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }[] };
      const r = j.results?.[0], lat = Number(r?.geometry?.location?.lat), lon = Number(r?.geometry?.location?.lng);
      if (j.status === 'OK' && Number.isFinite(lat) && Number.isFinite(lon)) return { label: r!.formatted_address ?? '', latitude: lat, longitude: lon, placeId, provider: 'google' };
      why = `${why ? `${why}; ` : ''}Geocoding API: ${j.error_message ?? j.status ?? `HTTP ${res.status}`}`;
    } catch { why ||= 'Google didn’t answer'; }
    this.err = why;
    throw new MapsError(`Google couldn’t look that place up (${why})`, 502);
  }

  async staticMap(r: StaticMapRequest) {
    const params = new URLSearchParams({ center: `${r.latitude},${r.longitude}`, zoom: String(r.zoom ?? zoomFor(r, r.radiusM ?? 150, Math.min(r.width, r.height))), size: `${r.width}x${r.height}`, scale: '2', maptype: 'roadmap', markers: `color:0xf2b14c|${r.latitude},${r.longitude}`, key: this.key });
    if (r.radiusM) params.append('path', `color:0xf2b14cff|weight:2|fillcolor:0xf2b14c33|${circlePath(r, r.radiusM)}`);
    const res = await this.f(`https://maps.googleapis.com/maps/api/staticmap?${params}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) { const why = res.ok ? 'not a picture' : (await res.text().catch(() => '')).slice(0, 200) || `HTTP ${res.status}`; this.err = `Maps Static API: ${why}`; throw new MapsError(`Google’s map didn’t load (${why})`, 502); }
    return { type: res.headers.get('content-type')!, body: Buffer.from(await res.arrayBuffer()) };
  }

  async timezone(p: Point) {
    try {
      const res = await this.f(`https://maps.googleapis.com/maps/api/timezone/json?${new URLSearchParams({ location: `${p.latitude},${p.longitude}`, timestamp: String(Math.floor(Date.now() / 1000)), key: this.key })}`, { signal: AbortSignal.timeout(5_000) });
      const j = await res.json() as { status?: string; timeZoneId?: string };
      return j.status === 'OK' && j.timeZoneId && validZone(j.timeZoneId) ? j.timeZoneId : null;
    } catch { return null; }
  }
}

// ------------------------------------------------------- ClickBIT's proxy --
/**
 * ClickBIT's location proxy: Google behind ClickBIT's key, for hubs with a licence and no key of their own. Not
 * running yet; this is the hub's side of it, used only when KOVA_LOCATION_PROXY_URL is set. Bearer is the hub's
 * licence device token (the one the release catalog issues).
 *   POST {url}/v1/location/search {q, lang, near, session} → {results: [{label, placeId}], via?}
 *   GET  {url}/v1/location/place/{placeId}?lang&session    → {label, latitude, longitude}
 *   GET  {url}/v1/location/static?lat&lon&radius&w&h&zoom   → image/png
 *   GET  {url}/v1/location/timezone?lat&lon                 → {timezone}
 */
export class ClickbitProxyProvider implements PlaceProvider {
  readonly id = 'clickbit' as const;
  readonly google = true;
  private err: string | null = null;
  constructor(private url: string, private token: () => Promise<string>, private f: Fetch) {}
  lastError() { return this.err; }
  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const t = await this.token().catch(() => '');
    if (!t) { this.err = 'No licence: ClickBIT’s location service needs one'; throw new MapsError(this.err, 502); }
    const res = await this.f(`${this.url.replace(/\/+$/, '')}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) { this.err = `ClickBIT location service: ${await errText(res)}`; throw new MapsError(this.err, 502); }
    this.err = null;
    return res;
  }
  async search(q: string, o: { lang: string; near: Point | null; session: string }) {
    try {
      const j = await (await this.call('/v1/location/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q, lang: o.lang, near: o.near, session: o.session }) })).json() as { results?: { label?: string; placeId?: string }[] };
      return { via: 'clickbit' as const, results: (j.results ?? []).filter(r => r.label && r.placeId && PLACE_ID.test(r.placeId)).slice(0, 6).map(r => ({ label: r.label!, placeId: r.placeId!, provider: 'google' as const })) };
    } catch { return null; }
  }
  async details(placeId: string, o: { lang: string; session?: string }): Promise<Detail> {
    const j = await (await this.call(`/v1/location/place/${encodeURIComponent(placeId)}?${new URLSearchParams({ lang: o.lang, ...(o.session ? { session: o.session } : {}) })}`)).json() as { label?: string; latitude?: number; longitude?: number };
    if (!Number.isFinite(Number(j.latitude)) || !Number.isFinite(Number(j.longitude))) throw new MapsError('ClickBIT’s location service didn’t say where that is', 502);
    return { label: j.label ?? '', latitude: Number(j.latitude), longitude: Number(j.longitude), placeId, provider: 'google' };
  }
  async staticMap(r: StaticMapRequest) {
    const res = await this.call(`/v1/location/static?${new URLSearchParams({ lat: String(r.latitude), lon: String(r.longitude), radius: String(r.radiusM ?? 150), w: String(r.width), h: String(r.height), ...(r.zoom ? { zoom: String(r.zoom) } : {}) })}`);
    return { type: res.headers.get('content-type') ?? 'image/png', body: Buffer.from(await res.arrayBuffer()) };
  }
  async timezone(p: Point) {
    try { const j = await (await this.call(`/v1/location/timezone?lat=${p.latitude}&lon=${p.longitude}`)).json() as { timezone?: string }; return j.timezone && validZone(j.timezone) ? j.timezone : null; } catch { return null; }
  }
}

// ----------------------------------------------------- OpenStreetMap -----
export class OsmProvider implements PlaceProvider {
  readonly id = 'osm' as const;
  readonly google = false;
  private last = 0;
  private err: string | null = null;
  constructor(private f: Fetch, private gapMs = 1100) {}
  lastError() { return this.err; }
  /** Nominatim's policy: at most one request a second, from the whole hub. */
  private async turn(): Promise<void> {
    const at = Math.max(Date.now(), this.last + this.gapMs);
    this.last = at;
    if (at > Date.now()) await new Promise(r => setTimeout(r, at - Date.now()));
  }
  async search(q: string, o: { lang: string; near: Point | null }) {
    await this.turn();
    // Matches near where the home already is come first (a box ±3° around it, not a limit).
    const box: Record<string, string> = o.near ? { viewbox: [o.near.longitude - 3, o.near.latitude + 3, o.near.longitude + 3, o.near.latitude - 3].map(n => n.toFixed(3)).join(','), bounded: '0' } : {};
    let res: Response;
    try {
      res = await this.f(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '5', addressdetails: '0', ...box })}`, { headers: { 'User-Agent': UA, 'Accept-Language': o.lang }, signal: AbortSignal.timeout(10_000) });
    } catch { this.err = 'Nominatim didn’t answer'; throw new MapsError('Couldn’t reach the address search: is the hub online?', 502); }
    if (!res.ok) { this.err = `Nominatim: HTTP ${res.status}`; throw new MapsError(`The address search answered HTTP ${res.status}`, 502); }
    this.err = null;
    const rows = await res.json() as { display_name: string; lat: string; lon: string }[];
    return { via: 'osm' as const, results: rows.map(r => ({ label: r.display_name, latitude: Number(r.lat), longitude: Number(r.lon), provider: 'osm' as const })).filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) };
  }
  async reverse(p: Point, lang: string): Promise<string | null> {
    try {
      await this.turn();
      const res = await this.f(`https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({ lat: String(p.latitude), lon: String(p.longitude), format: 'jsonv2', zoom: '18' })}`, { headers: { 'User-Agent': UA, 'Accept-Language': lang }, signal: AbortSignal.timeout(6_000) });
      if (!res.ok) return null;
      return (await res.json() as { display_name?: string }).display_name ?? null;
    } catch { return null; }
  }
}

// ------------------------------------------------------------------ Maps --
export class Maps {
  private cache = new Map<string, { at: number; value: unknown }>();
  private f: Fetch;
  readonly osm: OsmProvider;
  private proxy: ClickbitProxyProvider | null = null;
  private keyed: { key: string; p: GoogleKeyProvider } | null = null;
  private now: () => number;

  constructor(private o: MapsOptions) {
    this.f = o.fetch ?? ((...a) => fetch(...a));
    this.osm = new OsmProvider(this.f, o.nominatimGapMs);
    this.now = o.now ?? Date.now;
    const env = o.env ?? process.env;
    if (env.KOVA_LOCATION_PROXY_URL) this.useProxy(env.KOVA_LOCATION_PROXY_URL, async () => '');
  }

  /** ClickBIT's location proxy, signed in with the licence's device token (main.ts). */
  useProxy(url: string, token: () => Promise<string>): void { this.proxy = new ClickbitProxyProvider(url, token, this.f); this.cache.clear(); }

  // -------------------------------------------------------------- the key --
  private stored(): string | undefined { return this.o.store.get<{ googleKey?: string }>(STORE_KEY)?.googleKey; }
  /** The Google Maps key: the one entered in Settings, else KOVA_GOOGLE_MAPS_API_KEY / GOOGLE_MAPS_API_KEY. */
  private key(): string | undefined {
    const env = this.o.env ?? process.env;
    return this.stored() || env.KOVA_GOOGLE_MAPS_API_KEY || env.GOOGLE_MAPS_API_KEY || undefined;
  }
  /** The Google providers, the owner's key first. */
  private googles(): PlaceProvider[] {
    const k = this.key();
    if (k && this.keyed?.key !== k) this.keyed = { key: k, p: new GoogleKeyProvider(k, this.f) };
    return [...(k ? [this.keyed!.p] : []), ...(this.proxy ? [this.proxy] : [])];
  }
  get google(): boolean { return this.googles().length > 0; }

  /** For Settings: never the key, only whether there is one, where it's from, its last 4, and Google's last complaint. */
  status(): { google: boolean; provider: 'google-key' | 'clickbit' | 'osm'; from: 'hub' | 'env' | null; hint: string | null; lastError: string | null; proxy: boolean } {
    const k = this.key(), g = this.googles()[0];
    return { google: !!g, provider: g?.id ?? 'osm', from: this.stored() ? 'hub' : k ? 'env' : null, hint: k ? `…${k.slice(-4)}` : null, lastError: g?.lastError() ?? null, proxy: !!this.proxy };
  }

  /** Save (or with null/"" remove) the key entered in Settings. */
  setKey(k: string | null | undefined): void {
    const v = typeof k === 'string' ? k.trim() : '';
    if (v && !KEY_SHAPE.test(v)) throw new MapsError('That doesn’t look like a Google Maps API key');
    const next = { ...(this.o.store.get<Record<string, unknown>>(STORE_KEY) ?? {}) };
    if (v) next.googleKey = v; else delete next.googleKey;
    this.o.store.set(STORE_KEY, next);
    this.keyed = null;
    this.cache.clear();
  }

  // Only lists of matches and OpenStreetMap's answers are kept, and only for a day; never Google's coordinates.
  private cached<T>(key: string): T | undefined {
    const hit = this.cache.get(key);
    return hit && Date.now() - hit.at < DAY ? hit.value as T : undefined;
  }
  private keep<T>(key: string, value: T): T {
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  // ----------------------------------------------------------- the search --
  /** Matches for what's typed. Google's are text and a placeId only: place() gives the point once one is picked. */
  async search(q: string, lang = 'en'): Promise<{ results: Found[]; via: SearchVia; session?: string }> {
    const near = this.o.near();
    const session = randomUUID();
    for (const p of this.googles()) {
      const r = await p.search(q, { lang, near, session });
      if (r) return { ...r, session };
    }
    const ck = `osm:${lang}:${q.toLowerCase()}@${near ? `${Math.round(near.latitude)},${Math.round(near.longitude)}` : ''}`;
    const hit = this.cached<{ results: Found[]; via: SearchVia }>(ck);
    return hit ?? this.keep(ck, await this.osm.search(q, { lang, near }));
  }

  /** A Google match's address and point (Place Details), in the same session as the search that found it. */
  async place(placeId: string, session: string | undefined, lang = 'en'): Promise<Detail> {
    if (!PLACE_ID.test(placeId)) throw new MapsError('That isn’t a place id');
    const ps = this.googles().filter(p => p.details);
    if (!ps.length) throw new MapsError('Google isn’t set up on this hub', 404);
    let last: unknown;
    for (const p of ps) { try { return await p.details!(placeId, { lang, session }); } catch (e) { last = e; } }
    throw last;
  }

  /** Google's map of a point and the home's circle, as a picture (the key stays on the hub). */
  async staticMap(r: StaticMapRequest): Promise<{ type: string; body: Buffer }> {
    const ps = this.googles().filter(p => p.staticMap);
    if (!ps.length) throw new MapsError('Google isn’t set up on this hub', 404);
    let last: unknown;
    for (const p of ps) { try { return await p.staticMap!(r); } catch (e) { last = e; } }
    throw last;
  }

  /** The address at a point, from OpenStreetMap (best effort: the point is what matters). */
  async reverse(p: Point, lang = 'en'): Promise<string | null> {
    const ck = `rev:${lang}:${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`;
    const hit = this.cached<string | null>(ck);
    if (hit !== undefined) return hit;
    const a = await this.osm.reverse(p, lang);
    return a ? this.keep(ck, a) : null;
  }

  // ---------------------------------------------------- pasted from Google --
  /**
   * Whatever was pasted (a Google Maps link, short or long, coordinates, a Plus Code) → a point, with the place's
   * name when the link has one and the address there when it can be found. Throws a MapsError saying what to do.
   * A link's own coordinates are the person's; a link with only a name is looked up, and when Google finds it the
   * answer is Google's (provider "google", with its placeId).
   */
  async locate(text: string, lang = 'en', depth = 0): Promise<Located> {
    const t = String(text ?? '').trim().slice(0, 4000);
    if (!t) throw new MapsError('Paste a Google Maps link or coordinates');
    let r: Parsed | null = parseLocationText(t);
    if (!r) throw new MapsError(/https?:\/\//i.test(t) ? 'That link isn’t a Google Maps place. In Google Maps, tap Share and copy the link.' : 'Kova couldn’t find a place in that. Paste a Google Maps link, coordinates like -33.8568, 151.2153, or a Plus Code.');
    if (r.kind === 'short-link') {
      if (depth > 0) throw new MapsError('That link didn’t lead to a place');
      let long: string;
      try { long = await resolveShortLink(r.url, { ...this.o.resolve, fetch: this.f }); }
      catch (e) { throw new MapsError(`Couldn’t open that link: ${(e as Error).message}`, 502); }
      const out = await this.locate(long, lang, depth + 1);
      return r.label && !out.label ? { ...out, label: r.label } : out;
    }
    if (r.kind === 'short-plus-code') {
      let ref: Point | null = null;
      if (r.locality) ref = await this.findPoint(r.locality, lang).catch(() => null);
      ref ??= this.o.near();
      if (!ref) throw new MapsError(`${r.code} is a short Plus Code: add the town after it, or copy the full code (8 characters before the +)`);
      const p = recoverPlusCode(r.code, ref);
      if (!p) throw new MapsError('That Plus Code isn’t one Kova can read');
      r = { kind: 'point', ...p, via: 'plus-code', label: `${r.code}${r.locality ? ` ${r.locality}` : ''}` };
    }
    if (r.kind === 'name') {
      // A link with only a place's name: find it the same way the address search does.
      const m = await this.search(r.query.slice(0, 200), lang);
      const first = m.results[0];
      if (!first) throw new MapsError(`Couldn’t find “${r.query}”. In Google Maps, long-press the spot and copy the coordinates instead.`, 404);
      if (first.provider === 'google') {
        const d = await this.place(first.placeId!, m.session, lang);
        return { latitude: d.latitude, longitude: d.longitude, label: r.query, address: d.label, via: `${r.via}+${m.via}`, provider: 'google', placeId: d.placeId };
      }
      return { latitude: first.latitude!, longitude: first.longitude!, label: r.query, address: first.label, via: `${r.via}+${m.via}`, provider: 'osm' };
    }
    const address = await this.reverse(r, lang);
    return { latitude: r.latitude, longitude: r.longitude, ...(r.label ? { label: r.label } : {}), ...(address ? { address } : {}), via: r.via };
  }

  /** Somewhere to start from (a short Plus Code's town): only used to work out a point, never kept. */
  private async findPoint(q: string, lang: string): Promise<Point | null> {
    const m = await this.search(q, lang);
    const first = m.results[0];
    if (!first) return null;
    if (first.latitude !== undefined && first.longitude !== undefined) return { latitude: first.latitude, longitude: first.longitude };
    return first.placeId ? await this.place(first.placeId, m.session, lang) : null;
  }

  // ------------------------------------------------- keeping Google fresh --
  /**
   * The home's point when it came from Google and is older than Google lets it be kept: asked again by its place
   * id. With no Google provider any more, the saved address is found on OpenStreetMap instead (and the point is
   * then OpenStreetMap's). Null when nothing is due or nothing answered (tried again later).
   */
  async refresh(c: Pick<HomeConfig, 'location' | 'address'>, lang = 'en'): Promise<{ location: HomeLocation; address?: string } | null> {
    const l = c.location;
    if (!l || l.provider !== 'google' || !l.placeId) return null;
    const now = this.now();
    if (now - (l.fetchedAt ?? l.updatedAt ?? 0) < GOOGLE_KEEP_MS) return null;
    if (this.googles().some(p => p.details)) {
      try {
        const d = await this.place(l.placeId, undefined, lang);
        return { location: { ...l, latitude: round5(d.latitude), longitude: round5(d.longitude), fetchedAt: now }, ...(d.label ? { address: d.label } : {}) };
      } catch { return null; }
    }
    if (!c.address) return null;
    try {
      const m = await this.osm.search(c.address, { lang, near: { latitude: l.latitude, longitude: l.longitude } });
      const first = m.results[0];
      if (!first) return null;
      return { location: { ...l, latitude: round5(first.latitude!), longitude: round5(first.longitude!), provider: 'osm', fetchedAt: now }, address: first.label };
    } catch { return null; }
  }

  // -------------------------------------------------------------- timezone --
  /**
   * The timezone at a point: Google's Time Zone API when there's a Google provider and it answers, otherwise the
   * zone whose reference city is nearest (good away from borders; Settings can always change it).
   */
  async timezoneAt(p: Point): Promise<string | null> {
    for (const g of this.googles()) { const z = await g.timezone?.(p).catch(() => null); if (z) return z; }
    return nearestZone(p);
  }
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

export const validZone = (z: string) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } };

export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180, dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function nearestZone(p: Point): string | null {
  let best: string | null = null, d = Infinity;
  for (const z of TZ_PLACES) {
    const x = distanceKm(p, z);
    if (x < d && validZone(z.zone)) { d = x; best = z.zone; }
  }
  return best;
}

/** Whether two zones keep the same clock (now and half a year away), so changing between them changes nothing. */
export function sameClock(a: string, b: string, now = Date.now()): boolean {
  if (a === b) return true;
  const off = (z: string, t: number) => new Intl.DateTimeFormat('en', { timeZone: z, timeZoneName: 'longOffset' }).formatToParts(t).find(x => x.type === 'timeZoneName')?.value;
  try { return [now, now + 182 * DAY].every(t => off(a, t) === off(b, t)); } catch { return false; }
}
