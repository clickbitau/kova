import { INTEGRATION_SECTIONS, type Integrations } from './integrations.ts';

/**
 * What the app shows when setting up an integration: one entry per
 * integrations.json section, with the fields to ask for and the extra actions
 * (link an account, pair, show a code). The web app renders these generically,
 * so adding a section here is enough to make it configurable in the app.
 */

export interface Option { value: string; label: string }

export interface Field {
  /** Where the value lives in the section. Dots reach into nested objects ("opnsense.url"). */
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select' | 'list';
  placeholder?: string;
  help?: string;
  required?: boolean;
  /** select: fixed options, or the home's rooms / people. */
  options?: Option[] | 'rooms' | 'people';
  /** text: a list of strings, typed comma-separated. */
  multiple?: boolean;
  /** list: the fields of each row. */
  item?: Field[];
  /**
   * list: how rows are stored. 'array' (default) is an array of row objects.
   * 'map' is an object keyed by the row's `mapKey` field; its value is the rest
   * of the row, or just the `mapValue` field when that is set.
   */
  shape?: 'array' | 'map';
  mapKey?: string;
  mapValue?: string;
  /** list: the "add" button's label. */
  addLabel?: string;
}

/** A button in the setup drawer that calls an existing API route and shows what comes back. */
export interface Action {
  id: string;
  label: string;
  icon: string;
  method: 'GET' | 'POST';
  path: string;
  /** Inputs sent as the JSON body (POST) with the action. */
  fields?: Field[];
  help?: string;
  /** Open the `url` in the response in a new tab (e.g. Google sign-in). */
  opensUrl?: boolean;
}

export interface CatalogItem {
  /** The integrations.json section. */
  id: string;
  name: string;
  icon: string;
  kind: 'Local' | 'Cloud';
  description: string;
  fields: Field[];
  actions?: Action[];
  /** 'hot': saving restarts just this integration. 'restart': saved, takes effect when the hub restarts. */
  apply: 'hot' | 'restart';
  /** POST /api/integrations/:id/test can try the settings before saving. */
  testable?: boolean;
  /** Needs hub support that isn't in this build yet: settings are kept, actions may say "not available". */
  planned?: boolean;
}

const room = (label = 'Room', required = true): Field => ({ key: 'room', label, type: 'select', options: 'rooms', required });
const optId: Field = { key: 'id', label: 'Kova id', type: 'text', placeholder: 'optional, e.g. kitchen_ceiling', help: 'Give the id your modes already use to swap a simulated device for this one.' };

export const CATALOG: CatalogItem[] = [
  {
    id: 'tuya', name: 'Tuya (local)', icon: 'toggle_on', kind: 'Local', apply: 'hot', testable: true,
    description: 'Tuya and Smart Life Wi-Fi switches, straight over your network.',
    fields: [{
      key: 'devices', label: 'Devices', type: 'list', addLabel: 'Add device', required: true,
      help: 'Each device needs its id and local key (from the Tuya IoT platform or a localtuya setup).',
      item: [
        { key: 'id', label: 'Device id', type: 'text', required: true, placeholder: 'bf3c…' },
        { key: 'host', label: 'IP address', type: 'text', required: true, placeholder: '192.168.1.230' },
        { key: 'key', label: 'Local key', type: 'password', required: true, placeholder: '16 characters' },
        { key: 'version', label: 'Version', type: 'select', options: [{ value: '3.3', label: '3.3' }, { value: '3.4', label: '3.4' }] },
        {
          key: 'switches', label: 'Channels', type: 'list', shape: 'map', mapKey: 'dp', addLabel: 'Add channel',
          item: [
            { key: 'dp', label: 'DP', type: 'number', required: true, placeholder: '1' },
            { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Kitchen light' },
            room(),
            { key: 'type', label: 'Type', type: 'select', options: [{ value: 'light', label: 'Light' }, { value: 'plug', label: 'Plug' }] },
            optId,
          ],
        },
      ],
    }],
  },
  {
    id: 'tapo', name: 'TP-Link Tapo', icon: 'outlet', kind: 'Local', apply: 'hot', testable: true,
    description: 'Tapo plugs and bulbs, controlled locally with your TP-Link sign-in.',
    fields: [
      { key: 'username', label: 'TP-Link email', type: 'text', placeholder: 'you@example.com' },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'authHash', label: 'Or: Home Assistant credentials hash', type: 'password', help: 'Instead of email and password. The importer fills this in.' },
      {
        key: 'devices', label: 'Devices', type: 'list', addLabel: 'Add device', required: true,
        item: [
          { key: 'host', label: 'IP address', type: 'text', required: true, placeholder: '10.10.30.218' },
          room(),
          { key: 'name', label: 'Name', type: 'text', placeholder: 'optional; the Tapo name otherwise' },
          optId,
        ],
      },
    ],
  },
  {
    id: 'cast', name: 'Google Cast', icon: 'cast', kind: 'Local', apply: 'hot',
    description: 'Nest speakers, Chromecasts and Cast groups, found on your network.',
    fields: [
      {
        key: 'rooms', label: 'Rooms', type: 'list', shape: 'map', mapKey: 'name', mapValue: 'room', addLabel: 'Add speaker',
        help: 'Which room each speaker or group is in, by its name in Google Home.',
        item: [{ key: 'name', label: 'Speaker or group', type: 'text', required: true, placeholder: 'Music Room Speaker' }, room()],
      },
      {
        key: 'endpoints', label: 'Fixed addresses', type: 'list', addLabel: 'Add address',
        help: 'Only for speakers discovery can’t find (another VLAN).',
        item: [
          { key: 'id', label: 'Id', type: 'text', required: true },
          { key: 'name', label: 'Name', type: 'text', required: true },
          { key: 'model', label: 'Model', type: 'text', placeholder: 'Google Nest Mini' },
          { key: 'host', label: 'IP address', type: 'text', required: true },
          { key: 'port', label: 'Port', type: 'number', placeholder: '8009' },
        ],
      },
    ],
  },
  {
    id: 'sonos', name: 'Sonos', icon: 'speaker_group', kind: 'Local', apply: 'hot',
    description: 'Sonos speakers over your network.',
    fields: [{ key: 'hosts', label: 'Speaker addresses', type: 'text', multiple: true, placeholder: 'optional: 10.0.0.20, 10.0.0.21', help: 'Leave empty to find them automatically.' }],
  },
  {
    id: 'airplay', name: 'AirPlay (OwnTone)', icon: 'airplay', kind: 'Local', apply: 'hot', testable: true,
    description: 'Play to Apple TV, HomePod and AirPlay speakers through an OwnTone server.',
    fields: [
      { key: 'url', label: 'OwnTone address', type: 'text', required: true, placeholder: 'http://localhost:3689' },
      {
        key: 'rooms', label: 'Rooms', type: 'list', shape: 'map', mapKey: 'name', mapValue: 'room', addLabel: 'Add speaker',
        item: [{ key: 'name', label: 'AirPlay name', type: 'text', required: true, placeholder: 'Apple TV' }, room()],
      },
    ],
  },
  {
    id: 'aircast', name: 'AirPlay to Cast speakers', icon: 'airplay', kind: 'Local', apply: 'restart',
    description: 'Your Cast speakers and groups show up in AirPlay on iPhone and Mac.',
    fields: [
      { key: 'binary', label: 'aircast program', type: 'text', required: true, placeholder: '/opt/airconnect/aircast-linux-x86_64' },
      { key: 'bind', label: 'Network interface', type: 'text', placeholder: 'optional, e.g. eth0' },
      { key: 'exclude', label: 'Leave out', type: 'text', multiple: true, placeholder: 'optional: Bedroom Oled' },
    ],
  },
  {
    id: 'goodwe', name: 'GoodWe solar', icon: 'solar_power', kind: 'Local', apply: 'hot', testable: true,
    description: 'Your inverter over Modbus, for the Energy screen.',
    fields: [
      { key: 'host', label: 'Inverter IP address', type: 'text', required: true, placeholder: '10.10.30.50' },
      { key: 'port', label: 'Port', type: 'number', placeholder: '502' },
      { key: 'unit', label: 'Modbus unit', type: 'number', placeholder: '247' },
      room('Room', false),
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Solar inverter' },
    ],
  },
  {
    id: 'matter', name: 'Matter devices', icon: 'hub', kind: 'Local', apply: 'hot',
    description: 'Add Matter lights and plugs with their pairing code.',
    fields: [],
    actions: [{
      id: 'commission', label: 'Add a device', icon: 'add_link', method: 'POST', path: '/api/integrations/matter/commission',
      help: 'For a device already in Google Home or Apple Home, turn on pairing mode there first to get a new code.',
      fields: [
        { key: 'code', label: 'Pairing code', type: 'text', required: true, placeholder: '3497-011-2332 or MT:…' },
        room('Room', false),
        { key: 'name', label: 'Name', type: 'text', placeholder: 'optional' },
      ],
    }],
  },
  {
    id: 'vesync', name: 'Levoit (VeSync)', icon: 'air_purifier', kind: 'Cloud', apply: 'hot', testable: true,
    description: 'Levoit air purifiers through your VeSync account.',
    fields: [
      { key: 'email', label: 'VeSync email', type: 'text', required: true, placeholder: 'you@example.com' },
      { key: 'password', label: 'Password', type: 'password', required: true },
      { key: 'region', label: 'Region', type: 'select', options: [{ value: 'us', label: 'US, Australia, Asia' }, { value: 'eu', label: 'Europe' }] },
      {
        key: 'devices', label: 'Rooms', type: 'list', shape: 'map', mapKey: 'name', addLabel: 'Add purifier',
        help: 'Which room each purifier is in, by its name in the VeSync app.',
        item: [{ key: 'name', label: 'Purifier name', type: 'text', required: true, placeholder: 'Bedroom Purifier' }, room(), optId],
      },
    ],
  },
  {
    id: 'samsungtv', name: 'Samsung TV', icon: 'tv', kind: 'Local', apply: 'hot', testable: true,
    description: 'Samsung smart TVs (2016 and later). The TV asks to allow Kova once.',
    fields: [{
      key: 'tvs', label: 'TVs', type: 'list', addLabel: 'Add TV', required: true,
      item: [
        { key: 'host', label: 'IP address', type: 'text', required: true, placeholder: '10.10.30.40' },
        { key: 'mac', label: 'MAC address', type: 'text', placeholder: 'for turning it on: a0:d7:f3:11:22:33' },
        room(),
        { key: 'name', label: 'Name', type: 'text', placeholder: 'optional' },
        optId,
      ],
    }],
  },
  {
    id: 'ecovacs', name: 'Ecovacs DEEBOT', icon: 'cleaning_services', kind: 'Cloud', apply: 'restart', planned: true, testable: true,
    description: 'DEEBOT robot vacuums through your Ecovacs account.',
    fields: [
      { key: 'email', label: 'Ecovacs email', type: 'text', required: true, placeholder: 'you@example.com' },
      { key: 'password', label: 'Password', type: 'password', required: true },
      { key: 'country', label: 'Country', type: 'text', placeholder: 'au' },
    ],
  },
  {
    id: 'nest', name: 'Google Nest', icon: 'videocam', kind: 'Cloud', apply: 'restart', planned: true,
    description: 'Nest cameras and doorbells through Google’s Device Access.',
    fields: [
      { key: 'projectId', label: 'Device Access project id', type: 'text', required: true },
      { key: 'clientId', label: 'OAuth client id', type: 'text', required: true },
      { key: 'clientSecret', label: 'OAuth client secret', type: 'password', required: true },
      { key: 'subscription', label: 'Pub/Sub subscription', type: 'text', placeholder: 'projects/…/subscriptions/…', help: 'For camera and doorbell events.' },
    ],
    actions: [
      { id: 'link', label: 'Link Google account', icon: 'link', method: 'GET', path: '/api/integrations/nest/auth-url', opensUrl: true, help: 'Save first. Sign in with Google, then paste the code you get back below.' },
      { id: 'code', label: 'Finish linking', icon: 'key', method: 'POST', path: '/api/integrations/nest/auth-code', fields: [{ key: 'code', label: 'Code from Google', type: 'text', required: true }] },
    ],
  },
  {
    id: 'homekit', name: 'HomeKit devices', icon: 'home_iot_device', kind: 'Local', apply: 'restart', planned: true,
    description: 'Control HomeKit accessories on your network directly.',
    fields: [],
    actions: [
      { id: 'discover', label: 'Find accessories', icon: 'search', method: 'POST', path: '/api/integrations/homekit-devices/discover' },
      {
        id: 'pair', label: 'Pair', icon: 'add_link', method: 'POST', path: '/api/integrations/homekit-devices/pair',
        help: 'Remove it from Apple Home first: an accessory pairs with one controller at a time.',
        fields: [{ key: 'id', label: 'Accessory id', type: 'text', required: true }, { key: 'code', label: 'Setup code', type: 'text', required: true, placeholder: '123-45-678' }],
      },
    ],
  },
  {
    id: 'homekitBridge', name: 'Apple Home bridge', icon: 'home', kind: 'Local', apply: 'restart',
    description: 'Your Kova lights, plugs and overlays appear in the Home app and Siri.',
    fields: [{ key: 'port', label: 'Port', type: 'number', placeholder: '51826', help: 'Only change this if something else uses the port.' }],
    actions: [{ id: 'code', label: 'Show pairing code', icon: 'qr_code_2', method: 'GET', path: '/api/integrations/homekit', help: 'In the Home app: Add Accessory, then scan or type this code.' }],
  },
  {
    id: 'matterBridge', name: 'Matter bridge', icon: 'hub', kind: 'Local', apply: 'restart', planned: true,
    description: 'Share Kova devices with Google Home, Alexa and SmartThings over Matter.',
    fields: [],
    actions: [{ id: 'code', label: 'Show pairing code', icon: 'qr_code_2', method: 'GET', path: '/api/integrations/matter-bridge' }],
  },
  {
    id: 'presence', name: 'Presence', icon: 'person_pin_circle', kind: 'Local', apply: 'restart', planned: true,
    description: 'Who’s home, from phones on your Wi-Fi and phone automations.',
    fields: [
      { key: 'opnsense.url', label: 'OPNsense address', type: 'text', placeholder: 'https://10.10.0.1' },
      { key: 'opnsense.key', label: 'OPNsense API key', type: 'password' },
      { key: 'opnsense.secret', label: 'OPNsense API secret', type: 'password' },
      {
        key: 'people', label: 'Phones', type: 'list', shape: 'map', mapKey: 'person', mapValue: 'macs', addLabel: 'Add person',
        item: [
          { key: 'person', label: 'Person', type: 'select', options: 'people', required: true },
          { key: 'macs', label: 'Phone MAC addresses', type: 'text', multiple: true, placeholder: 'aa:bb:cc:dd:ee:ff' },
        ],
      },
      { key: 'awayAfterMin', label: 'Away after (minutes)', type: 'number', placeholder: '10', help: 'How long a phone has to be gone before its owner counts as away.' },
    ],
    actions: [{ id: 'setup', label: 'Phone shortcut links', icon: 'phone_iphone', method: 'GET', path: '/api/presence/setup', help: 'Use these in an iOS Shortcut or Android automation for arriving and leaving.' }],
  },
  {
    id: 'notify', name: 'Notifications', icon: 'notifications', kind: 'Cloud', apply: 'restart', planned: true,
    description: 'Doorbell and camera alerts on your phone through ntfy.',
    fields: [
      { key: 'ntfy.url', label: 'ntfy server', type: 'text', placeholder: 'https://ntfy.sh' },
      { key: 'ntfy.topic', label: 'Topic', type: 'text', required: true, placeholder: 'kova-home-7f3a' },
      { key: 'ntfy.token', label: 'Access token', type: 'password', placeholder: 'optional' },
    ],
    actions: [{ id: 'test', label: 'Send a test', icon: 'send', method: 'POST', path: '/api/push/test' }],
  },
];

export const catalogItem = (id: string) => CATALOG.find(c => c.id === id);

/** Sections of the Integrations type with no catalog entry. Always empty; the tests check it. */
export const missingFromCatalog = (): (keyof Integrations)[] => INTEGRATION_SECTIONS.filter(s => !catalogItem(s));

// ------------------------------------------------------------- values --

export function getPath(o: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => v != null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined, o);
}

const blank = (v: unknown) => v == null || v === '' || (Array.isArray(v) && !v.length);

export interface HomeRefs { rooms: string[]; people: string[] }

/**
 * Check a section against its fields. Returns the problems as sentences
 * ("Tuya device 2: Local key is required"); empty when it's fine.
 */
export function validateSection(item: CatalogItem, value: unknown, home?: HomeRefs): string[] {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return [`${item.name}: settings must be an object`];
  const errs: string[] = [];
  checkFields(item.fields, value as Record<string, unknown>, item.name, errs, home);
  if (item.id === 'tapo') {
    const v = value as { username?: string; password?: string; authHash?: string };
    if (!v.authHash && !(v.username && v.password)) errs.push('TP-Link Tapo: enter your TP-Link email and password (or the Home Assistant hash)');
  }
  if (item.id === 'tuya') {
    for (const [i, d] of ((value as { devices?: { key?: string }[] }).devices ?? []).entries()) {
      if (typeof d?.key === 'string' && d.key && d.key.length !== 16) errs.push(`Device ${i + 1}: Local key must be 16 characters`);
    }
  }
  return errs;
}

function checkFields(fields: Field[], obj: Record<string, unknown>, where: string, errs: string[], home?: HomeRefs): void {
  for (const f of fields) {
    const v = getPath(obj, f.key);
    if (blank(v)) { if (f.required) errs.push(`${where}: ${f.label} is required`); continue; }
    switch (f.type) {
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${where}: ${f.label} must be a number`);
        break;
      case 'text': case 'password':
        if (f.multiple ? !Array.isArray(v) || v.some(x => typeof x !== 'string') : typeof v !== 'string') errs.push(`${where}: ${f.label} must be ${f.multiple ? 'a list of text' : 'text'}`);
        break;
      case 'select': {
        const opts = f.options === 'rooms' ? home?.rooms : f.options === 'people' ? home?.people : f.options?.map(o => o.value);
        if (typeof v !== 'string') errs.push(`${where}: ${f.label} must be text`);
        else if (opts && !opts.includes(v)) errs.push(`${where}: ${f.label} "${v}" isn’t one of ${f.options === 'rooms' ? 'your rooms' : f.options === 'people' ? 'the people in this home' : opts.join(', ')}`);
        break;
      }
      case 'list':
        checkList(f, v, where, errs, home);
        break;
    }
  }
}

function checkList(f: Field, v: unknown, where: string, errs: string[], home?: HomeRefs): void {
  const rows = listRows(f, v);
  if (!rows) { errs.push(`${where}: ${f.label} must be a ${f.shape === 'map' ? 'set of named entries' : 'list'}`); return; }
  const noun = (f.item?.length && f.addLabel?.replace(/^Add /, '')) || 'row';
  rows.forEach((r, i) => {
    if (r == null || typeof r !== 'object') { errs.push(`${where}: ${f.label} ${i + 1} is empty`); return; }
    checkFields(f.item ?? [], r, `${noun[0].toUpperCase()}${noun.slice(1)} ${i + 1}`, errs, home);
  });
}

/** A list field's rows as objects, whether it's stored as an array or a map. Null when the shape is wrong. */
export function listRows(f: Field, v: unknown): Record<string, unknown>[] | null {
  if (f.shape === 'map') {
    if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
    return Object.entries(v as Record<string, unknown>).map(([k, x]) => {
      const key = f.item?.find(i => i.key === f.mapKey)?.type === 'number' && k.trim() !== '' && Number.isFinite(Number(k)) ? Number(k) : k;
      return f.mapValue ? { [f.mapKey!]: key, [f.mapValue]: x } : { ...(x as object), [f.mapKey!]: key };
    });
  }
  return Array.isArray(v) ? v as Record<string, unknown>[] : null;
}
