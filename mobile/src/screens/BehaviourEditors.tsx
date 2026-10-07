import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { C, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav, type Stack } from '../navigation';
import type { Command } from '../api/types';
import type { Targets } from '../logic/automations';
import {
  END_KINDS, MODE_COLORS, MODE_ICONS, OVERLAY_ICONS, blankMode, blankMoment, blankOverlay, clean, endOf, endWords, modeBody, modeDraftOf, modeError,
  momentBody, momentDraftOf, momentError, momentsIn, overlayBody, overlayDraftOf, overlayError, sameJSON, setTarget,
  type ModeDraft, type MomentDraft, type OverlayDraft,
} from '../logic/modes';
import { Button, Card, Empty, Group, HScroll, Pill, Row, Section, SwitchRow } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { TextField } from './SpeakerGroupSheet';
import { ConfirmSheet, DevicePicker, IconGrid, RhythmEditor, Swatches, TargetsEditor, rowsOf } from './BehaviourParts';

const path = (kind: 'modes' | 'overlays' | 'moments', id: string) => `/api/${kind}/${encodeURIComponent(id)}`;

/** "Start from": nothing, or a copy of another mode or overlay's targets. */
function CopyFrom({ list, value, onChange, what }: { list: { id: string; name: string; icon: string }[]; value: string; onChange: (v: string) => void; what: string }) {
  return (
    <Section title="Start from" caption gap={SP[2]}>
      <HScroll>
        <Pill label="Nothing set" on={!value} onPress={() => onChange('')} />
        {list.map(x => <Pill key={x.id} icon={x.icon} label={`A copy of ${x.name}`} on={value === x.id} onPress={() => onChange(x.id)} />)}
      </HScroll>
      <T v="footnote" color={C.stone2}>{value ? `It starts with what ${list.find(x => x.id === value)?.name ?? ''} sets; change it after.` : `You add what the ${what} sets once it’s made.`}</T>
    </Section>
  );
}

/**
 * A mode: its name, icon, colour and when it starts (Save), what it sets (each change goes straight to the hub),
 * its behaviours, its moments, and deleting it. Without an id: a new mode, made with Create, then edited here.
 */
export function ModeEditor() {
  const s = useSnap();
  const nav = useNav();
  const { api, act, say } = useHub();
  const id = useRoute<RouteProp<Stack, 'ModeEditor'>>().params?.id;
  const M = id ? s.modes.find(m => m.id === id) : undefined;
  const [d, setD] = useState<ModeDraft>(() => M ? modeDraftOf(M) : blankMode());
  const [copy, setCopy] = useState('');
  const [del, setDel] = useState(false);
  useEffect(() => { if (M) setD(modeDraftOf(M)); }, [M?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (id && !M) {
    return (
      <Screen title="Mode" onBack={() => nav.goBack()}>
        <Empty icon="routine" title="This mode is gone" text="It was deleted, maybe on another phone or the web." action="Back to Modes" onAction={() => nav.goBack()} />
      </Screen>
    );
  }
  const err = modeError(d, s.modes, M?.id);
  const base = M ? modeDraftOf(M) : null;
  const changed = !!base && !sameJSON({ ...d, lightTheWay: base.lightTheWay, onlyWhenSomeoneHome: base.onlyWhenSomeoneHome }, base);
  const set = (p: Partial<ModeDraft>) => setD(x => ({ ...x, ...p }));

  const create = async () => {
    if (err) { say(err, { error: true }); return false; }
    try {
      const r = await api<{ id: string; undo?: string }>('POST', '/api/modes', modeBody(d, copy || undefined));
      say(`${clean(d.name)} is in your day`, { undo: r.undo });
      nav.replace('ModeEditor', { id: r.id });
      return true;
    } catch (e) { say((e as Error).message, { error: true }); return false; }
  };
  const save = () => M && !err ? act('PUT', path('modes', M.id), { name: clean(d.name), icon: d.icon, color: d.color, start: d.start }, `${clean(d.name)} saved`) : false;
  const remove = async () => {
    if (!M) return false;
    const ok = await act('DELETE', path('modes', M.id), {}, `${M.name} deleted`);
    setDel(false);
    if (ok) nav.goBack();
    return ok;
  };
  const target = (device: string, cmd: Command | null) => M && act('PUT', `${path('modes', M.id)}/targets/${encodeURIComponent(device)}`, { target: cmd }, cmd ? `${M.name} updated` : `Removed from ${M.name}`);
  const flag = (k: 'lightTheWay' | 'onlyWhenSomeoneHome', v: boolean, done: string) => { set({ [k]: v }); if (M) void act('PUT', path('modes', M.id), { [k]: v }, done); };
  const moments = M ? momentsIn(s.moments, (M.moments ?? []).map(m => m.id)) : [];
  const color = d.color;

  return (
    <Screen title={M ? clean(d.name) || M.name : 'New mode'} over={M ? `${M.startLabel} → ${M.endLabel}` : 'A part of your day'} onBack={() => nav.goBack()} glow={color} gap={SP[6]}>
      <Section title="Name" caption gap={SP[2]}>
        <TextField value={d.name} onChange={v => set({ name: v })} label="Mode name" placeholder="e.g. Dinner" />
      </Section>
      <Section title="Starts" caption gap={SP[2]}>
        <RhythmEditor value={d.start} title="Starts at" onChange={start => set({ start })} />
        <T v="footnote" color={C.stone2}>{M && s.modes[0]?.id === M.id ? 'This is the first mode of your day.' : 'It runs until the next mode starts.'}</T>
      </Section>
      <Section title="Icon" caption gap={SP[2]}>
        <IconGrid icons={MODE_ICONS} value={d.icon} onChange={icon => set({ icon })} color={color} />
      </Section>
      <Section title="Colour" caption gap={SP[2]}>
        <Swatches colors={MODE_COLORS} value={d.color} onChange={c => set({ color: c })} />
      </Section>
      {!M ? <CopyFrom list={s.modes} value={copy} onChange={setCopy} what="mode" /> : null}
      {err && (M ? changed : !!d.name.trim()) ? <T v="footnote" color={C.redText}>{err}</T> : null}
      {M ? <Button full kind={changed && !err ? 'primary' : 'secondary'} icon="check" label="Save" onPress={changed && !err ? save : undefined} />
        : <Button full icon="add" label="Create mode" onPress={create} />}

      {M ? (
        <>
          <Section title="How the home should be" caption gap={SP[2]}>
            <TargetsEditor rows={M.targets ?? []} onSet={target} empty="This mode doesn’t change anything yet. Add the devices it sets when it starts." />
          </Section>
          <Group title="Behaviours">
            <SwitchRow first icon="directions_walk" iconFg={C.amber} title="Light the way" sub="Lights follow people seen by cameras or arriving home" on={d.lightTheWay}
              onChange={v => flag('lightTheWay', v, v ? `Light the way in ${M.name}` : `No Light the way in ${M.name}`)} />
            <SwitchRow icon="person" iconFg={C.green} title="Only when someone’s home" sub="With nobody home, it waits to switch things on until someone arrives" on={d.onlyWhenSomeoneHome}
              onChange={v => flag('onlyWhenSomeoneHome', v, v ? 'Waits for someone to be home' : 'Starts whoever’s home')} />
          </Group>
          <Section title="Moments in this mode" caption action="Add a moment" onAction={() => nav.navigate('MomentEditor', { start: d.start })} gap={SP[2]}>
            {moments.length ? (
              <Card style={{ overflow: 'hidden' }}>
                {moments.map((m, i) => <Row key={m.id} first={!i} icon="schedule" iconFg={color} title={m.label} sub={[m.atLabel, m.what].filter(Boolean).join(' · ')} onPress={() => nav.navigate('MomentEditor', { id: m.id })} />)}
              </Card>
            ) : <T v="footnote" color={C.stone}>No moments in it today. A moment is a one-off at a time, like rain sounds at 21:00.</T>}
          </Section>
          <Section title="Delete this mode" caption gap={SP[2]}>
            <Button full kind="danger" icon="delete" label={`Delete ${M.name}`} onPress={s.modes.length > 1 ? () => setDel(true) : undefined} />
            <T v="footnote" color={C.stone2} center>{s.modes.length > 1 ? 'The mode before it carries on instead. You can undo it for a few seconds afterwards.' : 'Your home needs at least one mode.'}</T>
          </Section>
          <ConfirmSheet open={del} title={`Delete ${M.name}?`} text="What it sets stops happening, and the mode before it runs until the next one. Automations that use it have to be changed first." yes="Delete mode" onYes={remove} onClose={() => setDel(false)} />
        </>
      ) : null}
    </Screen>
  );
}

/** An overlay: on top of the mode for a while (Movie, Away). Name, icon and ending (Save); what it sets; deleting it. */
export function OverlayEditor() {
  const s = useSnap();
  const nav = useNav();
  const { api, act, say } = useHub();
  const id = useRoute<RouteProp<Stack, 'OverlayEditor'>>().params?.id;
  const O = id ? s.overlays.find(o => o.id === id) : undefined;
  const [d, setD] = useState<OverlayDraft>(() => O ? overlayDraftOf(O) : blankOverlay());
  const [copy, setCopy] = useState('');
  const [del, setDel] = useState(false);
  const [pickDev, setPickDev] = useState(false);
  useEffect(() => { if (O) setD(overlayDraftOf(O)); }, [O?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (id && !O) {
    return (
      <Screen title="Overlay" onBack={() => nav.goBack()}>
        <Empty icon="layers" title="This overlay is gone" text="It was deleted, maybe on another phone or the web." action="Back to Modes" onAction={() => nav.goBack()} />
      </Screen>
    );
  }
  const on = !!O && s.current.overlay?.id === O.id;
  const err = overlayError(d, s.overlays, O?.id);
  const base = O ? overlayDraftOf(O) : null;
  const changed = !!base && !sameJSON(d, base);
  const set = (p: Partial<OverlayDraft>) => setD(x => ({ ...x, ...p }));
  const devName = (dev: string) => s.devices.find(x => x.id === dev)?.name ?? dev;
  const create = async () => {
    if (err) { say(err, { error: true }); return false; }
    try {
      const r = await api<{ id: string; undo?: string }>('POST', '/api/overlays', overlayBody(d, copy || undefined));
      say(`${clean(d.name)} is ready to start`, { undo: r.undo });
      nav.replace('OverlayEditor', { id: r.id });
      return true;
    } catch (e) { say((e as Error).message, { error: true }); return false; }
  };
  const save = () => O && !err ? act('PUT', path('overlays', O.id), { name: clean(d.name), icon: d.icon, ends: d.ends, allOff: d.allOff }, `${clean(d.name)} saved`) : false;
  const remove = async () => {
    if (!O) return false;
    const ok = await act('DELETE', path('overlays', O.id), {}, `${O.name} deleted`);
    setDel(false);
    if (ok) nav.goBack();
    return ok;
  };
  const target = (device: string, cmd: Command | null) => O && act('PUT', `${path('overlays', O.id)}/targets/${encodeURIComponent(device)}`, { target: cmd }, cmd ? `${O.name} updated` : `Removed from ${O.name}`);

  return (
    <Screen title={O ? clean(d.name) || O.name : 'New overlay'} over={O ? (on ? 'On now' : O.endsLabel) : 'On top of the mode, for a while'} onBack={() => nav.goBack()} gap={SP[6]}>
      {O ? (
        <Button full kind={on ? 'secondary' : 'primary'} icon={on ? 'stop' : 'play_arrow'} label={on ? `End ${O.name}` : `Start ${O.name}`}
          onPress={() => on ? act('POST', '/api/overlays/end', {}, `${O.name} ended`) : act('POST', `${path('overlays', O.id)}/start`, {}, `${O.name} is on`)} />
      ) : null}
      <Section title="Name" caption gap={SP[2]}>
        <TextField value={d.name} onChange={v => set({ name: v })} label="Overlay name" placeholder="e.g. Reading" />
      </Section>
      <Section title="Icon" caption gap={SP[2]}>
        <IconGrid icons={OVERLAY_ICONS} value={d.icon} onChange={icon => set({ icon })} />
      </Section>
      <Section title="Ends" caption gap={SP[2]}>
        <HScroll>{END_KINDS.map(k => <Pill key={k.id} label={k.label} on={d.ends.kind === k.id} onPress={() => { set({ ends: endOf(k.id, d.ends) }); if (k.id === 'device_off' && d.ends.kind !== 'device_off') setPickDev(true); }} />)}</HScroll>
        {d.ends.kind === 'time' ? <RhythmEditor value={d.ends.at} title="Ends at" onChange={at => set({ ends: { kind: 'time', at } })} /> : null}
        {d.ends.kind === 'device_off' ? (
          <Card style={{ overflow: 'hidden' }}>
            <Row first icon="power_settings_new" title={d.ends.device ? devName(d.ends.device) : 'Pick the device'} sub="When it turns off, the overlay ends" onPress={() => setPickDev(true)} />
          </Card>
        ) : null}
        <T v="footnote" color={C.stone}>{endWords(d.ends, devName)}</T>
      </Section>
      <Card style={{ overflow: 'hidden' }}>
        <SwitchRow first icon="light_off" iconFg={C.amber} title="Everything else off" sub="Lights and players it doesn’t set switch off while it’s on" on={d.allOff} onChange={v => set({ allOff: v })} />
      </Card>
      {!O ? <CopyFrom list={s.overlays} value={copy} onChange={setCopy} what="overlay" /> : null}
      {err && (O ? changed : !!d.name.trim()) ? <T v="footnote" color={C.redText}>{err}</T> : null}
      {O ? <Button full kind={changed && !err ? 'primary' : 'secondary'} icon="check" label="Save" onPress={changed && !err ? save : undefined} />
        : <Button full icon="add" label="Create overlay" onPress={create} />}
      {O ? (
        <>
          <Section title="While it’s on" caption gap={SP[2]}>
            <TargetsEditor rows={O.targets ?? []} onSet={target} empty="It doesn’t set anything yet. Add the devices it changes when it starts." />
          </Section>
          <Section title="Delete this overlay" caption gap={SP[2]}>
            <Button full kind="danger" icon="delete" label={`Delete ${O.name}`} onPress={on ? undefined : () => setDel(true)} />
            <T v="footnote" color={C.stone2} center>{on ? `${O.name} is on now. End it first.` : 'You can undo it for a few seconds afterwards.'}</T>
          </Section>
          <ConfirmSheet open={del} title={`Delete ${O.name}?`} text="Automations that start or end it have to be changed first." yes="Delete overlay" onYes={remove} onClose={() => setDel(false)} />
        </>
      ) : null}
      <DevicePicker open={pickDev} title="Ends when this turns off" onClose={() => setPickDev(false)} onPick={dev => set({ ends: { kind: 'device_off', device: dev } })} />
    </Screen>
  );
}

/** A moment: a one-off at a time of day ("21:00 rain sounds"), shown in whichever mode it falls in. Saved as a whole. */
export function MomentEditor() {
  const s = useSnap();
  const nav = useNav();
  const { act } = useHub();
  const params = useRoute<RouteProp<Stack, 'MomentEditor'>>().params ?? {};
  const M = params.id ? (s.moments ?? []).find(m => m.id === params.id) : undefined;
  const [d, setD] = useState<MomentDraft>(() => M ? momentDraftOf(M) : { ...blankMoment(), ...(params.start ? { at: params.start } : {}) });
  const [del, setDel] = useState(false);
  if (params.id && !M) {
    return (
      <Screen title="Moment" onBack={() => nav.goBack()}>
        <Empty icon="schedule" title="This moment is gone" text="It was deleted, maybe on another phone or the web." action="Back" onAction={() => nav.goBack()} />
      </Screen>
    );
  }
  const err = momentError(d);
  const changed = !M || !sameJSON(momentBody(d), momentBody(momentDraftOf(M)));
  const save = async () => {
    if (err) return false;
    const body = momentBody(d);
    const ok = M ? await act('PUT', path('moments', M.id), body, `${body.label} saved`) : await act('POST', '/api/moments', body, `${body.label} added to your day`);
    if (ok) nav.goBack();
    return ok;
  };
  const remove = async () => {
    if (!M) return false;
    const ok = await act('DELETE', path('moments', M.id), {}, `${M.label} deleted`);
    setDel(false);
    if (ok) nav.goBack();
    return ok;
  };
  const setT = (dev: string, cmd: Command | null) => setD(x => ({ ...x, targets: setTarget(x.targets, dev, cmd) as Targets }));
  return (
    <Screen title={M ? clean(d.label) || M.label : 'New moment'} over="A one-off at a time of day" onBack={() => nav.goBack()} gap={SP[6]}>
      <Section title="Name" caption gap={SP[2]}>
        <TextField value={d.label} onChange={v => setD(x => ({ ...x, label: v }))} label="Moment name" placeholder="e.g. Rain sounds" />
      </Section>
      <Section title="What it is (optional)" caption gap={SP[2]}>
        <TextField value={d.what} onChange={v => setD(x => ({ ...x, what: v }))} label="What it is" placeholder="e.g. In the kids’ room" />
      </Section>
      <Section title="When" caption gap={SP[2]}>
        <RhythmEditor value={d.at} title="At" onChange={at => setD(x => ({ ...x, at }))} />
      </Section>
      <Section title="What it does" caption gap={SP[2]}>
        <TargetsEditor rows={rowsOf(d.targets, s.devices, s.sources)} onSet={setT} empty="Add at least one device." />
      </Section>
      {err && d.label.trim() ? <T v="footnote" color={C.stone}>{err}</T> : null}
      <Button full kind={err || !changed ? 'secondary' : 'primary'} icon="check" label={M ? 'Save' : 'Add moment'} onPress={err || !changed ? undefined : save} />
      {M ? <Button full kind="danger" icon="delete" label={`Delete ${M.label}`} onPress={() => setDel(true)} /> : null}
      <View style={{ height: SP[2] }} />
      <ConfirmSheet open={del} title={`Delete ${M?.label ?? 'this moment'}?`} text="It won’t happen again. You can undo it for a few seconds afterwards." yes="Delete moment" onYes={remove} onClose={() => setDel(false)} />
    </Screen>
  );
}
