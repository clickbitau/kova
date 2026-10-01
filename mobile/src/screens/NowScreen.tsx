import { View } from 'react-native';
import { C, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useSheet } from '../state/sheet';
import { useNav } from '../navigation';
import { devs, favourites, isLight, toggleCommand, type Dev } from '../logic/devices';
import { Icon } from '../ui/Icon';
import { HScroll, Mark, Press, SectionTitle } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Appear } from '../ui/motion';
import { TileGrid } from '../ui/Tile';

/** "Wednesday 30 Sept" → "Wed 30 Sep", as in the phone design. */
const shortDate = (d: string) => d.replace(/^(\w{3})\w*/, '$1').replace(/\bSept\b/, 'Sep');

export function NowScreen() {
  const s = useSnap();
  const { send, act, api, say } = useHub();
  const sheet = useSheet();
  const nav = useNav();
  const all = devs(s);
  const modeById = (id: string | null) => s.modes.find(m => m.id === id) ?? s.modes[0];
  const M = modeById(s.current.modeId), next = modeById(s.current.nextId);
  const on = s.devices.filter(d => isLight(d) && d.state.on).length;
  const home = s.people.filter(p => p.home);
  const w = s.weather;
  const ov = s.current.overlay;
  const favs = favourites(s, all);
  const happened = s.activity.filter(a => a.type === 'auto' || a.type === 'people').slice(0, 3);
  const tap = (d: Dev) => { const c = toggleCommand(d, s.sources); if (c) void send(d.id, c); else sheet.open(d.id); };

  return (
    <Screen glow={M?.color}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Mark size={22} />
          <T size={13} weight={700} color={C.stone}>{s.home.name}</T>
        </View>
        <View style={{ flexDirection: 'row' }}>
          {(home.length ? home : s.people).slice(0, 3).map((p, i) => (
            <View key={p.id} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: C.selected, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: C.page, marginLeft: i ? -9 : 0, opacity: p.home ? 1 : 0.4 }}>
              <T size={12} weight={800}>{p.name[0]}</T>
            </View>
          ))}
        </View>
      </View>

      <View style={{ gap: 6 }}>
        <T size={13} color={C.stone}>{`${shortDate(s.home.dateLabel)} · ${s.home.clock}${w ? ` · ${w.temp}° ${w.text.toLowerCase()}` : ''}`}</T>
        <Press onPress={() => nav.navigate('Modes')} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start' }}>
          <Icon name={M?.icon ?? 'routine'} size={34} color={M?.color} fill />
          <T size={38} weight={700} tracking={-0.03}>{M?.name ?? ''}</T>
          <Icon name="chevron_right" size={26} color={C.stone3} />
        </Press>
        <T size={14} color={C.soft}>{`Until ${s.current.untilLabel}, then ${next?.name ?? ''} · ${on} light${on === 1 ? '' : 's'} on`}</T>
        {ov ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingRight: 6, paddingLeft: 12, borderRadius: 12, backgroundColor: C.inset, alignSelf: 'flex-start', marginTop: 4 }}>
            <Icon name={ov.icon} size={17} color={C.amber} fill />
            <T size={12.5} weight={600}>{`${ov.name} · ${ov.endsLabel.toLowerCase()}`}</T>
            <Press onPress={() => void api('POST', '/api/overlays/end').then(() => say(`Back to ${M?.name}`)).catch(e => say((e as Error).message, { error: true }))} style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.08)' }}>
              <T size={12} weight={700}>End</T>
            </Press>
          </View>
        ) : null}
      </View>

      <View style={{ gap: 8 }}>
        <View style={{ height: 30, borderRadius: 9, overflow: 'hidden', flexDirection: 'row' }}>
          {s.day.bands.map((b, i) => {
            const m = modeById(b.modeId);
            return <View key={i} style={{ height: '100%', width: `${((b.end - b.start) / 24) * 100}%`, backgroundColor: alpha(m?.color ?? C.stone, b.modeId === s.current.modeId ? 0.33 : 0.165) }} />;
          })}
          <View style={{ position: 'absolute', left: `${(s.home.nowHour / 24) * 100}%`, top: 0, bottom: 0, width: 2, backgroundColor: '#fff' }} />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {['00', '06', '12', '18', '24'].map(h => <T key={h} mono size={10} color={C.stone3}>{h}</T>)}
        </View>
      </View>

      {s.upcoming.length ? (
        <View style={{ gap: 10 }}>
          <SectionTitle>Coming up</SectionTitle>
          <HScroll gap={10}>
            {s.upcoming.map((u, i) => {
              const color = modeById(u.modeId)?.color ?? C.stone;
              return (
                <Appear key={u.id} index={i} style={{ width: 200, borderRadius: 16, padding: 14, backgroundColor: C.card, gap: 8, opacity: u.skipped ? 0.55 : 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
                    <T mono size={12} color={color}>{u.t}</T>
                  </View>
                  <T size={14} weight={700} style={u.skipped ? { textDecorationLine: 'line-through' } : null}>{u.label}</T>
                  <T size={12} color={C.stone} lineHeight={1.35}>{u.skipped ? 'Skipped tonight' : u.what}</T>
                  <Press onPress={() => void api('POST', '/api/plan/skip', { id: u.id, skip: !u.skipped }).catch(e => say((e as Error).message, { error: true }))} style={{ paddingVertical: 7, paddingHorizontal: 10, borderRadius: 9, backgroundColor: C.control2, alignSelf: 'flex-start' }}>
                    <T size={12} weight={700}>{u.skipped ? 'Undo' : 'Skip tonight'}</T>
                  </Press>
                </Appear>
              );
            })}
          </HScroll>
        </View>
      ) : null}

      {favs.length ? (
        <View style={{ gap: 10 }}>
          <SectionTitle>Favourites</SectionTitle>
          <TileGrid items={favs} onToggle={tap} onOpen={d => sheet.open(d.id)} />
        </View>
      ) : null}

      {s.overlays.length ? (
        <View style={{ gap: 10 }}>
          <SectionTitle>Switch the home to</SectionTitle>
          <HScroll gap={8}>
            {s.overlays.map(o => {
              const a = ov?.id === o.id;
              return (
                <Press key={o.id}
                  onPress={() => a ? void api('POST', '/api/overlays/end').then(() => say(`Back to ${M?.name}`)) : void act('POST', `/api/overlays/${encodeURIComponent(o.id)}/start`, {}, `${o.name} is on`)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 14, backgroundColor: a ? 'rgba(242,177,76,0.12)' : C.card, borderWidth: 1, borderColor: a ? 'rgba(242,177,76,0.45)' : C.hairline }}>
                  <Icon name={o.icon} size={19} color={C.amber} fill />
                  <T size={13.5} weight={700}>{o.name}</T>
                </Press>
              );
            })}
          </HScroll>
        </View>
      ) : null}

      {s.findings.length ? (
        <Press onPress={() => nav.navigate('Modes')} style={{ borderRadius: 16, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Icon name="fact_check" size={22} color={C.green} />
          <View style={{ flex: 1, gap: 2 }}>
            <T size={14} weight={700}>{`${s.findings.length} thing${s.findings.length === 1 ? '' : 's'} worth a look`}</T>
            <T size={12} color={C.stone}>Kova replayed your modes on the last 14 days</T>
          </View>
          <Icon name="chevron_right" size={20} color={C.stone} />
        </Press>
      ) : null}

      <View style={{ gap: 6 }}>
        <SectionTitle right={<Press onPress={() => nav.navigate('Activity')} hitSlop={12}><T size={13} weight={600} color={C.amber}>See all</T></Press>}>Just happened</SectionTitle>
        {happened.map((h, i) => (
          <Appear key={h.id} index={i} style={{ flexDirection: 'row', gap: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.hairline }}>
            <T mono size={12} color={C.stone} style={{ width: 38, paddingTop: 1 }}>{h.t}</T>
            <View style={{ flex: 1, gap: 2 }}>
              <T size={13.5} weight={600}>{h.what}</T>
              {h.why ? <T size={12} color={C.stone}>{`↳ ${h.why}`}</T> : null}
            </View>
          </Appear>
        ))}
      </View>
    </Screen>
  );
}
