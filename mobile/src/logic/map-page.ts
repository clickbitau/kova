// The map in Settings → Where the home is: a small Leaflet page with OpenStreetMap tiles, shown in the WebView
// the app already has (react-native-webview, in the store build), or an iframe on the web. No new native module,
// so it ships over the air. The pin drags, the small handle on the circle's edge resizes it (50–500 m), and a tap
// moves the pin there. Google's points are never drawn here (Google's terms): those show Google's own map.
//
// Messages, as JSON strings:
//   page → app: { kova: 'ready' } | { kova: 'moved', latitude, longitude } | { kova: 'radius', radiusM } | { kova: 'error', message }
//   app → page: { kova: 'set', latitude, longitude, radiusM, fit? } | { kova: 'clear' }

export const RADIUS_MIN = 50;
export const RADIUS_MAX = 500;

export type FromMap =
  | { kova: 'ready' }
  | { kova: 'moved'; latitude: number; longitude: number }
  | { kova: 'radius'; radiusM: number }
  | { kova: 'error'; message: string };
export type ToMap = { kova: 'set'; latitude: number; longitude: number; radiusM: number; fit?: boolean } | { kova: 'clear'; radiusM: number };

const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist';
const CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
const JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';

export const clampRadius = (r: number) => Math.round(Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, r)) / 10) * 10;

/** A message from the page, checked (anything else is ignored). */
export function readMapMessage(data: unknown): FromMap | null {
  let m: unknown = data;
  if (typeof data === 'string') { try { m = JSON.parse(data); } catch { return null; } }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (o.kova === 'ready') return { kova: 'ready' };
  if (o.kova === 'moved' && num(o.latitude) && num(o.longitude) && Math.abs(o.latitude as number) <= 90 && Math.abs(o.longitude as number) <= 180)
    return { kova: 'moved', latitude: Math.round((o.latitude as number) * 1e6) / 1e6, longitude: Math.round((o.longitude as number) * 1e6) / 1e6 };
  if (o.kova === 'radius' && num(o.radiusM)) return { kova: 'radius', radiusM: clampRadius(o.radiusM as number) };
  if (o.kova === 'error' && typeof o.message === 'string') return { kova: 'error', message: o.message.slice(0, 200) };
  return null;
}

/** JavaScript for the WebView to run: hands the page a message. */
export const injectFor = (m: ToMap) => `window.kovaSet && window.kovaSet(${JSON.stringify(m)}); true;`;

/** The page. `start` is where it opens (null: the whole world, until a pin is placed). */
export function mapPageHtml(start: { latitude: number; longitude: number; radiusM: number } | null): string {
  const init = JSON.stringify(start ?? null);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="${LEAFLET}/leaflet.css" integrity="${CSS_SRI}" crossorigin="">
<style>html,body,#map{margin:0;height:100%;background:#1c1d20}body{font:13px -apple-system,system-ui,sans-serif;color:#a3a09a}.msg{padding:16px}
.leaflet-control-attribution{font-size:10px}</style></head><body><div id="map"></div>
<script>
(function(){
var MIN=${RADIUS_MIN},MAX=${RADIUS_MAX};
function post(m){var s=JSON.stringify(m);try{if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(s);else if(window.parent!==window)window.parent.postMessage(s,'*')}catch(e){}}
var start=${init},map,pin,circle,knob,radius=start?start.radiusM:150,shown=false;
function edge(ll){return L.latLng(ll.lat,ll.lng+radius/(111320*Math.cos(ll.lat*Math.PI/180)))}
function show(){if(!shown){pin.addTo(map);circle.addTo(map);knob.addTo(map);shown=true}}
function put(ll){pin.setLatLng(ll);circle.setLatLng(ll);circle.setRadius(radius);knob.setLatLng(edge(ll))}
function fit(){map.fitBounds(circle.getBounds(),{padding:[20,20],maxZoom:18,animate:false})}
window.kovaSet=function(m){if(!map||!m)return;if(m.kova==='clear'){radius=m.radiusM||radius;return}
  if(m.kova!=='set')return;radius=Math.min(MAX,Math.max(MIN,m.radiusM||radius));var ll=L.latLng(m.latitude,m.longitude);show();put(ll);
  if(m.fit||!map.getBounds().contains(circle.getBounds()))fit()};
function onMsg(e){var m=e.data;if(typeof m==='string'){try{m=JSON.parse(m)}catch(x){return}}if(m&&m.kova)window.kovaSet(m)}
window.addEventListener('message',onMsg);document.addEventListener('message',onMsg);
function boot(){
  map=L.map('map',{zoomControl:true,attributionControl:true,tap:true}).setView(start?[start.latitude,start.longitude]:[20,0],start?17:2);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
  var icon=L.divIcon({className:'',html:'<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;background:#f2b14c;border:2px solid #1a1408;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,.5)"></div>',iconSize:[26,26],iconAnchor:[13,26]});
  var kn=L.divIcon({className:'',html:'<div style="width:24px;height:24px;border-radius:50%;background:#f1efea;border:3px solid #f2b14c;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>',iconSize:[24,24],iconAnchor:[12,12]});
  var at=start?L.latLng(start.latitude,start.longitude):map.getCenter();
  pin=L.marker(at,{draggable:true,icon:icon,autoPan:true});
  circle=L.circle(at,{radius:radius,color:'#f2b14c',weight:2,fillColor:'#f2b14c',fillOpacity:0.12,interactive:false});
  knob=L.marker(edge(at),{draggable:true,icon:kn});
  if(start){show();put(at);fit()}
  pin.on('drag',function(e){var ll=e.target.getLatLng();circle.setLatLng(ll);knob.setLatLng(edge(ll))});
  pin.on('dragend',function(e){var ll=e.target.getLatLng();post({kova:'moved',latitude:ll.lat,longitude:ll.lng})});
  knob.on('drag',function(e){var d=pin.getLatLng().distanceTo(e.target.getLatLng());radius=Math.round(Math.min(MAX,Math.max(MIN,d))/10)*10;circle.setRadius(radius)});
  knob.on('dragend',function(){knob.setLatLng(edge(pin.getLatLng()));post({kova:'radius',radiusM:radius})});
  map.on('click',function(e){show();put(e.latlng);post({kova:'moved',latitude:e.latlng.lat,longitude:e.latlng.lng})});
  post({kova:'ready'});
}
var s=document.createElement('script');s.src='${LEAFLET}/leaflet.js';s.integrity='${JS_SRI}';s.crossOrigin='';
s.onload=boot;s.onerror=function(){document.getElementById('map').innerHTML='<div class="msg">The map needs the internet. Paste coordinates or search the address instead.</div>';post({kova:'error',message:'The map couldn’t load'})};
document.head.appendChild(s);
})();
</script></body></html>`;
}
