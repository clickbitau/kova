import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { C, R, SP, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useSheet } from '../state/sheet';
import { useNav } from '../navigation';
import type { Person, Room } from '../api/types';
import { combinedOf, combineIdeasOf, devs, ICON, type CombineIdea, type Combined } from '../logic/devices';
import { cleanName, devicesIn, favouriteList, moveStep, plural, ROOM_ICONS, roomDelete, roomRows } from '../logic/customise';
import { Icon } from '../ui/Icon';
import { Avatar, Button, Card, Empty, HScroll, IconButton, Pill, Press, Row, Section, Sheet, Tag } from '../ui/kit';
import { animateLayout } from '../ui/motion';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { FieldWithButton } from './DeviceSheet';
import { SheetHead, SpeakerGroupSheet, TextField } from './SpeakerGroupSheet';

/** "Same device twice?": a device Kova reaches through two integrations, offered as one. */
export function CombineIdeaCard({ ci }: { ci: CombineIdea }) {
  const { act } = useHub();
  return (
    <Card tint={C.amber} style={{ gap: SP[2], padding: SP[4], backgroundColor: alpha(C.amber, 0.07) }}>
      <View style={{ flexDirection: 'row', gap: SP[2], alignItems: 'flex-start' }}>
        <Icon name="join" size={20} color={C.amber} />
        <View style={{ flex: 1, gap: 2 }}>
          <T v="eyebrow" color={C.amber}>Same device twice?</T>
          <T v="headline">{ci.name}</T>
          <T v="footnote" color={C.stone}>{ci.why}</T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: SP[2], justifyContent: 'flex-end' }}>
        <Button size="sm" kind="ghost" label="Not the same" onPress={() => act('POST', `/api/findings/${encodeURIComponent(`idea:${ci.key}`)}/dismiss`, {}, 'Kept as two')} />
        <Button size="sm" label="Combine into one" onPress={() => act('POST', '/api/combined', { name: ci.name, members: ci.members }, `${ci.name} is one device now`)} />
      </View>
    </Card>
  );
}

/** A small round arrow for moving something up or down a list. */
function Mover({ dir, onPress, disabled, name }: { dir: -1 | 1; onPress: () => void; disabled: boolean; name: string }) {
  return (
    <Press onPress={onPress} disabled={disabled} haptic="select" label={`Move ${name} ${dir < 0 ? 'up' : 'down'}`}
      style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.control2, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={dir < 0 ? 'arrow_upward' : 'arrow_downward'} size={18} color={C.bone2} />
    </Press>
  );
}

/** A room: its name and icon, and deleting it (its devices move to another room). */
function RoomSheet({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const s = useSnap();
  const { act } = useHub();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [moveTo, setMoveTo] = useState<string | null>(null);
  useEffect(() => { if (room) { setName(room.name); setIcon(room.icon); setMoveTo(null); } }, [room?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const R0 = room;
  if (!R0) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const del = roomDelete(R0.id, s.rooms, s.devices, moveTo);
  const changed = (cleanName(name) && cleanName(name) !== R0.name) || icon !== R0.icon;
  const save = async () => {
    const n = cleanName(name);
    if (!n) return false;
    const ok = await act('PUT', `/api/rooms/${encodeURIComponent(R0.id)}`, { name: n, icon }, `${n} saved`);
    if (ok) onClose();
    return ok;
  };
  const remove = async () => {
    if (del.blocked) return false;
    const ok = await act('DELETE', `/api/rooms/${encodeURIComponent(R0.id)}`, del.body, `${R0.name} deleted`);
    if (ok) onClose();
    return ok;
  };
  return (
    <Sheet open onClose={onClose} label={`${R0.name} room`}>
      <SheetHead kicker={`Room · ${plural(del.inside, 'device')}`} title={cleanName(name) || R0.name} icon={icon || R0.icon} color={C.amber} />
      <Section title="Name" caption gap={SP[2]}>
        <TextField value={name} onChange={setName} label="Room name" onSubmit={() => void save()} />
      </Section>
      <Section title="Icon" caption gap={SP[2]}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
          {ROOM_ICONS.map(i => {
            const on = i === icon;
            return (
              <Press key={i} onPress={() => setIcon(i)} haptic="select" selected={on} label={i.replace(/_/g, ' ')}
                style={{ width: '18%', flexGrow: 1, aspectRatio: 1, maxHeight: 60, borderRadius: R.md, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? C.amberTint : C.inset, borderWidth: 1, borderColor: on ? C.amberLine : C.edge }}>
                <Icon name={i} size={24} color={on ? C.amber : C.bone2} fill={on} />
              </Press>
            );
          })}
        </View>
      </Section>
      <Button full kind={changed ? 'primary' : 'secondary'} icon="check" label="Save" onPress={changed ? save : undefined} />
      <Section title="Delete this room" caption gap={SP[2]}>
        {del.inside && !del.blocked ? (
          <>
            <T v="footnote" color={C.stone}>{`Its ${plural(del.inside, 'device')} move to:`}</T>
            <HScroll>{s.rooms.filter(r => r.id !== R0.id).map(r => <Pill key={r.id} icon={r.icon} label={r.name} on={del.moveTo === r.id} onPress={() => setMoveTo(r.id)} />)}</HScroll>
          </>
        ) : null}
        {del.blocked ? <T v="footnote" color={C.stone}>{del.blocked}</T> : null}
        <Button full kind="danger" icon="delete" label={`Delete ${R0.name}`} onPress={del.blocked ? undefined : remove} />
        <T v="footnote" color={C.stone2} center>You can undo it for a few seconds afterwards.</T>
      </Section>
    </Sheet>
  );
}

/** Someone who lives here: their name, what tells Kova they're home, and removing them. */
function PersonSheet({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const { act } = useHub();
  const [name, setName] = useState('');
  const [detail, setDetail] = useState('');
  useEffect(() => { if (person) { setName(person.name); setDetail(person.detail); } }, [person?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const P = person;
  if (!P) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const changed = (cleanName(name) && cleanName(name) !== P.name) || cleanName(detail) !== P.detail;
  const save = async () => {
    const n = cleanName(name);
    if (!n) return false;
    const ok = await act('PUT', `/api/people/${encodeURIComponent(P.id)}`, { name: n, detail: cleanName(detail) }, `${n} saved`);
    if (ok) onClose();
    return ok;
  };
  const remove = async () => {
    const ok = await act('DELETE', `/api/people/${encodeURIComponent(P.id)}`, {}, `${P.name} removed`);
    if (ok) onClose();
    return ok;
  };
  return (
    <Sheet open onClose={onClose} label={P.name}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
        <Avatar name={cleanName(name) || P.name} home={P.home} size={48} ring={C.sheet} />
        <View style={{ flex: 1, gap: 2 }}>
          <T v="eyebrow" color={C.stone2}>{P.home ? 'Home' : 'Out'}</T>
          <T v="title" numberOfLines={1}>{cleanName(name) || P.name}</T>
        </View>
      </View>
      <Section title="Name" caption gap={SP[2]}>
        <TextField value={name} onChange={setName} label="Name" />
      </Section>
      <Section title="Shown under their name" caption gap={SP[2]}>
        <TextField value={detail} onChange={setDetail} label="Shown under their name" placeholder="Phone" />
        <T v="footnote" color={C.stone2}>Usually the phone that tells Kova they’re home, like “iPhone”.</T>
      </Section>
      <Button full kind={changed ? 'primary' : 'secondary'} icon="check" label="Save" onPress={changed ? save : undefined} />
      <Button full kind="danger" icon="remove_circle" label={`Remove ${P.name}`} onPress={remove} />
    </Sheet>
  );
}

/** A device made of several integrations' devices: its name, what it's made of, and separating it again. */
function CombinedSheet({ c, onClose }: { c: Combined | null; onClose: () => void }) {
  const { act } = useHub();
  const [name, setName] = useState('');
  useEffect(() => { if (c) setName(c.name); }, [c?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const n = cleanName(name, 60);
  const separate = async () => {
    const ok = await act('DELETE', `/api/combined/${encodeURIComponent(c.id)}`, {}, `${c.name} is ${c.members.length === 2 ? 'two' : c.members.length} devices again`);
    if (ok) onClose();
    return ok;
  };
  return (
    <Sheet open onClose={onClose} label={c.name}>
      <SheetHead kicker="One device, several integrations" title={n || c.name} icon="join" color={C.amber} />
      <Section title="Name" caption gap={SP[2]}>
        <FieldWithButton value={name} onChange={setName} button="Save" label="Name" show={!!n && n !== c.name}
          onSubmit={() => { if (n && n !== c.name) void act('PUT', `/api/combined/${encodeURIComponent(c.id)}`, { name: n }, `Renamed to ${n}`); }} />
      </Section>
      <Section title="Made of" caption gap={SP[2]}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {c.memberNames.map((m, i) => <Tag key={`${m}${i}`} text={m} color={C.amber} />)}
        </View>
        <T v="footnote" color={C.stone2}>Kova sends each command through whichever of them works, and hides them from lists while they’re one.</T>
      </Section>
      <Button full kind="danger" icon="call_split" label="Separate them again" onPress={separate} />
    </Sheet>
  );
}

/** A text box with an Add button beside it, for adding a room or a person. */
function AddField({ placeholder, label, onAdd }: { placeholder: string; label: string; onAdd: (name: string) => Promise<boolean> }) {
  const [v, setV] = useState('');
  return (
    <FieldWithButton value={v} onChange={setV} placeholder={placeholder} button="Add" label={label}
      onSubmit={() => { const n = cleanName(v); if (n) void onAdd(n).then(ok => { if (ok) setV(''); }); }} />
  );
}

/**
 * Customise home: the home's name, rooms (add, rename, icon, order, delete), people, devices (rename, room, hide,
 * favourites and their order), speaker groups, and devices combined from two integrations.
 */
export function CustomiseScreen() {
  const s = useSnap();
  const { act } = useHub();
  const sheet = useSheet();
  const nav = useNav();
  const all = devs(s);
  const list = Object.values(all);
  const [home, setHome] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [favOrdering, setFavOrdering] = useState(false);
  const [room, setRoom] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [combo, setCombo] = useState<string | null>(null);
  const [devRoom, setDevRoom] = useState<string>(s.rooms[0]?.id ?? 'unassigned');
  const homeDraft = home ?? s.home.name;
  const rows = roomRows(s.rooms, list);
  const favs = favouriteList(s.favourites, list);
  const hidden = list.filter(d => d.hidden).sort((a, b) => a.name.localeCompare(b.name));
  const rn = (id: string) => s.rooms.find(r => r.id === id)?.name ?? 'No room';
  const hasLoose = list.some(d => !s.rooms.some(r => r.id === d.room));
  const roomPills = [...s.rooms.map(r => ({ id: r.id, name: r.name, icon: r.icon })), ...(hasLoose ? [{ id: 'unassigned', name: 'No room', icon: 'category' }] : [])];
  const inRoom = devicesIn(list, s.rooms, devRoom);
  const ideas = combineIdeasOf(s);
  const combined = combinedOf(s);
  const settings = (id: string, body: object, done: string) => act('PATCH', `/api/devices/${encodeURIComponent(id)}/settings`, body, done);
  const moveRoom = (id: string, dir: -1 | 1) => { const ids = moveStep(s.rooms.map(r => r.id), id, dir); if (ids) { animateLayout(); void act('PUT', '/api/rooms/order', { ids }, 'Order saved'); } };
  const moveFav = (id: string, dir: -1 | 1) => { const ids = moveStep(favs.map(f => f.id), id, dir); if (ids) { animateLayout(); void act('PUT', '/api/favourites', { ids }, 'Order saved'); } };
  const saveHome = () => { const n = cleanName(homeDraft); if (n && n !== s.home.name) void act('PUT', '/api/home', { name: n }, 'Home renamed').then(ok => { if (ok) setHome(null); }); };

  return (
    <Screen title="Customise home" over={s.home.name} onBack={() => nav.goBack()} gap={SP[6]}>
      <Section title="Home name" caption gap={SP[2]}>
        <FieldWithButton value={homeDraft} onChange={setHome} button="Save" label="Home name" show={!!cleanName(homeDraft) && cleanName(homeDraft) !== s.home.name} onSubmit={saveHome} />
      </Section>

      <Section title={`Rooms · ${s.rooms.length}`} caption action={s.rooms.length > 1 ? (ordering ? 'Done' : 'Reorder') : undefined} onAction={() => { animateLayout(); setOrdering(o => !o); }} gap={SP[2]}>
        {rows.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {rows.map(({ room: r, sub }, i) => (
              <Row key={r.id} first={!i} icon={r.icon} title={r.name} sub={sub}
                onPress={ordering ? undefined : () => setRoom(r.id)}
                right={ordering ? (
                  <View style={{ flexDirection: 'row', gap: SP[2] }}>
                    <Mover dir={-1} name={r.name} disabled={!i} onPress={() => moveRoom(r.id, -1)} />
                    <Mover dir={1} name={r.name} disabled={i === rows.length - 1} onPress={() => moveRoom(r.id, 1)} />
                  </View>
                ) : undefined} />
            ))}
          </Card>
        ) : <Empty compact icon="meeting_room" title="No rooms yet" text="Add the rooms of your home, then put devices in them." />}
        <AddField placeholder="New room, e.g. Hallway" label="New room" onAdd={n => act('POST', '/api/rooms', { name: n }, `${n} added`)} />
      </Section>

      <Section title={`People · ${s.people.length}`} caption gap={SP[2]}>
        {s.people.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {s.people.map((p, i) => (
              <Press key={p.id} onPress={() => setPerson(p.id)} give="soft" label={`${p.name}, ${p.detail}`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 62, paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
                <Avatar name={p.name} home={p.home} size={36} ring={C.card} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T v="headline">{p.name}</T>
                  <T v="footnote" color={C.stone}>{`${p.detail}${p.sinceLabel ? ` · ${p.home ? 'home' : 'left'} since ${p.sinceLabel}` : ''}`}</T>
                </View>
                <Icon name="chevron_right" size={20} color={C.stone2} />
              </Press>
            ))}
          </Card>
        ) : <Empty compact icon="group" title="No one yet" text="Add the people who live here, so Kova knows who’s home." />}
        <AddField placeholder="Add someone" label="Add someone" onAdd={n => act('POST', '/api/people', { name: n }, `${n} added`)} />
        <T v="footnote" color={C.stone2} style={{ paddingHorizontal: 4 }}>Who’s home comes from their phone, the router or Warden.</T>
      </Section>

      <Section title="Favourites on Now" caption action={favs.length > 1 ? (favOrdering ? 'Done' : 'Reorder') : undefined} onAction={() => { animateLayout(); setFavOrdering(o => !o); }} gap={SP[2]}>
        {favs.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {favs.map((d, i) => (
              <Row key={d.id} first={!i} icon="star" iconFg={C.amber} fill title={d.name} sub={rn(d.room)}
                right={favOrdering ? (
                  <View style={{ flexDirection: 'row', gap: SP[2] }}>
                    <Mover dir={-1} name={d.name} disabled={!i} onPress={() => moveFav(d.id, -1)} />
                    <Mover dir={1} name={d.name} disabled={i === favs.length - 1} onPress={() => moveFav(d.id, 1)} />
                  </View>
                ) : <IconButton icon="close" label={`Remove ${d.name} from favourites`} size={36} tone="ghost" color={C.stone} onPress={() => void settings(d.id, { favourite: false }, 'Removed from favourites')} />} />
            ))}
          </Card>
        ) : <Empty compact icon="star" tone={C.amber} title="None picked yet" text="Now suggests a few until you pick. Star devices below." />}
      </Section>

      <Section title="Devices" caption gap={SP[2]}>
        <HScroll>{roomPills.map(r => <Pill key={r.id} icon={r.icon} label={r.name} count={devicesIn(list, s.rooms, r.id).length} on={devRoom === r.id} onPress={() => { animateLayout(); setDevRoom(r.id); }} />)}</HScroll>
        {inRoom.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {inRoom.map((d, i) => {
              const fav = (s.favourites ?? []).includes(d.id);
              return (
                <Row key={d.id} first={!i} icon={ICON[d.type] ?? 'devices'} iconFg={d.hidden ? C.stone2 : C.bone} title={d.name}
                  sub={[d.hidden ? 'Hidden' : null, d.integration].filter(Boolean).join(' · ')} subColor={d.hidden ? C.amber : C.stone}
                  onPress={() => sheet.open(d.id)}
                  right={<IconButton icon="star" fill={fav} color={fav ? C.amber : C.stone2} tone="ghost" size={36} label={fav ? `Remove ${d.name} from favourites` : `Add ${d.name} to favourites`}
                    onPress={() => void settings(d.id, { favourite: !fav }, fav ? 'Removed from favourites' : `${d.name} is on Now`)} />} />
              );
            })}
          </Card>
        ) : <Empty compact icon="devices" title="Nothing in this room" text="Open a device and choose its room to move it here." />}
        <T v="footnote" color={C.stone2} style={{ paddingHorizontal: 4 }}>Tap a device to rename it, move it to another room or hide it.</T>
      </Section>

      {hidden.length ? (
        <Section title={`Hidden · ${hidden.length}`} caption gap={SP[2]}>
          <Card style={{ overflow: 'hidden' }}>
            {hidden.map((d, i) => (
              <Row key={d.id} first={!i} icon="visibility_off" iconFg={C.stone} title={d.name} sub={`${rn(d.room)} · still works in modes`}
                right={<Button size="sm" kind="secondary" label="Show" onPress={() => settings(d.id, { hidden: false }, `${d.name} shown again`)} />} />
            ))}
          </Card>
        </Section>
      ) : null}

      <Section title="Speaker groups" caption action="New group" onAction={() => setGroup('new')} gap={SP[2]}>
        {s.speakerGroups.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {s.speakerGroups.map((g, i) => (
              <Row key={g.id} first={!i} icon="speaker_group" iconFg={all[g.deviceId]?.on ? C.blue : C.bone} title={g.name}
                sub={`${plural(g.members.length, 'speaker')} · ${g.sync === 'perfect' ? 'perfect sync' : 'start together'}`} onPress={() => setGroup(g.id)} />
            ))}
          </Card>
        ) : <Empty compact icon="speaker_group" tone={C.blue} title="No speaker groups" text="Play speakers of any brand as one." action="Make one" onAction={() => setGroup('new')} />}
      </Section>

      <Section title="Combined devices" caption gap={SP[2]}>
        {ideas.map(ci => <CombineIdeaCard key={ci.key} ci={ci} />)}
        {combined.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {combined.map((c, i) => (
              <Row key={c.id} first={!i} icon="join" iconFg={C.amber} title={c.name} sub={c.memberNames.join(' and ')} onPress={() => setCombo(c.id)} />
            ))}
          </Card>
        ) : !ideas.length ? <Empty compact icon="join" title="Nothing combined" text="When Kova reaches one device through two integrations, it suggests making them one here." /> : null}
      </Section>

      <RoomSheet room={s.rooms.find(r => r.id === room) ?? null} onClose={() => setRoom(null)} />
      <PersonSheet person={s.people.find(p => p.id === person) ?? null} onClose={() => setPerson(null)} />
      <CombinedSheet c={combined.find(c => c.id === combo) ?? null} onClose={() => setCombo(null)} />
      <SpeakerGroupSheet id={group} onClose={() => setGroup(null)} />
    </Screen>
  );
}
