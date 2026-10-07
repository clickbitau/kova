import { useState } from 'react';
import { View } from 'react-native';
import { C, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useIntegrationSetup } from '../state/integrations';
import { useNav } from '../navigation';
import { addable, entries, type Entry } from '../logic/integrations';
import { Icon } from '../ui/Icon';
import { Button, Card, Empty, Group, IconButton, IconWell, Press, Segmented, Skeleton, Tag } from '../ui/kit';
import { Appear, animateLayout } from '../ui/motion';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { SearchField } from './DevicesScreen';

/** One integration in the list: its icon, name, how it's doing and how many devices, Local or Cloud. */
function EntryRow({ e, first, onPress }: { e: Entry; first?: boolean; onPress: () => void }) {
  const tone = e.ok ? C.green : e.idle ? C.amber : C.red;
  const sub = e.ok || !e.idle ? `${e.note}${e.devices ? ` · ${e.devices} device${e.devices === 1 ? '' : 's'}` : ''}` : e.note;
  return (
    <Press onPress={onPress} give="soft" label={`${e.name}, ${sub}, ${e.kind}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 66, paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: first ? 0 : 1, borderTopColor: C.hairline }}>
      <View>
        <IconWell icon={e.icon} color={e.ok ? C.bone : tone} bg={e.ok ? C.selected : undefined} size={38} />
        <View style={{ position: 'absolute', right: -2, bottom: -2, width: 11, height: 11, borderRadius: 6, backgroundColor: tone, borderWidth: 2, borderColor: C.card }} />
      </View>
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <T v="headline" numberOfLines={1}>{e.name}</T>
        <T v="footnote" color={e.ok ? C.stone : e.idle ? C.amber : C.redText} numberOfLines={2}>{sub}</T>
      </View>
      <View style={{ alignSelf: 'center' }}><Tag text={e.kind} color={e.kind === 'Cloud' ? C.blue : C.stone} /></View>
      <Icon name="chevron_right" size={20} color={C.stone2} />
    </Press>
  );
}

function ListSkeleton() {
  return (
    <Card style={{ overflow: 'hidden' }}>
      {[0, 1, 2, 3].map(i => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 66, paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
          <Skeleton w={38} h={38} r={12} />
          <View style={{ flex: 1, gap: 6 }}><Skeleton w="55%" h={13} /><Skeleton w="35%" h={11} /></View>
          <Skeleton w={44} h={20} r={R.full} />
        </View>
      ))}
    </Card>
  );
}

/** More → Integrations: what's connected (what needs attention first), and Add integration. Kova's own updates are in Settings. */
export function IntegrationsScreen() {
  const s = useSnap();
  const nav = useNav();
  const { refresh } = useHub();
  const setup = useIntegrationSetup();
  const [pulling, setPulling] = useState(false);
  const list = entries(s.integrations, setup.config, setup.catalog);
  const attention = list.filter(e => !e.ok);
  const fine = list.filter(e => e.ok);
  const waiting = !setup.catalog && !setup.error;
  const open = (id: string) => nav.navigate('Integration', { id });
  const pull = () => { setPulling(true); void Promise.all([refresh(), setup.reload()]).finally(() => setPulling(false)); };
  return (
    <Screen title="Integrations" over={s.home.name} onBack={() => nav.goBack()} gap={SP[6]} onRefresh={pull} refreshing={pulling}
      right={<View style={{ paddingBottom: 4 }}><IconButton icon="add" label="Add integration" tone="amber" onPress={() => nav.navigate('IntegrationAdd')} /></View>}>
      {setup.error ? (
        <Card tint={C.red} style={{ padding: SP[4], gap: SP[3] }}>
          <View style={{ flexDirection: 'row', gap: SP[3], alignItems: 'center' }}>
            <Icon name="cloud_off" size={20} color={C.redText} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="headline" color={C.redText}>Couldn’t load the settings</T>
              <T v="footnote" color={C.redText}>{setup.error}</T>
            </View>
          </View>
          <Button size="sm" kind="secondary" icon="refresh" label="Try again" onPress={() => setup.reload()} />
        </Card>
      ) : null}

      {waiting ? <ListSkeleton /> : (
        <>
          {attention.length ? (
            <Appear>
              <Group title={`Needs attention · ${attention.length}`}>
                {attention.map((e, i) => <EntryRow key={e.id} e={e} first={i === 0} onPress={() => open(e.id)} />)}
              </Group>
            </Appear>
          ) : null}
          {fine.length ? (
            <Appear index={1}>
              <Group title={`Connected · ${fine.length}`}>
                {fine.map((e, i) => <EntryRow key={e.id} e={e} first={i === 0} onPress={() => open(e.id)} />)}
              </Group>
            </Appear>
          ) : null}
          {!list.length ? (
            <Empty icon="hub" tone={C.amber} title="Nothing connected yet" text="Integrations bring in your lights, speakers, cameras and accounts. Add the first one." action="Add integration" onAction={() => nav.navigate('IntegrationAdd')} />
          ) : (
            <Button kind="secondary" full icon="add" label="Add integration" onPress={() => nav.navigate('IntegrationAdd')} />
          )}
        </>
      )}

    </Screen>
  );
}

const KINDS = [{ id: 'all', label: 'All' }, { id: 'Local', label: 'Local' }, { id: 'Cloud', label: 'Cloud' }];

/** Add integration: everything in the catalog that isn't set up yet, searchable, with what each one brings. */
export function IntegrationAddScreen() {
  const s = useSnap();
  const nav = useNav();
  const setup = useIntegrationSetup();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const all = setup.catalog ? addable(setup.catalog, setup.config, s.integrations) : [];
  const shown = setup.catalog ? addable(setup.catalog, setup.config, s.integrations, q).filter(c => kind === 'all' || c.kind === kind) : [];
  return (
    <Screen title="Add integration" over={setup.catalog ? `${all.length} available` : ' '} onBack={() => nav.goBack()} gap={SP[4]} onRefresh={() => void setup.reload()} refreshing={setup.loading && !!setup.catalog}>
      <View style={{ gap: SP[3] }}>
        <SearchField value={q} onChange={v => { animateLayout(); setQ(v); }} placeholder="Search, e.g. air conditioner" />
        <Segmented compact label="Local or cloud" options={KINDS} value={kind} onChange={v => { animateLayout(); setKind(v); }} />
      </View>
      {setup.error && !setup.catalog ? (
        <Empty icon="cloud_off" tone={C.red} title="Couldn’t load the catalog" text={setup.error} action="Try again" onAction={() => void setup.reload()} />
      ) : !setup.catalog ? (
        <View style={{ gap: SP[3] }}>{[0, 1, 2, 3].map(i => <Skeleton key={i} h={96} r={R.lg} />)}</View>
      ) : shown.length ? (
        <View style={{ gap: SP[3] }}>
          {shown.map((c, i) => (
            <Appear key={c.id} index={i}>
              <Press onPress={() => nav.replace('Integration', { id: c.id })} give="soft" label={`${c.name}, ${c.kind}. ${c.description}`}
                style={{ flexDirection: 'row', gap: SP[3], padding: SP[4], borderRadius: R.lg, backgroundColor: C.card, borderWidth: 1, borderColor: C.edge, borderTopColor: C.edgeTop }}>
                <IconWell icon={c.icon} color={c.kind === 'Cloud' ? C.blue : C.amber} size={40} />
                <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
                    <T v="headline" style={{ flexShrink: 1 }} numberOfLines={1}>{c.name}</T>
                    <Tag text={c.kind} color={c.kind === 'Cloud' ? C.blue : C.stone} />
                  </View>
                  <T v="footnote" color={C.stone} numberOfLines={3}>{c.description}</T>
                </View>
                <Icon name="chevron_right" size={20} color={C.stone2} style={{ alignSelf: 'center' }} />
              </Press>
            </Appear>
          ))}
        </View>
      ) : all.length ? (
        <Empty icon="search_off" title="Nothing matches" text={q ? `Nothing called “${q}” to add.` : `No ${kind.toLowerCase()} integrations left to add.`} action="Show everything" onAction={() => { setQ(''); setKind('all'); }} />
      ) : (
        <Empty icon="check_circle" tone={C.green} title="Everything is set up" text="Every integration Kova has is already on this hub." />
      )}
      {shown.length ? <T v="footnote" color={C.stone2} center style={{ paddingTop: SP[2] }}>Local ones talk to your devices over your own network. Cloud ones go through the maker’s account.</T> : null}
    </Screen>
  );
}
