import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, SP } from '../theme';
import { call, hello } from '../api/client';
import { addressesOf, chooseAddress, display } from '../logic/addresses';
import { parseInviteLink, type HubConfig, type InviteLink } from '../logic/connect';
import { roleText, untilWords, type Role } from '../logic/roles';
import { appName } from '../logic/signin';
import { useHub } from '../state/hub';
import { Icon } from '../ui/Icon';
import { Avatar, Button, Card, IconWell, Press, Section, Skeleton, Tag } from '../ui/kit';
import { Glow } from '../ui/Screen';
import { Appear, haptic } from '../ui/motion';
import { T } from '../ui/Text';
import { TextField } from './SpeakerGroupSheet';

/** What POST /api/invite/peek says the invite is for. */
interface Peek { home: string; role: Role; roleLabel: string; expires: number; until?: number; rooms: string[]; person: { id: string; name: string } | null; name: string | null; people: { id: string; name: string }[] }

/** An invite link opened from outside (kova://join, or the join page's link), while the app is running or at launch. */
export function useJoinLink(): [InviteLink | null, () => void] {
  const [link, setLink] = useState<InviteLink | null>(null);
  useEffect(() => {
    void Linking.getInitialURL().then(u => { const l = u ? parseInviteLink(u) : null; if (l) setLink(l); }).catch(() => {});
    const sub = Linking.addEventListener('url', e => { const l = parseInviteLink(e.url); if (l) setLink(l); });
    return () => sub.remove();
  }, []);
  return [link, () => setLink(null)];
}

/**
 * Joining a home with an invite (household accounts): find the hub at the invite's addresses (it must say it's the
 * hub the invite names), show whose home and which role, let the invitee say who they are (one of the home's
 * people without an account, or someone new), then take this phone's own key and connect.
 */
export function JoinScreen({ invite, onClose }: { invite: InviteLink; /** Not now, or joined. */ onClose: () => void }) {
  const { connect } = useHub();
  const insets = useSafeAreaInsets();
  const [base, setBase] = useState<{ url: string; hubId?: string } | null>(null);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [who, setWho] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const tries = useRef(0);

  const look = async () => {
    const mine = ++tries.current;
    setErr(null); setPeek(null);
    try {
      const r = await chooseAddress(addressesOf(invite), { hello, hubId: invite.hubId, localTimeoutMs: 4000, remoteTimeoutMs: 8000 });
      if (!r) throw new Error(`No Kova hub answered at ${display(invite.url)}. Are you on the home’s Wi-Fi? Or ask for an invite with the hub’s remote address.`);
      const p = await call<Peek>({ url: r.url }, 'POST', '/api/invite/peek', { code: invite.code });
      if (mine !== tries.current) return;
      setBase({ url: r.url, ...(r.hubId ? { hubId: r.hubId } : {}) });
      setPeek(p);
      if (!p.people.length) setWho('new');
    } catch (e) { if (mine === tries.current) setErr((e as Error).message); }
  };
  useEffect(() => { void look(); return () => { tries.current++; }; }, [invite.code]); // eslint-disable-line react-hooks/exhaustive-deps

  const fixed = peek?.person ?? null;
  const named = peek?.name ?? null;
  const ready = !!peek && (!!fixed || !!named || (who === 'new' ? !!name.trim() : !!who));
  const accept = async () => {
    if (!peek || !base || !ready) return false;
    setErr(null);
    try {
      const r = await call<{ token: string; personId: string; hubId?: string | null }>({ url: base.url }, 'POST', '/api/invite/accept', {
        code: invite.code, device: appName(Platform.OS),
        ...(fixed || named ? {} : who === 'new' ? { name: name.trim() } : { personId: who }),
      });
      haptic.success();
      const hubId = base.hubId ?? r.hubId ?? invite.hubId;
      const cfg: HubConfig = { url: base.url, token: r.token, personId: r.personId, ...(hubId ? { hubId } : {}), ...(invite.addresses ? { addresses: invite.addresses } : {}) };
      await connect(cfg);
      onClose();
      return true;
    } catch (e) { haptic.error(); setErr((e as Error).message); return false; }
  };

  const chip = (id: string, label: string, icon?: string) => {
    const on = who === id;
    return (
      <Press key={id} selected={on} haptic="select" label={label} onPress={() => setWho(id)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] + 2, minHeight: 52, paddingLeft: 8, paddingRight: 16, paddingVertical: 6, borderRadius: R.lg, backgroundColor: on ? C.amberTint : C.card, borderWidth: 1, borderColor: on ? C.amberLine : C.edge, flexShrink: 1, maxWidth: '100%' }}>
        {icon ? <IconWell icon={icon} size={36} radius={18} color={on ? C.amber : C.stone} /> : <Avatar name={label} size={36} ring={on ? '#2a2318' : C.card} />}
        <T v="label" color={on ? C.bone : C.bone2} style={{ flexShrink: 1 }}>{label}</T>
        {on ? <Icon name="check" size={18} color={C.amber} /> : null}
      </Press>
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.page, overflow: 'hidden' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Glow color={C.amber} opacity={0.14} />
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: SP[6], paddingTop: insets.top + SP[8], paddingBottom: insets.bottom + SP[6], gap: SP[6] }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: SP[3] }}>
          <IconWell icon="person_add" color={C.amber} size={56} radius={28} fill />
          <T v="eyebrow" color={C.stone2}>You’re invited</T>
          {peek ? <T v="largeTitle" size={30}>{`Join ${peek.home}`}</T> : err ? <T v="largeTitle" size={30}>Join a home</T> : <Skeleton w="80%" h={34} />}
          {peek ? (
            <View style={{ gap: SP[2] }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
                <Tag text={peek.roleLabel} color={C.amber} />
                {peek.until ? <Tag text={untilWords(peek.until)} /> : null}
              </View>
              <T v="body" color={C.stone}>{roleText(peek.role)}</T>
              {peek.rooms.length ? <T v="footnote" color={C.stone2}>{`Rooms: ${peek.rooms.join(', ')}`}</T> : null}
            </View>
          ) : !err ? <Skeleton w="100%" h={44} /> : null}
        </View>

        {peek ? (
          fixed || named ? (
            <Card pad={SP[4]} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
              <Avatar name={fixed?.name ?? named ?? '?'} size={44} ring={C.card} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T v="footnote" color={C.stone}>You’re joining as</T>
                <T v="headline" numberOfLines={2}>{fixed?.name ?? named}</T>
              </View>
            </Card>
          ) : (
            <Section title="Who are you?" caption gap={SP[2]}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] + 2 }}>
                {peek.people.map(p => chip(p.id, p.name))}
                {chip('new', 'Someone new', 'person_add')}
              </View>
              {who === 'new' ? <TextField value={name} onChange={setName} label="Your name" placeholder="Your name" onSubmit={() => void accept()} autoFocus /> : null}
            </Section>
          )
        ) : null}

        {err ? (
          <Appear style={{ flexDirection: 'row', gap: SP[2] + 2, padding: SP[3] + 2, borderRadius: R.md, backgroundColor: C.redTint, borderWidth: 1, borderColor: C.redLine }}>
            <Icon name="error" size={19} color={C.red} fill />
            <T v="callout" color={C.redText} style={{ flex: 1 }}>{err}</T>
          </Appear>
        ) : null}

        <View style={{ gap: SP[3] }}>
          {peek ? <Button size="lg" label="Join" icon="login" onPress={ready ? accept : undefined} kind={ready ? 'primary' : 'secondary'} />
            : err ? <Button size="lg" kind="secondary" label="Try again" icon="refresh" onPress={() => void look()} /> : null}
          <Button kind="ghost" label="Not now" onPress={onClose} />
          <T v="footnote" color={C.stone2} center>This phone gets its own key to the home. The owner can sign it out any time.</T>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
