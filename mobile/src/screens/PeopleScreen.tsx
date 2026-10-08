import { useCallback, useEffect, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { C, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { ago, sessionIcon } from '../logic/browsers';
import { accessBody, features, inviteLine, inviteProblem, meOf, ROLES, roleLine, roleText, roomsMatter, seenWords, untilPresets, untilWords, type Role } from '../logic/roles';
import { appName } from '../logic/signin';
import { canCopy, copy } from '../native/clipboard';
import { Icon } from '../ui/Icon';
import { Avatar, Button, Card, Chips, Empty, Group, Notice, Pill, Press, Row, Section, Segmented, Sheet, Skeleton } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { SheetHead, TextField } from './SpeakerGroupSheet';

interface SessionView { id: string; name: string; created: number; lastSeen: number; current?: boolean; personId?: string }
interface MemberView { personId: string; name: string; role: Role; roleLabel: string; rooms?: string[]; devices?: string[]; until?: number; room?: string; expired: boolean; lastSeen: number | null; sessions: SessionView[]; user?: string | null }
interface InviteView { id: string; role: Role; roleLabel: string; personId?: string; name?: string; rooms?: string[]; until?: number; created: number; expires: number; expired: boolean }
interface Members { members: MemberView[]; others: { personId: string; name: string }[]; invites: InviteView[]; ownerKeys: SessionView[] }
interface Made { invite: InviteView; code: string; link: string; appLink: string; qrSvg: string }

/** Rooms to choose from, as pills that toggle (a child's or a guest's rooms). */
function RoomPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const s = useSnap();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
      {s.rooms.map(r => {
        const on = value.includes(r.id);
        return <Pill key={r.id} icon={r.icon} label={r.name} on={on} onPress={() => onChange(on ? value.filter(x => x !== r.id) : [...value, r.id])} />;
      })}
    </View>
  );
}

/** A guest's end: quick choices, plus the current one when it's none of them. */
function UntilPicker({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const presets = untilPresets();
  const hit = presets.find(p => p.at === value);
  const options = [...presets.map(p => ({ id: p.id, label: p.label })), ...(value && !hit ? [{ id: 'keep', label: untilWords(value).replace(/^until /, 'Until ') }] : [])];
  return (
    <View style={{ gap: SP[2] }}>
      <Chips label="Access ends" columns={2} options={options} value={hit?.id ?? (value ? 'keep' : 'none')} onChange={id => { if (id !== 'keep') onChange(presets.find(p => p.id === id)?.at ?? null); }} />
      <T v="footnote" color={C.stone2}>{value ? `Their access ends ${untilWords(value).replace(/^until /, '')}: every device of theirs is signed out then.` : 'Their access lasts until you take it away.'}</T>
    </View>
  );
}

function RolePicker({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return (
    <View style={{ gap: SP[2] }}>
      <Segmented label="Role" options={ROLES.map(r => ({ id: r.id, label: r.label }))} value={value} onChange={id => onChange(id as Role)} />
      <T v="footnote" color={C.stone}>{roleText(value)}</T>
    </View>
  );
}

/** Invite someone: role, who (one of the people, someone new, or let them say), rooms and end time; then the QR. */
function InviteSheet({ open, onClose, start, data, resend, onDone }: { open: boolean; onClose: () => void; start?: { personId?: string }; data: Members | null; resend?: Made | null; onDone: () => void }) {
  const { api, say } = useHub();
  const [role, setRole] = useState<Role>('adult');
  const [who, setWho] = useState<string>('any');
  const [name, setName] = useState('');
  const [rooms, setRooms] = useState<string[]>([]);
  const [until, setUntil] = useState<number | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setRole('adult'); setWho(start?.personId ?? 'any'); setName(''); setRooms([]); setUntil(untilPresets().find(p => p.id === 'sunday')?.at ?? null); setErr(null);
    setMade(resend ?? null);
  }, [open, start?.personId, resend]);
  const others = data?.others ?? [];
  const make = async () => {
    const problem = inviteProblem({ role, rooms });
    if (problem) { setErr(problem); return false; }
    setErr(null);
    try {
      const r = await api<Made>('POST', '/api/invites', { ...accessBody({ role, rooms, until }), ...(who === 'new' ? (name.trim() ? { name: name.trim() } : {}) : who !== 'any' ? { personId: who } : {}) });
      setMade(r); onDone();
      return true;
    } catch (e) { setErr((e as Error).message); return false; }
  };
  const share = async () => { if (made) await Share.share(Platform.OS === 'ios' ? { url: made.link, message: 'Join my home in Kova' } : { message: `Join my home in Kova: ${made.link}` }).catch(() => {}); };
  const copyIt = async () => { if (made && await copy(made.link)) say('Link copied'); };

  return (
    <Sheet open={open} onClose={onClose} label="Invite someone">
      {made ? (
        <>
          <SheetHead kicker={`Invite · ${made.invite.roleLabel}`} title="Scan this, or send the link" icon="qr_code_2" color={C.amber} />
          <View style={{ alignItems: 'center', gap: SP[3] }}>
            <View style={{ borderRadius: R.md, backgroundColor: C.bone, padding: SP[3], overflow: 'hidden' }}><SvgXml xml={made.qrSvg} width={200} height={200} /></View>
            <T mono size={22} color={C.bone} center selectable>{made.code}</T>
            <T v="footnote" color={C.stone} center>{`One use, for 24 hours. On their phone: the Kova app → Scan the code, or open the link in a browser on your home’s Wi-Fi${made.link.startsWith('https') ? ' or anywhere' : ''}.`}</T>
          </View>
          <Card pad={SP[3]}><T v="footnote" mono color={C.bone2} selectable numberOfLines={3}>{made.link}</T></Card>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
            <View style={{ flexGrow: 1, flexBasis: 140 }}><Button full icon="send" label="Share the link" onPress={share} /></View>
            {canCopy ? <View style={{ flexGrow: 1, flexBasis: 140 }}><Button full kind="secondary" icon="content_copy" label="Copy" onPress={copyIt} /></View> : null}
          </View>
          <Button full kind="ghost" label="Done" onPress={onClose} />
        </>
      ) : (
        <>
          <SheetHead kicker="People and access" title="Invite someone" icon="person_add" color={C.green} />
          <Section title="Role" caption gap={SP[2]}><RolePicker value={role} onChange={setRole} /></Section>
          <Section title="Who is it for?" caption gap={SP[2]}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
              <Pill label="They’ll say" on={who === 'any'} onPress={() => setWho('any')} />
              {others.map(p => <Pill key={p.personId} label={p.name} on={who === p.personId} onPress={() => setWho(p.personId)} />)}
              <Pill icon="person_add" label="Someone new" on={who === 'new'} onPress={() => setWho('new')} />
            </View>
            {who === 'new' ? <TextField value={name} onChange={setName} label="Their name" placeholder="Their name (or let them type it)" /> : null}
            <T v="footnote" color={C.stone2}>{who === 'any' ? 'They pick themselves from the people without an account, or add themselves.' : who === 'new' ? 'They join as a new person in the home.' : 'They join as this person: their presence and notifications become theirs.'}</T>
          </Section>
          {roomsMatter(role) ? <Section title="Rooms they can use" caption gap={SP[2]}><RoomPicker value={rooms} onChange={setRooms} /></Section> : null}
          {role === 'guest' ? <Section title="Until" caption gap={SP[2]}><UntilPicker value={until} onChange={setUntil} /></Section> : null}
          {err ? <Notice compact icon="error" color={C.red} title={err} /> : null}
          <Button full icon="qr_code_2" label="Make the invite" onPress={make} />
        </>
      )}
    </Sheet>
  );
}

/** One member: role, rooms, end time, their own room, their devices (each with Sign out), and Remove. */
function MemberSheet({ m, onClose, onChanged, self }: { m: MemberView | null; onClose: () => void; onChanged: () => void; self: boolean }) {
  const { api, say } = useHub();
  const s = useSnap();
  const [role, setRole] = useState<Role>('adult');
  const [rooms, setRooms] = useState<string[]>([]);
  const [until, setUntil] = useState<number | null>(null);
  const [room, setRoom] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (m) { setRole(m.role); setRooms(m.rooms ?? []); setUntil(m.until ?? null); setRoom(m.room ?? null); setConfirm(false); } }, [m?.personId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const changed = role !== m.role || JSON.stringify(rooms) !== JSON.stringify(m.rooms ?? []) || until !== (m.until ?? null) || room !== (m.room ?? null);
  const save = async () => {
    const problem = inviteProblem({ role, rooms });
    if (problem) { say(problem, { error: true }); return false; }
    try { await api('PUT', `/api/members/${encodeURIComponent(m.personId)}`, { ...accessBody({ role, rooms, until }), room }); say(`${m.name} saved`); onChanged(); onClose(); return true; }
    catch (e) { say((e as Error).message, { error: true }); return false; }
  };
  const signOut = async (x: SessionView) => {
    try { await api('DELETE', `/api/sessions/${encodeURIComponent(x.id)}`); say(`${x.name} signed out`); onChanged(); return true; } catch (e) { say((e as Error).message, { error: true }); return false; }
  };
  const remove = async () => {
    if (!confirm) { setConfirm(true); return true; }
    try { await api('DELETE', `/api/members/${encodeURIComponent(m.personId)}`); say(`${m.name} no longer has access`); onChanged(); onClose(); return true; } catch (e) { say((e as Error).message, { error: true }); return false; }
  };
  return (
    <Sheet open onClose={onClose} label={m.name}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
        <Avatar name={m.name} size={48} ring={C.sheet} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T v="eyebrow" color={m.expired ? C.red : C.stone2}>{m.expired ? 'Access ended' : `${m.roleLabel} · seen ${seenWords(m.lastSeen)}`}</T>
          <T v="title" numberOfLines={2}>{m.name}</T>
        </View>
      </View>
      {self ? <T v="footnote" color={C.stone}>This is you. Another owner can change your role.</T> : <Section title="Role" caption gap={SP[2]}><RolePicker value={role} onChange={setRole} /></Section>}
      {roomsMatter(role) ? <Section title="Rooms they can use" caption gap={SP[2]}><RoomPicker value={rooms} onChange={setRooms} /></Section> : null}
      {role === 'guest' ? <Section title="Until" caption gap={SP[2]}><UntilPicker value={until} onChange={setUntil} /></Section> : null}
      <Section title="Their room" caption gap={SP[2]}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
          <Pill label="None" on={!room} onPress={() => setRoom(null)} />
          {s.rooms.filter(r => !roomsMatter(role) || rooms.includes(r.id)).map(r => <Pill key={r.id} icon={r.icon} label={r.name} on={room === r.id} onPress={() => setRoom(r.id)} />)}
        </View>
        <T v="footnote" color={C.stone2}>What “my room” means when they ask Kova.</T>
      </Section>
      <Button full kind={changed ? 'primary' : 'secondary'} icon="check" label="Save" onPress={changed ? save : undefined} />
      {self ? null : (
        <Section title="Sign-in" caption gap={SP[2]}>
          <T v="footnote" color={C.stone}>{m.user ? `${m.name} signs in as ${m.user}. Set a new password to reset it.` : `Give ${m.name} a username and password to sign in on any phone or browser.`}</T>
          <LoginFields user={m.user ?? null} personId={m.personId} name={m.name} onDone={onChanged} />
        </Section>
      )}
      <Section title={`Their devices · ${m.sessions.length}`} caption gap={SP[2]}>
        {m.sessions.length ? (
          <Group>
            {m.sessions.map((x, i) => (
              <Row key={x.id} first={!i} icon={sessionIcon(x.name)} title={x.name} sub={`Last used ${ago(x.lastSeen)}`} right={<View><Button size="sm" kind="danger" label="Sign out" onPress={() => signOut(x)} /></View>} />
            ))}
          </Group>
        ) : <T v="footnote" color={C.stone}>No devices signed in. An invite gives them one.</T>}
      </Section>
      {self ? null : (
        <View style={{ gap: SP[2] }}>
          <Button full kind="danger" icon="remove_circle" label={confirm ? `Tap again to remove ${m.name}` : 'Remove from the home’s accounts'} onPress={remove} />
          <T v="footnote" color={C.stone2} center>Every device of theirs is signed out, their notifications stop and their presence key changes. They stay one of the home’s people.</T>
        </View>
      )}
    </Sheet>
  );
}

/**
 * A username and password, to sign in on any phone or browser. `personId`: the owner setting someone else's (no
 * current password needed); without it, your own.
 */
function LoginFields({ user, personId, name, onDone }: { user: string | null; personId?: string; name?: string; onDone: () => void }) {
  const { api, say } = useHub();
  const [u, setU] = useState(user ?? '');
  const [pw, setPw] = useState('');
  const [cur, setCur] = useState('');
  useEffect(() => { setU(user ?? ''); setPw(''); setCur(''); }, [user, personId]);
  const own = !personId;
  const changing = !!user && !!pw && own;
  const ready = u.trim().length >= 3 && (pw.length >= 8 || (!!user && !pw && u.trim().toLowerCase() !== user)) && (!changing || !!cur);
  const save = async () => {
    try {
      const body = { user: u.trim(), ...(pw ? { password: pw } : {}), ...(changing ? { current: cur } : {}) };
      const r = await api<{ user: string }>('PUT', own ? '/api/me/login' : `/api/members/${encodeURIComponent(personId!)}/login`, body);
      say(own ? `Saved. Sign in anywhere as ${r.user}` : `${name ?? 'They'} can sign in as ${r.user}`);
      setPw(''); setCur(''); onDone(); return true;
    } catch (e) { say((e as Error).message, { error: true }); return false; }
  };
  return (
    <View style={{ gap: SP[2] }}>
      <TextField label="Username" placeholder="Username" value={u} onChange={setU} account="username" />
      {changing ? <TextField label="Current password" placeholder="Current password" value={cur} onChange={setCur} account="password" /> : null}
      <TextField label={user ? 'New password' : 'Password'} placeholder={user ? 'New password' : 'Password, 8 characters or more'} value={pw} onChange={setPw} account="newPassword" onSubmit={ready ? () => void save() : undefined} />
      <Button full kind={ready ? 'primary' : 'secondary'} icon="key" label={user ? 'Save' : 'Set username and password'} onPress={ready ? save : undefined} />
    </View>
  );
}

/** The owner on the master key (or a key from before accounts): which of the people are they? */
function ThisIsMe({ onDone }: { onDone: () => void }) {
  const s = useSnap();
  const { api, signIn, refresh, say } = useHub();
  const claim = async (personId: string) => {
    try {
      const r = await api<{ token?: string }>('POST', '/api/me/claim', { personId, name: appName(Platform.OS) });
      if (r.token) await signIn(r.token); else await refresh();
      say('This phone is yours now'); onDone();
      return true;
    } catch (e) { say((e as Error).message, { error: true }); return false; }
  };
  if (!s.people.length) return null;
  return (
    <Notice icon="key" color={C.blue} eyebrow="Owner" title="Which of the people are you?" text="This phone uses the hub’s master key. Pick yourself and it gets a key of its own: Activity says it was you, and your notifications and presence are yours.">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
        {s.people.map(p => <Pill key={p.id} label={p.name} onPress={() => void claim(p.id)} />)}
      </View>
    </Notice>
  );
}

/**
 * More → People and access. The owner: every member with their role and last seen, invites waiting, people without
 * an account, and keys from before accounts; Invite. Anyone else: their own account and devices.
 */
export function PeopleScreen() {
  const s = useSnap();
  const nav = useNav();
  const { api, say } = useHub();
  const me = meOf(s);
  const manage = features(me).manage;
  const [data, setData] = useState<Members | null>(null);
  const [mine, setMine] = useState<SessionView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [member, setMember] = useState<string | null>(null);
  const [inviting, setInviting] = useState<{ personId?: string } | null>(null);
  const [resent, setResent] = useState<Made | null>(null);
  const roomName = (id: string) => s.rooms.find(r => r.id === id)?.name ?? id;
  const personName = (id: string) => s.people.find(p => p.id === id)?.name ?? id;

  const load = useCallback(() => {
    setErr(null);
    if (manage) return api<Members>('GET', '/api/members').then(setData).catch(e => setErr((e as Error).message));
    return api<{ sessions: SessionView[] }>('GET', '/api/sessions').then(r => setMine(r.sessions ?? [])).catch(e => setErr((e as Error).message));
  }, [api, manage]);
  useEffect(() => { void load(); }, [load]);

  const signOut = async (x: SessionView) => {
    try { await api('DELETE', `/api/sessions/${encodeURIComponent(x.id)}`); say(`${x.name} signed out`); void load(); return true; } catch (e) { say((e as Error).message, { error: true }); return false; }
  };
  const resend = async (i: InviteView) => {
    try { const r = await api<Made>('POST', `/api/invites/${encodeURIComponent(i.id)}/resend`); setResent(r); setInviting({}); void load(); return true; } catch (e) { say((e as Error).message, { error: true }); return false; }
  };
  const cancel = async (i: InviteView) => {
    try { await api('DELETE', `/api/invites/${encodeURIComponent(i.id)}`); say('Invite cancelled'); void load(); return true; } catch (e) { say((e as Error).message, { error: true }); return false; }
  };
  const unlinked = me.role === 'owner' && !me.personId;
  const current = data?.members.find(m => m.personId === member) ?? null;

  const you = (
    <Card pad={SP[4]} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
      <Avatar name={me.name} size={48} ring={C.card} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T v="eyebrow" color={C.stone2}>Signed in as</T>
        <T v="title" numberOfLines={2}>{me.name}</T>
        <T v="footnote" color={C.stone}>{roleLine(me, roomName)}</T>
      </View>
    </Card>
  );

  return (
    <Screen title={manage ? 'People and access' : 'Your account'} over={s.home.name} onBack={() => nav.goBack()} onRefresh={() => void load()} gap={SP[6]}>
      {unlinked ? <ThisIsMe onDone={() => void load()} /> : you}
      {me.personId ? (
        <Section title="Your sign-in" caption gap={SP[2]}>
          <T v="footnote" color={C.stone}>{me.user ? `You sign in as ${me.user} on any phone or browser.` : 'Set a username and password to sign in on any phone or browser, without a code.'}</T>
          <LoginFields user={me.user ?? null} onDone={() => void load()} />
        </Section>
      ) : null}
      {err ? <Empty compact icon="cloud_off" title="Couldn’t load them" text={err} action="Try again" onAction={() => void load()} /> : null}

      {manage ? (
        <>
          <Button full icon="person_add" label="Invite someone" onPress={() => { setResent(null); setInviting({}); }} />
          <Section title={`Members${data ? ` · ${data.members.length}` : ''}`} caption gap={SP[2]}>
            {!data && !err ? <Skeleton h={128} r={R.lg} />
              : data?.members.length ? (
                <Card style={{ overflow: 'hidden' }}>
                  {data.members.map((m, i) => (
                    <Press key={m.personId} onPress={() => setMember(m.personId)} give="soft" label={`${m.name}, ${m.roleLabel}`}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], paddingHorizontal: SP[4], paddingVertical: SP[3], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
                      <Avatar name={m.name} size={36} ring={C.card} home={s.people.find(p => p.id === m.personId)?.home} />
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <T v="headline" numberOfLines={2}>{m.personId === me.personId ? `${m.name} (you)` : m.name}</T>
                        <T v="footnote" color={m.expired ? C.red : C.stone} numberOfLines={2}>{m.expired ? 'Access ended' : `${roleLine({ roleLabel: m.roleLabel, rooms: roomsMatter(m.role) ? m.rooms ?? [] : null, until: m.until ?? null }, roomName)} · ${m.sessions.length ? `seen ${seenWords(m.lastSeen)}` : 'no devices'}`}</T>
                      </View>
                      <Icon name="chevron_right" size={20} color={C.stone2} />
                    </Press>
                  ))}
                </Card>
              ) : <Empty compact icon="group" title="No accounts yet" text="Invite the people who live here, or a guest, and each gets their own login." />}
          </Section>

          {data?.invites.length ? (
            <Section title={`Invites waiting · ${data.invites.length}`} caption gap={SP[2]}>
              <Group>
                {data.invites.map((i, n) => (
                  <View key={i.id} style={{ padding: SP[4], gap: SP[3], borderTopWidth: n ? 1 : 0, borderTopColor: C.hairline }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
                      <Icon name="send" size={20} color={i.expired ? C.stone2 : C.amber} />
                      <T v="callout" color={C.bone2} style={{ flex: 1, minWidth: 0 }}>{inviteLine(i, personName)}</T>
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
                      <View style={{ flexGrow: 1 }}><Button full size="sm" kind="secondary" icon="refresh" label="Resend" onPress={() => resend(i)} /></View>
                      <View style={{ flexGrow: 1 }}><Button full size="sm" kind="ghost" label="Cancel" onPress={() => cancel(i)} /></View>
                    </View>
                  </View>
                ))}
              </Group>
            </Section>
          ) : null}

          {data?.others.length ? (
            <Section title="Live here, no account" caption gap={SP[2]}>
              <Group>
                {data.others.map((p, i) => <Row key={p.personId} first={!i} icon="person" title={p.name} sub="Presence only · tap to invite them" onPress={() => { setResent(null); setInviting({ personId: p.personId }); }} />)}
              </Group>
            </Section>
          ) : null}

          {data?.ownerKeys.length ? (
            <Section title="Owner keys from before accounts" caption gap={SP[2]}>
              <Group note="Signed in before the home had accounts: they have the owner’s access. Sign out any you don’t know.">
                {data.ownerKeys.map((x, i) => <Row key={x.id} first={!i} icon={sessionIcon(x.name)} title={x.current ? `${x.name} (this one)` : x.name} sub={`Last used ${ago(x.lastSeen)}`} right={x.current ? undefined : <View><Button size="sm" kind="danger" label="Sign out" onPress={() => signOut(x)} /></View>} />)}
              </Group>
            </Section>
          ) : null}
          <T v="footnote" color={C.stone2} center>The hub’s master key always works for the owner, to get back in on a new device.</T>
        </>
      ) : (
        <Section title="Your devices" caption gap={SP[2]}>
          {!mine && !err ? <Skeleton h={64} r={R.lg} /> : mine?.length ? (
            <Group note="Sign in another device of yours from More → Sign in a browser.">
              {mine.map((x, i) => <Row key={x.id} first={!i} icon={sessionIcon(x.name)} title={x.current ? `${x.name} (this one)` : x.name} sub={`Last used ${ago(x.lastSeen)}`} right={x.current ? undefined : <View><Button size="sm" kind="danger" label="Sign out" onPress={() => signOut(x)} /></View>} />)}
            </Group>
          ) : <T v="footnote" color={C.stone}>Just this one.</T>}
        </Section>
      )}

      <InviteSheet open={!!inviting} onClose={() => { setInviting(null); setResent(null); }} start={inviting ?? undefined} data={data} resend={resent} onDone={() => void load()} />
      <MemberSheet m={current} self={current?.personId === me.personId} onClose={() => setMember(null)} onChanged={() => void load()} />
    </Screen>
  );
}
