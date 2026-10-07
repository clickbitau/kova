// Turning whatever someone copies out of Google Maps into a point: share links (short ones are resolved by the
// hub), full google.com/maps addresses, plain coordinates (decimal, with N/S/E/W, or degrees-minutes-seconds) and
// Plus Codes. Everything here is pure except resolveShortLink, which takes the fetch it uses.

export interface Point { latitude: number; longitude: number }
/** What a pasted text says: a point (with the place's name when the link has one), or only a name to look up. */
export type Parsed =
  | { kind: 'point'; latitude: number; longitude: number; label?: string; via: string }
  | { kind: 'name'; query: string; via: string }
  | { kind: 'short-plus-code'; code: string; locality?: string; via: string }
  | { kind: 'short-link'; url: string; label?: string; via: string };

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const valid = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const point = (latitude: number, longitude: number, via: string, label?: string): Parsed | null =>
  valid(latitude, longitude) ? { kind: 'point', latitude: round(latitude), longitude: round(longitude), via, ...(label ? { label } : {}) } : null;

// ------------------------------------------------------------ coordinates --

/**
 * One coordinate in degrees, optionally with minutes and seconds, and a hemisphere letter before it ("S 33.85")
 * or after it ("33.85 S"). Each form has the same five groups: letter before, degrees, minutes, seconds, letter after.
 */
const CORE = String.raw`([-+\u2212]?\d{1,3}(?:[.,]\d+)?)\s*(?:°|º|˚|deg|d(?![a-z]))?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*(?:'|′|’|‘|m(?![a-z])|min)\s*)?(?:(\d{1,2}(?:[.,]\d+)?)\s*(?:"|″|”|“|''|′′|s(?![a-z])|sec)\s*)?`;
const BEFORE = String.raw`([NSEWnsew])\s*${CORE}()`;
const AFTER = String.raw`()${CORE}([NSEWnew])?`;
// Case matters: a lowercase s after a number of seconds is the unit, a capital S is south.
const PAIRS = [[AFTER, AFTER], [BEFORE, BEFORE], [BEFORE, AFTER], [AFTER, BEFORE]].map(([a, b]) => new RegExp(String.raw`^\s*${a}\s*(?:,|;|\s|/)\s*${b}\s*$`));

function degrees(sign: string | undefined, d: string, m: string | undefined, s: string | undefined): number {
  const num = (x: string) => Number(x.replace(',', '.').replace('−', '-'));
  const deg = num(d);
  const v = Math.abs(deg) + (m ? num(m) / 60 : 0) + (s ? num(s) / 3600 : 0);
  return /^[-−]/.test(d) ? -v : v;
}

/**
 * Two coordinates: "-33.85678, 151.21530", "33.85678° S, 151.2153° E", "S 33.85678 E 151.2153",
 * "33°51'24.4"S 151°12'55.1"E", "33° 51.407' S 151° 12.918' E". Latitude first, unless the letters say otherwise.
 */
export function parseCoordinates(text: string): Point | null {
  const t = text.trim().replace(/\s+/g, ' ');
  // A comma may be a decimal comma ("-33,856 151,215") only when there's no other separator.
  const first = (x: string) => { for (const re of PAIRS) { const m = re.exec(x); if (m) return m; } return null; };
  const m = first(t) ?? first(t.replace(/(\d),(\d)/g, '$1.$2'));
  if (!m) return null;
  const [, h1a, d1, m1, s1, h1b, h2a, d2, m2, s2, h2b] = m;
  const h1 = (h1a || h1b)?.toUpperCase() || undefined, h2 = (h2a || h2b)?.toUpperCase() || undefined;
  // A minutes or seconds value of 60 or more isn't one.
  for (const x of [m1, s1, m2, s2]) if (x && Number(x.replace(',', '.')) >= 60) return null;
  // Minutes or seconds with a decimal degree ("33.5°30'") isn't a coordinate.
  if ((m1 && /[.,]/.test(d1)) || (m2 && /[.,]/.test(d2))) return null;
  let a = degrees(undefined, d1, m1, s1), b = degrees(undefined, d2, m2, s2);
  const isLon = (h?: string) => h === 'E' || h === 'W';
  const neg = (h?: string) => h === 'S' || h === 'W';
  if ((h1 && neg(h1) && a < 0) || (h2 && neg(h2) && b < 0)) return null;
  if (h1 && neg(h1)) a = -Math.abs(a);
  if (h2 && neg(h2)) b = -Math.abs(b);
  if (h1 && h2 && isLon(h1) === isLon(h2)) return null;
  if (isLon(h1) || (h2 && !isLon(h2))) [a, b] = [b, a];
  return valid(a, b) ? { latitude: round(a), longitude: round(b) } : null;
}

// ------------------------------------------------------------- plus codes --

const OLC = '23456789CFGHJMPQRVWX';
const OLC_FULL = /^[23456789C][23456789CFGHJMPQRV](?:[23456789CFGHJMPQRVWX]{6}\+[23456789CFGHJMPQRVWX]{2,}|[23456789CFGHJMPQRVWX]{4}0{2}\+|[23456789CFGHJMPQRVWX]{2}0{4}\+|0{6}\+)$/i;
const OLC_SHORT = /^[23456789CFGHJMPQRVWX]{2,6}\+[23456789CFGHJMPQRVWX]{2,}$/i;
const PAIR_RES = [20, 1, 0.05, 0.0025, 0.000125];

export const isFullPlusCode = (s: string) => OLC_FULL.test(s.trim());
export const isShortPlusCode = (s: string) => {
  const t = s.trim().toUpperCase();
  return OLC_SHORT.test(t) && t.indexOf('+') % 2 === 0 && t.indexOf('+') < 8;
};

/** The centre of a full Plus Code's area ("4RRH46J3+3C"). */
export function decodePlusCode(code: string): Point | null {
  if (!isFullPlusCode(code)) return null;
  const c = code.trim().toUpperCase().replace('+', '').replace(/0+$/, '');
  let lat = -90, lon = -180, latRes = 0, lonRes = 0;
  for (let i = 0; i < Math.min(c.length, 10); i += 2) {
    const r = PAIR_RES[i / 2];
    lat += OLC.indexOf(c[i]) * r;
    lon += OLC.indexOf(c[i + 1] ?? '2') * r;
    latRes = lonRes = r;
  }
  for (let i = 10; i < Math.min(c.length, 15); i++) {
    latRes /= 5; lonRes /= 4;
    const d = OLC.indexOf(c[i]);
    lat += Math.floor(d / 4) * latRes;
    lon += (d % 4) * lonRes;
  }
  return { latitude: round(Math.min(90, lat + latRes / 2)), longitude: round(lon + lonRes / 2) };
}

/** A full Plus Code for a point (10 digits, about 14 m), for tests and for recovering short codes. */
export function encodePlusCode(lat: number, lon: number, length = 10): string {
  lat = Math.min(90, Math.max(-90, lat));
  if (lat === 90) lat -= 0.000125 / 2;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  // Whole steps of the finest pair (1/8000°), so floating point can't move a digit.
  let la = Math.floor((lat + 90) * 8000 + 1e-9), lo = Math.floor((lon + 180) * 8000 + 1e-9);
  let out = '';
  const units = [160000, 8000, 400, 20, 1];
  for (let i = 0; i < 5 && out.length < Math.min(length, 10); i++) {
    const a = Math.floor(la / units[i]), b = Math.floor(lo / units[i]);
    la -= a * units[i]; lo -= b * units[i];
    out += OLC[a] + OLC[b];
  }
  return `${out.slice(0, 8)}+${out.slice(8)}`;
}

/** A short Plus Code ("46J3+3C") made full with the nearest place it can be to a reference point. */
export function recoverPlusCode(short: string, ref: Point): Point | null {
  const s = short.trim().toUpperCase();
  if (!isShortPlusCode(s)) return null;
  const pad = 8 - s.indexOf('+');
  const resolution = 20 ** (2 - pad / 2), half = resolution / 2;
  const prefix = encodePlusCode(ref.latitude, ref.longitude).replace('+', '').slice(0, pad);
  const full = `${(prefix + s.replace('+', '')).slice(0, 8)}+${s.split('+')[1]}`;
  const p = decodePlusCode(full);
  if (!p) return null;
  let { latitude: lat, longitude: lon } = p;
  if (ref.latitude + half < lat && lat - resolution >= -90) lat -= resolution;
  else if (ref.latitude - half > lat && lat + resolution <= 90) lat += resolution;
  if (ref.longitude + half < lon) lon -= resolution;
  else if (ref.longitude - half > lon) lon += resolution;
  return valid(lat, lon) ? { latitude: round(lat), longitude: round(lon) } : null;
}

// ------------------------------------------------------------------ links --

/** Google's own hosts: google.com, google.com.au, google.co.uk, maps.google.de, consent.google.com… */
export function isGoogleHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'goo.gl' || h === 'maps.app.goo.gl' || /^(?:[a-z0-9-]+\.)*google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(h);
}

/** A Google Maps short share link, which only the hub can follow to the place. */
export function isShortLink(u: URL): boolean {
  const h = u.hostname.toLowerCase();
  return h === 'maps.app.goo.gl' || (h === 'goo.gl' && /^\/maps(?:\/|$)/.test(u.pathname));
}

const decode = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s.replace(/\+/g, ' '); } };
const AT = /@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:,|$|\/|\?)/;

/** A place name, coordinates or Plus Code written as a value (?q=, /place/…, /search/…). */
function fromValue(v: string, via: string, label?: string): Parsed | null {
  const t = v.trim();
  if (!t) return null;
  const c = parseCoordinates(t);
  if (c) return point(c.latitude, c.longitude, via, label);
  const full = /^([23456789CFGHJMPQRVWX0]{8}\+[23456789CFGHJMPQRVWX]*)(?:[\s,]+(.*))?$/i.exec(t);
  if (full && isFullPlusCode(full[1])) { const p = decodePlusCode(full[1])!; return point(p.latitude, p.longitude, 'plus-code', label ?? full[2]?.trim()); }
  const short = /^([23456789CFGHJMPQRVWX]{2,6}\+[23456789CFGHJMPQRVWX]{2,})(?:[\s,]+(.*))?$/i.exec(t);
  if (short && isShortPlusCode(short[1])) return { kind: 'short-plus-code', code: short[1].toUpperCase(), ...(short[2]?.trim() ? { locality: short[2].trim() } : {}), via: 'plus-code' };
  return { kind: 'name', query: t, via };
}

/**
 * A Google Maps address (or Apple Maps, or a geo: URI). The place's own pin (`!3d…!4d…`) wins over the map's
 * centre (`@lat,lng`), which is only where the screen was looking.
 */
export function parseMapsUrl(raw: string): Parsed | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol === 'geo:') {
    // geo:-33.85,151.21?q=-33.85,151.21(Label) or geo:0,0?q=Some+place
    const q = u.searchParams.get('q');
    const label = q ? /\(([^)]*)\)\s*$/.exec(q)?.[1] : undefined;
    const c = parseCoordinates(u.pathname.split(';')[0]);
    if (c && (c.latitude || c.longitude)) return point(c.latitude, c.longitude, 'geo', label);
    return q ? fromValue(q.replace(/\([^)]*\)\s*$/, ''), 'geo', label) : null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (isShortLink(u)) return { kind: 'short-link', url: u.toString(), via: 'short-link' };
  // Google's consent page carries the real address in `continue`.
  if (/^consent\.google\./.test(host) && u.searchParams.get('continue')) return parseMapsUrl(u.searchParams.get('continue')!);
  if (host === 'maps.apple.com' || host === 'maps.apple') {
    const label = u.searchParams.get('q') ?? u.searchParams.get('name') ?? undefined;
    for (const k of ['coordinate', 'll', 'sll', 'daddr', 'center']) {
      const v = u.searchParams.get(k);
      const c = v ? parseCoordinates(v) : null;
      if (c) return point(c.latitude, c.longitude, 'apple', label);
    }
    const a = u.searchParams.get('address') ?? label;
    return a ? fromValue(a, 'apple') : null;
  }
  if (!isGoogleHost(host)) return null;
  const isMaps = /^maps\./.test(host) || /^\/maps(?:\/|$)/.test(u.pathname) || u.pathname === '/' && (u.searchParams.has('q') || u.searchParams.has('ll'));
  if (!isMaps) {
    // google.com/search?q=… or /url?q=<a maps address>
    const inner = u.searchParams.get('q') ?? u.searchParams.get('url');
    if (inner && /^https?:/i.test(inner)) return parseMapsUrl(inner);
    return null;
  }
  const path = u.pathname, full = decode(path) + u.hash;
  const segs = path.split('/').filter(Boolean).map(decode);
  const after = (name: string) => { const i = segs.indexOf(name); return i >= 0 && segs[i + 1] && !segs[i + 1].startsWith('@') && !segs[i + 1].startsWith('data=') ? segs[i + 1] : undefined; };
  const placeName = after('place');
  const placeLabel = placeName && !parseCoordinates(placeName) && !/^[23456789CFGHJMPQRVWX0]{2,8}\+/i.test(placeName) ? placeName : undefined;

  // 1. The place's own pin in the data blob: !3d<lat>!4d<lng> (the last one is the place's marker).
  const pins = [...(path + u.search).matchAll(/!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/g)];
  if (pins.length && !segs.includes('dir')) {
    const [, la, lo] = pins[pins.length - 1];
    const p = point(Number(la), Number(lo), 'place-pin', placeLabel);
    if (p) return p;
  }
  // 2. Maps URLs (api=1) and the classic query parameters.
  const params = ['query', 'q', 'll', 'sll', 'center', 'destination', 'daddr', 'viewpoint'];
  for (const k of params) {
    const v = u.searchParams.get(k);
    if (!v) continue;
    const named = u.searchParams.get('q') ?? u.searchParams.get('query');
    const r = fromValue(v.replace(/^loc:\s*/i, ''), `param:${k}`, placeLabel ?? (named && !parseCoordinates(named) ? named : undefined));
    if (r && r.kind !== 'name') return r;
  }
  // 3. Directions: the last stop.
  if (segs[0] === 'maps' && segs[1] === 'dir') {
    const stops = segs.slice(2).filter(s => !s.startsWith('@') && !s.startsWith('data='));
    const last = stops[stops.length - 1];
    const r = last ? fromValue(last, 'directions') : null;
    if (r && r.kind !== 'name') return r;
    const legs = [...path.matchAll(/!1d(-?\d{1,3}(?:\.\d+)?)!2d(-?\d{1,2}(?:\.\d+)?)/g)];
    if (legs.length) { const [, lo, la] = legs[legs.length - 1]; const p = point(Number(la), Number(lo), 'directions'); if (p) return p; }
    if (r) return r;
  }
  // 4. /place/<coordinates or a Plus Code>, /search/<…>
  for (const name of ['place', 'search']) {
    const v = after(name);
    if (!v) continue;
    const r = fromValue(v, name);
    if (r && r.kind !== 'name') return r;
  }
  // 5. The map's centre: /@lat,lng,17z (also a street view's camera).
  const at = AT.exec(full);
  if (at) { const p = point(Number(at[1]), Number(at[2]), 'viewport', placeLabel); if (p) return p; }
  // 6. Only a name: look it up.
  for (const k of ['query', 'q', 'destination', 'daddr']) {
    const v = u.searchParams.get(k);
    if (v && v.trim()) return { kind: 'name', query: v.trim(), via: `param:${k}` };
  }
  const named = placeLabel ?? after('search');
  if (named) return { kind: 'name', query: named, via: 'place-name' };
  return null;
}

/**
 * Anything pasted: a link (alone, or after the place's name as phones share it), coordinates, or a Plus Code
 * ("4RRH46J3+3C", or "46J3+3C Sydney"). Null when there's nothing Kova can use.
 */
export function parseLocationText(text: string): Parsed | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const link = /\b(?:https?:\/\/|geo:)[^\s<>"]+/i.exec(t);
  if (link) {
    const r = parseMapsUrl(link[0].replace(/[).,;]+$/, ''));
    if (!r) return null;
    // "Sydney Opera House\nhttps://maps.app.goo.gl/…": the words before the link name the place.
    const before = t.slice(0, link.index).trim().replace(/[\s:–-]+$/, '').split('\n').map(s => s.trim()).filter(Boolean).join(', ').slice(0, 200);
    if (before && (r.kind === 'point' || r.kind === 'short-link') && !r.label) return { ...r, label: before };
    return r;
  }
  const one = t.replace(/\s+/g, ' ');
  const c = parseCoordinates(one);
  if (c) return { kind: 'point', ...c, via: 'coordinates' };
  const r = fromValue(one, 'text');
  // Plain words aren't a pasted location (the address search is for those).
  return r && r.kind !== 'name' ? r : null;
}

// ------------------------------------------------------------ short links --

export interface ResolveOptions {
  fetch?: typeof fetch;
  /** For the whole chain of redirects. */
  timeoutMs?: number;
  maxHops?: number;
  /** Which addresses may be fetched: Google's own, over https, unless a test says otherwise. */
  allow?: (u: URL) => boolean;
}

export const allowGoogle = (u: URL) => u.protocol === 'https:' && isGoogleHost(u.hostname) && !u.username && !u.password && (!u.port || u.port === '443');

/**
 * Follow a short share link to the Google Maps address it stands for, one redirect at a time, fetching only
 * Google's own hosts. Stops as soon as an address says where the place is. Some short links answer with a page
 * instead of a redirect: the Maps address is then read out of it.
 */
export async function resolveShortLink(raw: string, o: ResolveOptions = {}): Promise<string> {
  const f = o.fetch ?? fetch, allow = o.allow ?? allowGoogle, maxHops = o.maxHops ?? 6;
  const signal = AbortSignal.timeout(o.timeoutMs ?? 8000);
  let u = new URL(raw);
  if (u.protocol === 'http:' && isGoogleHost(u.hostname)) u.protocol = 'https:';
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!allow(u)) throw new Error(`The link went somewhere that isn’t Google Maps (${u.hostname})`);
    const res = await f(u.toString(), { redirect: 'manual', signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kova)', 'Accept-Language': 'en' } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!loc) throw new Error('The link didn’t say where it goes');
      const next = new URL(loc, u);
      const parsed = allow(next) ? parseMapsUrl(asGoogle(next)) : null;
      if (parsed && parsed.kind !== 'short-link' && !/^consent\./.test(next.hostname)) return next.toString();
      if (/^consent\./.test(next.hostname) && next.searchParams.get('continue')) return next.searchParams.get('continue')!;
      u = next;
      continue;
    }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`Google Maps answered HTTP ${res.status} for that link`); }
    // A page: look for the Maps address in it (a redirect script, a canonical link or an og:url).
    const body = (await readSome(res, 512 * 1024)).replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/\\\//g, '/');
    const found = [...body.matchAll(/https?:\/\/(?:www\.|maps\.)?google\.[a-z.]{2,8}\/maps[^\s"'<>\\]*/gi)].map(m => m[0]);
    const best = found.find(x => { const p = parseMapsUrl(x); return p && p.kind === 'point'; }) ?? found.find(x => parseMapsUrl(x));
    if (best) return best;
    const here = parseMapsUrl(asGoogle(u));
    if (here && here.kind !== 'short-link') return u.toString();
    throw new Error('Couldn’t find the place in that link');
  }
  throw new Error('The link redirected too many times');
}

/** An address the rules allow, read as Google's (tests stand a local server in for Google). */
const asGoogle = (u: URL) => {
  if (isGoogleHost(u.hostname)) return u.toString();
  const g = new URL(u.toString()); g.protocol = 'https:'; g.host = 'www.google.com';
  return g.toString();
};

async function readSome(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader(), parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); n += value.length;
    if (n >= max) { await reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(parts).toString('utf8');
}
