import { useState } from 'react';
import { View } from 'react-native';
import { C, SP, alpha } from '../theme';
import { useHub } from '../state/hub';
import { describeHubUpdate, type HubUpdate } from '../logic/integrations';
import { describeUpdate, notesBetween } from '../logic/ota';
import { ago, historyRows, hubProgress } from '../logic/updates';
import { applyAppUpdate, checkForAppUpdate, running, useAppUpdate } from '../native/updates';
import { Icon } from '../ui/Icon';
import { Button, Card, IconWell, Sheet, Spinner, SwitchRow } from '../ui/kit';
import { T } from '../ui/Text';
import { Input } from './IntegrationFields';
import appVersion from '../version.json';

const TONE = { ok: C.green, ready: C.amber, busy: C.stone, error: C.red, muted: C.stone } as const;
const HIST = { ok: C.green, warn: C.amber, error: C.red } as const;

/** Kova on the hub: what's running, what's out and what it brings, Update now (with progress), Check now, overnight updates, the licence, and what happened before. */
function HubUpdateCard({ u }: { u: HubUpdate }) {
  const { act, api, say } = useHub();
  const now = Date.now();
  const d = describeHubUpdate(u, now);
  const progress = hubProgress(u);
  const history = historyRows(u, now);
  const [keyOpen, setKeyOpen] = useState(false);
  const [key, setKey] = useState('');
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const ready = d.tone === 'ready';
  return (
    <Card tint={ready ? C.blue : undefined} style={{ overflow: 'hidden' }}>
      <View style={{ padding: SP[4], gap: SP[3] }}>
        <T v="eyebrow" color={C.stone2}>Kova on your hub</T>
        <View style={{ flexDirection: 'row', gap: SP[3], alignItems: 'flex-start' }} accessibilityLiveRegion="polite">
          {progress ? (
            <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: alpha(C.blue, 0.14), alignItems: 'center', justifyContent: 'center' }}><Spinner color={C.blue} /></View>
          ) : <IconWell icon={ready ? 'cloud_download' : d.tone === 'error' ? 'cloud_off' : 'check_circle'} color={ready ? C.blue : d.tone === 'error' ? C.red : C.green} size={40} fill={!ready} />}
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T v="headline">{d.title}</T>
            <T v="footnote" color={C.stone}>{progress ?? d.sub}</T>
          </View>
        </View>
        {d.changes.length ? (
          <View style={{ gap: 4, paddingTop: SP[3], borderTopWidth: 1, borderTopColor: C.hairline }}>
            <T v="eyebrow" color={C.stone2}>{`What’s new in ${u.available?.version ?? ''}`}</T>
            {d.changes.map((c, i) => <T key={i} v="footnote" color={C.bone2}>{`· ${c}`}</T>)}
          </View>
        ) : null}
        {d.canUpdate || d.canCheck || d.licence ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
            {d.canUpdate ? <Button size="sm" kind="blue" icon="restart_alt" label="Update now" onPress={() => setConfirm(true)} /> : null}
            {d.canCheck ? <Button size="sm" kind="secondary" icon="refresh" label="Check now" busy={u.state === 'checking'} onPress={() => act('POST', '/api/update/check', {}, 'Looking for a newer Kova')} /> : null}
            {d.licence ? <Button size="sm" kind={d.licenceWarn ? 'ghost' : 'secondary'} icon="key" label={d.licence} onPress={() => { setKey(''); setKeyErr(null); setKeyOpen(true); }} /> : null}
          </View>
        ) : null}
        <T mono size={11} color={C.stone2}>{`Running ${u.current.version} · checked ${ago(u.checkedAt, now)}`}</T>
      </View>
      {u.updater ? (
        <SwitchRow icon="nightlight" iconFg={C.blue} title="Update overnight" sub={d.auto} on={u.auto.on}
          onChange={on => void act('PUT', '/api/update/settings', { on }, on ? 'Kova updates itself overnight when one is waiting' : 'Overnight updates off')} />
      ) : null}
      {history.length ? (
        <View style={{ padding: SP[4], gap: SP[3], borderTopWidth: 1, borderTopColor: C.hairline }}>
          <T v="eyebrow" color={C.stone2}>History</T>
          {history.map(h => (
            <View key={h.key} style={{ flexDirection: 'row', gap: SP[3], alignItems: 'flex-start' }}>
              <Icon name={h.icon} size={18} color={HIST[h.tone]} style={{ marginTop: 1 }} />
              <View style={{ flex: 1, gap: 1 }}>
                <T v="callout" weight={600}>{h.title}</T>
                <T v="footnote" color={C.stone}>{h.sub}</T>
              </View>
            </View>
          ))}
        </View>
      ) : null}
      <Sheet open={confirm} onClose={() => setConfirm(false)} label="Update Kova">
        <View style={{ gap: SP[4] }}>
          <T v="title" size={20}>{`Update to Kova ${u.available?.version ?? ''}?`}</T>
          <T v="callout" color={C.stone}>The hub backs everything up first, then restarts. Your home is unreachable for a minute or two; this app reconnects by itself. If the new version doesn’t start properly, it goes back on its own.</T>
          <Button full kind="blue" icon="restart_alt" label="Update now" onPress={async () => { const ok = await act('POST', '/api/update/apply', {}, 'Updating: Kova restarts in a minute, then reconnects'); if (ok) setConfirm(false); return ok; }} />
          <Button full kind="ghost" label="Not now" onPress={() => setConfirm(false)} />
        </View>
      </Sheet>
      <Sheet open={keyOpen} onClose={() => setKeyOpen(false)} label="Licence key">
        <View style={{ gap: SP[4] }}>
          <T v="title" size={20}>Licence key</T>
          <T v="callout" color={C.stone}>{`The Kova licence key from ClickBit, issued for hub ID ${u.licence?.hubId ?? ''}. Updates come from ClickBit’s releases once it’s activated.`}</T>
          <Input label="Licence key" value={key} onChange={setKey} placeholder="KOVA-…" mono autoFocus bad={!!keyErr} />
          {keyErr ? <T v="footnote" weight={600} color={C.redText}>{keyErr}</T> : null}
          <Button full icon="key" label="Activate" onPress={async () => {
            if (!key.trim()) { setKeyErr('Enter the key'); return false; }
            try { await api('PUT', '/api/update/licence', { key: key.trim() }); setKeyOpen(false); say('Licence activated: looking for a newer Kova'); return true; } catch (e) { setKeyErr((e as Error).message); return false; }
          }} />
        </View>
      </Sheet>
    </Card>
  );
}

/** This app: what's running, whether the hub has something newer for it, check now, restart into it, and what's new. */
function AppUpdateCard() {
  const u = useAppUpdate();
  const d = describeUpdate(u, running.version);
  const fg = TONE[d.tone];
  const notes = u.state === 'ready' ? (u.notes ?? notesBetween(appVersion.history, running.version, u.version)) : appVersion.history.slice(0, 1);
  return (
    <Card tint={u.state === 'ready' ? C.amber : undefined} style={{ padding: SP[4], gap: SP[3] }}>
      <T v="eyebrow" color={C.stone2}>This app</T>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SP[3] }} accessibilityLiveRegion="polite">
        <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: alpha(fg, 0.14), alignItems: 'center', justifyContent: 'center' }}>
          {u.state === 'checking' ? <Spinner color={C.bone} /> : <Icon name={u.state === 'ready' ? 'cloud_download' : u.state === 'current' ? 'check_circle' : u.state === 'unreachable' ? 'cloud_off' : 'cloud'} size={21} color={fg} fill={u.state === 'current' || u.state === 'ready'} />}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T v="headline">{d.title}</T>
          <T v="footnote" color={u.state === 'unreachable' ? C.redText : C.stone}>{d.sub}</T>
        </View>
      </View>
      {notes.length ? (
        <View style={{ gap: SP[2], paddingTop: SP[3], borderTopWidth: 1, borderTopColor: C.hairline }}>
          <T v="eyebrow" color={C.stone2}>{u.state === 'ready' ? 'What’s new' : `In Kova ${running.version}`}</T>
          {notes.slice(0, 3).map(n => (
            <View key={n.version} style={{ flexDirection: 'row', gap: SP[2] }}>
              {u.state === 'ready' ? <T mono size={11.5} color={C.amber} style={{ paddingTop: 2 }}>{n.version}</T> : <Icon name="auto_awesome" size={15} color={C.stone2} style={{ marginTop: 2 }} />}
              <T v="footnote" color={C.bone2} style={{ flex: 1 }}>{n.title}</T>
            </View>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: SP[2], flexWrap: 'wrap' }}>
        {u.state === 'ready' ? <Button size="sm" icon="restart_alt" label="Restart to update" onPress={() => applyAppUpdate()} /> : null}
        {u.state !== 'unsupported' && u.state !== 'ready' ? (
          <Button size="sm" kind="secondary" icon="refresh" label="Check now" busy={u.state === 'checking'} onPress={() => checkForAppUpdate(true).then(c => c.state !== 'unreachable')} />
        ) : null}
      </View>
      <T mono size={11} color={C.stone2}>{`App ${running.version} · ${running.train}${u.at ? ` · checked ${ago(u.at, Date.now())}` : ''}`}</T>
    </Card>
  );
}

/** Settings → Software update: Kova on the hub, and this app beside it. Updating Kova isn't an integration. */
export function SoftwareUpdate({ hub }: { hub: HubUpdate | null | undefined }) {
  return (
    <View style={{ gap: SP[2] }}>
      <T v="overline" color={C.stone2} style={{ paddingHorizontal: 4 }}>Software update</T>
      {hub ? <HubUpdateCard u={hub} /> : (
        <Card style={{ padding: SP[4], flexDirection: 'row', gap: SP[3], alignItems: 'flex-start' }}>
          <IconWell icon="cloud_off" color={C.stone} size={40} />
          <View style={{ flex: 1, gap: 2 }}>
            <T v="headline">Kova on your hub</T>
            <T v="footnote" color={C.stone}>This hub doesn’t update itself: it has no updater. Run deploy/update.sh on it once.</T>
          </View>
        </Card>
      )}
      <AppUpdateCard />
    </View>
  );
}
