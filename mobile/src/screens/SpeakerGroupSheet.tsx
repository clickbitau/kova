import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { C, F, R, SP, alpha } from '../theme';
import { useHub } from '../state/hub';
import { ICON } from '../logic/devices';
import { cleanName, groupBody, groupDraftError, groupSyncNote, speakerChoices, type GroupDraft } from '../logic/customise';
import { draftSyncNote } from '../logic/group-sync';
import { combinedOf } from '../logic/devices';
import { useNav } from '../navigation';
import { Icon } from '../ui/Icon';
import { Button, Card, HScroll, IconWell, Pill, Press, Section, Sheet } from '../ui/kit';
import { T } from '../ui/Text';

const TONE = { muted: C.stone, green: C.green, amber: C.amber, blue: C.blue } as const;

/** A text box the way the app draws them: card surface, hairline edge, amber edge while typing. */
export function TextField({ value, onChange, placeholder, label, onSubmit, autoFocus, keyboard }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string; onSubmit?: () => void; autoFocus?: boolean; keyboard?: 'default' | 'number-pad' | 'url' }) {
  const [focus, setFocus] = useState(false);
  return (
    <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.stone2} accessibilityLabel={label} autoFocus={autoFocus}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onSubmitEditing={onSubmit} returnKeyType={onSubmit ? 'done' : 'default'}
      keyboardType={keyboard === 'url' ? 'url' : keyboard ?? 'default'} autoCapitalize={keyboard === 'url' ? 'none' : 'sentences'} autoCorrect={keyboard !== 'url'}
      style={{ height: 48, paddingHorizontal: SP[3] + 2, borderRadius: R.md, borderWidth: 1, borderColor: focus ? C.amberLine : C.line, backgroundColor: C.card, color: C.bone, fontFamily: F[500], fontSize: 16 }} />
  );
}

/** A sheet's heading: what it is in small capitals, then its name. */
export function SheetHead({ kicker, title, icon, color = C.bone }: { kicker: string; title: string; icon?: string; color?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
      {icon ? <IconWell icon={icon} color={color} bg={color === C.bone ? C.selected : undefined} size={48} radius={24} fill /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <T v="eyebrow" color={C.stone2}>{kicker}</T>
        <T v="title" numberOfLines={2}>{title}</T>
      </View>
    </View>
  );
}

/**
 * Make or edit a speaker group: any speakers, any brands, played as one. `id` is a group's id, 'new', or null when
 * closed. Saving and deleting answer with an undo.
 */
export function SpeakerGroupSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { snap, act } = useHub();
  const nav = useNav();
  const G = id && id !== 'new' ? snap?.speakerGroups.find(g => g.id === id) : undefined;
  const [d, setD] = useState<GroupDraft>({ name: '', members: [], room: '' });
  useEffect(() => { if (id) setD(G ? { name: G.name, members: [...G.members], room: G.room ?? '' } : { name: '', members: [], room: '' }); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!snap) return null;
  const rooms = snap.rooms;
  const rn = (r: string) => rooms.find(x => x.id === r)?.name ?? 'No room';
  // Hidden speakers (a combined soundbar's Cast side) only when they're in the group already.
  const choices = speakerChoices(snap.devices.filter(x => !x.hidden || d.members.includes(x.id)), rooms);
  const chosen = choices.filter(c => d.members.includes(c.id));
  // Hubs from 0.7.63 say what can play as one stream: the note names what's native-synced and what plays alongside.
  const note = snap.nativeGroups ? draftSyncNote(chosen, snap.nativeGroups, combinedOf(snap), snap.devices) : groupSyncNote(chosen, d.members, G);
  const tunable = !!G && (G.parts?.length ?? 0) > 1;
  const err = groupDraftError(d);
  const toggle = (m: string) => setD(x => ({ ...x, members: x.members.includes(m) ? x.members.filter(y => y !== m) : [...x.members, m] }));
  const save = async () => {
    if (err) return false;
    const body = groupBody(d, !!G);
    const ok = G ? await act('PUT', `/api/speaker-groups/${encodeURIComponent(G.id)}`, body, `${body.name} saved`) : await act('POST', '/api/speaker-groups', body, `${body.name} is ready to play`);
    if (ok) onClose();
    return ok;
  };
  const remove = async () => {
    if (!G) return false;
    const ok = await act('DELETE', `/api/speaker-groups/${encodeURIComponent(G.id)}`, {}, `${G.name} deleted. The speakers stay as they are.`);
    if (ok) onClose();
    return ok;
  };
  return (
    <Sheet open={!!id} onClose={onClose} label="Speaker group">
      <SheetHead kicker={G ? 'Speaker group' : 'New speaker group'} title={cleanName(d.name) || G?.name || 'New group'} icon="speaker_group" color={C.blue} />
      <Section title="Name" caption gap={SP[2]}>
        <TextField value={d.name} onChange={name => setD(x => ({ ...x, name }))} placeholder="e.g. Downstairs" label="Group name" />
      </Section>
      <Section title={`Speakers · ${d.members.length} picked`} caption gap={SP[2]}>
        {choices.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {choices.map((s, i) => {
              const on = d.members.includes(s.id);
              return (
                <Press key={s.id} onPress={() => toggle(s.id)} haptic="select" selected={on} role="checkbox" label={`${s.name}, ${rn(s.room)}`} give="soft"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 56, paddingVertical: SP[2], paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline, backgroundColor: on ? alpha(C.blue, 0.06) : 'transparent' }}>
                  <IconWell icon={ICON[s.type] ?? 'speaker'} color={on ? C.blue : C.stone} bg={on ? undefined : C.control} size={34} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <T v="headline" size={14.5} numberOfLines={1}>{s.name}</T>
                    <T v="footnote" color={C.stone} numberOfLines={1}>{[rn(s.room), s.integration].filter(Boolean).join(' · ')}</T>
                  </View>
                  <Icon name={on ? 'check_circle' : 'radio_button_unchecked'} size={22} color={on ? C.blue : C.stone3} fill={on} />
                </Press>
              );
            })}
          </Card>
        ) : <T v="callout" color={C.stone}>No speakers yet. Add Google Cast, Sonos or AirPlay speakers first.</T>}
      </Section>
      <Section title="Room" caption gap={SP[2]}>
        <HScroll>
          <Pill label="Automatic" on={!d.room} onPress={() => setD(x => ({ ...x, room: '' }))} />
          {rooms.map(r => <Pill key={r.id} icon={r.icon} label={r.name} on={d.room === r.id} onPress={() => setD(x => ({ ...x, room: r.id }))} />)}
        </HScroll>
        <T v="footnote" color={C.stone2}>Automatic puts it in the speakers’ room.</T>
      </Section>
      <Card style={{ padding: SP[4], flexDirection: 'row', gap: SP[3], backgroundColor: alpha(TONE[note.tone], 0.08), borderColor: alpha(TONE[note.tone], 0.25), borderTopColor: alpha(TONE[note.tone], 0.32) }}>
        <Icon name={note.icon} size={20} color={TONE[note.tone]} />
        <View style={{ flex: 1, gap: 2 }}>
          <T v="headline" size={14}>{note.title}</T>
          <T v="footnote" color={C.stone}>{note.text}</T>
        </View>
      </Card>
      {tunable ? <Button full kind="secondary" icon="graphic_eq" label="Timing" onPress={() => { onClose(); nav.navigate('GroupSync', { id: G!.id }); }} /> : null}
      <View style={{ gap: SP[2] }}>
        <Button full kind={err ? 'secondary' : 'primary'} icon={err ? undefined : G ? 'check' : 'add'} label={err ?? (G ? 'Save' : 'Make the group')} onPress={err ? undefined : save} />
        {G ? <Button full kind="danger" icon="delete" label="Delete group" onPress={remove} /> : null}
      </View>
    </Sheet>
  );
}
