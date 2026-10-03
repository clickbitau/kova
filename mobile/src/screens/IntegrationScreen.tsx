import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { C, R, SP, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useIntegrationSetup } from '../state/integrations';
import type { Stack } from '../navigation';
import { canCopy, copy } from '../native/clipboard';
import {
  actionButton, bySection, codeFromPaste, describeResult, errorLines, fromForm, pairWords, pathKey, planActions, pollsAfter, problems, savedWords, setIn, statusOf, toForm,
  type Action, type ActionResult, type CatalogItem, type Form, type Home, type PairState,
} from '../logic/integrations';
import { Icon } from '../ui/Icon';
import { Button, Card, IconButton, IconWell, Press, Sheet, Skeleton } from '../ui/kit';
import { animateLayout, haptic } from '../ui/motion';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Fields } from './IntegrationFields';

type Path = (string | number)[];
type Msg = { ok: boolean; text: string } | null;

const TONE = { ok: C.green, warn: C.amber, idle: C.stone } as const;

/** A note under a button: green when it went well, amber or red when not; the hub's error one line per problem. */
function Note({ msg, err }: { msg?: Msg; err?: string | null }) {
  if (!msg && !err) return null;
  const bad = !!err;
  const color = bad ? C.redText : msg!.ok ? C.green : C.amber;
  const lines = err ? errorLines(err) : [msg!.text];
  return (
    <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: SP[2], padding: SP[3], borderRadius: R.md, backgroundColor: bad ? C.redTint : alpha(color, 0.1), borderWidth: 1, borderColor: bad ? C.redLine : alpha(color, 0.3) }}>
      <Icon name={bad ? 'error' : msg!.ok ? 'check_circle' : 'warning'} size={18} color={color} fill style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 2 }}>
        {lines.map((l, i) => <T key={i} v="callout" weight={600} color={color}>{l}</T>)}
      </View>
    </View>
  );
}

/** What an action answered: its sentence, a code to scan or a pairing code large (with Copy), the rest as rows. */
function Result({ r }: { r: ActionResult }) {
  return (
    <View style={{ gap: SP[3], padding: SP[3], borderRadius: R.md, backgroundColor: C.inset, borderWidth: 1, borderColor: C.edge }}>
      {r.qrSvg ? (
        <View style={{ alignSelf: 'center', borderRadius: R.md, backgroundColor: C.bone, padding: SP[3], overflow: 'hidden' }}>
          <SvgXml xml={r.qrSvg} width={208} height={208} />
        </View>
      ) : null}
      {r.code ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
          <T mono size={30} tracking={0.12} color={C.bone} selectable style={{ flex: 1 }}>{r.code}</T>
          {canCopy ? <IconButton icon="content_copy" label="Copy the code" size={38} onPress={() => { void copy(r.code!).then(ok => ok && haptic.success()); }} /> : null}
        </View>
      ) : null}
      {r.headline ? <T v="callout" color={C.bone2}>{r.headline}</T> : null}
      {r.rows.map((x, i) => (
        <View key={i} style={{ gap: 2, paddingTop: i || r.headline || r.code ? SP[2] : 0, borderTopWidth: i || r.headline || r.code ? 1 : 0, borderTopColor: C.hairline }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <T v="eyebrow" color={C.stone2} style={{ flex: 1 }}>{x.label}</T>
            {x.copy && canCopy ? <IconButton icon="content_copy" label={`Copy ${x.label}`} size={30} tone="ghost" color={C.stone} onPress={() => { void copy(x.value).then(ok => ok && haptic.success()); }} /> : null}
          </View>
          <T v="footnote" mono={x.mono} color={C.bone2} selectable>{x.value}</T>
        </View>
      ))}
    </View>
  );
}

/** A step number in a circle; a check once it's done. */
function Step({ n, done, active }: { n: number; done?: boolean; active?: boolean }) {
  return (
    <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: done ? alpha(C.green, 0.16) : active ? C.amber : C.control }}>
      {done ? <Icon name="check" size={16} color={C.green} /> : <T v="labelSm" color={active ? C.onAmber : C.bone2}>{String(n)}</T>}
    </View>
  );
}

interface Runner {
  inputs: Record<string, Form>;
  setInput: (id: string, path: Path, v: unknown) => void;
  run: (a: Action) => Promise<boolean>;
  results: Record<string, { res?: ActionResult; err?: string; pair?: { state: PairState; error?: string } }>;
}

/** An action's own inputs, button and answer (pair, add a device, fetch keys, find speakers, show a code). */
function ActionCard({ a, r, home, tool, folded }: { a: Action; r: Runner; home: Home; tool?: boolean; folded?: boolean }) {
  const b = actionButton(a);
  const out = r.results[a.id];
  const pw = out?.pair ? pairWords(out.pair.state, out.pair.error) : null;
  // Once it's set up, an action with a form of its own (fetch keys, sign in) waits folded until it's wanted.
  const [open, setOpen] = useState(!folded || !a.fields?.length);
  const head = (
    <View style={{ flexDirection: 'row', gap: SP[3], alignItems: open ? 'flex-start' : 'center' }}>
      <IconWell icon={a.icon} color={tool ? C.bone : C.amber} bg={tool ? C.selected : undefined} size={36} />
      <View style={{ flex: 1, gap: 3 }}>
        <T v="headline">{a.label}</T>
        {a.help ? <T v="footnote" color={C.stone} numberOfLines={open ? undefined : 2}>{a.help}</T> : null}
      </View>
      {open ? null : <Icon name="expand_more" size={22} color={C.stone} />}
    </View>
  );
  if (!open) {
    return (
      <Card style={{ overflow: 'hidden' }}>
        <Press onPress={() => { animateLayout(); setOpen(true); }} give="soft" label={a.label} hint="Opens it" style={{ padding: SP[4] }}>{head}</Press>
      </Card>
    );
  }
  return (
    <Card style={{ padding: SP[4], gap: SP[4] }}>
      {head}
      {a.fields?.length ? <Fields fields={a.fields} form={r.inputs[a.id] ?? {}} set={(p, v) => r.setInput(a.id, p, v)} home={home} bad={{}} /> : null}
      <Button kind={tool ? 'secondary' : 'primary'} icon={b.icon} label={b.label} onPress={() => r.run(a)} />
      {pw ? (
        <View style={{ flexDirection: 'row', gap: SP[2], alignItems: 'center' }} accessibilityLiveRegion="polite">
          <Icon name={pw.tone === 'ok' ? 'check_circle' : pw.tone === 'wait' ? 'pending' : 'error'} size={18} color={pw.tone === 'ok' ? C.green : pw.tone === 'wait' ? C.amber : C.redText} fill={pw.tone !== 'wait'} />
          <T v="callout" weight={600} color={pw.tone === 'ok' ? C.green : pw.tone === 'wait' ? C.amber : C.redText} style={{ flex: 1 }}>{pw.text}</T>
        </View>
      ) : null}
      {out?.res ? <Result r={out.res} /> : null}
      <Note err={out?.err} />
    </Card>
  );
}

/** Sign in somewhere else, then bring the code back: two numbered steps, with the part that surprises people said plainly. */
function SignIn({ open, finish, r, home, name, linked }: { open: Action[]; finish: Action | null; r: Runner; home: Home; name: string; linked: boolean }) {
  const opened = open.some(a => r.results[a.id]?.res);
  const fin = finish ? r.results[finish.id] : undefined;
  const done = !!fin?.res;
  // The catalog's own help may already say the page after sign-in won't load; then step 2 just says where to paste.
  const told = open.some(a => /address/i.test(a.help ?? ''));
  return (
    <View style={{ gap: SP[2] }}>
      <T v="overline" color={C.stone2} style={{ paddingHorizontal: 4 }}>{linked ? 'Link again' : 'Link your account'}</T>
      <Card style={{ padding: SP[4], gap: SP[5] }}>
        {open.map((a, i) => {
          const out = r.results[a.id];
          return (
            <View key={a.id} style={{ gap: SP[3] }}>
              {i ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: C.line }} /><T v="eyebrow" color={C.stone2}>or</T><View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
                </View>
              ) : null}
              <View style={{ flexDirection: 'row', gap: SP[3] }}>
                <Step n={1} done={opened} active={!opened} />
                <View style={{ flex: 1, gap: 3 }}>
                  <T v="headline">{a.label}</T>
                  {a.help ? <T v="footnote" color={C.stone}>{a.help}</T> : <T v="footnote" color={C.stone}>{`Sign in with your ${name} account in the browser.`}</T>}
                </View>
              </View>
              {a.fields?.length ? <Fields fields={a.fields} form={r.inputs[a.id] ?? {}} set={(p, v) => r.setInput(a.id, p, v)} home={home} bad={{}} /> : null}
              <Button kind={opened ? 'secondary' : 'primary'} icon="open_in_new" label={actionButton(a).label} onPress={() => r.run(a)} />
              <Note err={out?.err} />
            </View>
          );
        })}
        {finish ? (
          <View style={{ gap: SP[3], paddingTop: SP[4], borderTopWidth: 1, borderTopColor: C.hairline }}>
            <View style={{ flexDirection: 'row', gap: SP[3] }}>
              <Step n={2} done={done} active={opened && !done} />
              <View style={{ flex: 1, gap: 3 }}>
                <T v="headline">{finish.label}</T>
                <T v="footnote" color={C.stone}>{told ? 'Come back here and paste the whole address the sign-in ended on.' : 'After you sign in, the page you land on may not load. That’s expected. Copy its whole address from the browser’s address bar and paste it here.'}</T>
                {finish.help ? <T v="footnote" color={C.stone2}>{finish.help}</T> : null}
              </View>
            </View>
            <Fields fields={finish.fields ?? []} form={r.inputs[finish.id] ?? {}} set={(p, v) => r.setInput(finish.id, p, v)} home={home} bad={{}} pasteCode />
            <Button icon="check" label={finish.label} kind={opened || !done ? 'primary' : 'secondary'} onPress={() => r.run(finish)} />
            {done ? <Note msg={{ ok: true, text: `Linked. ${fin?.res?.headline && fin.res.headline !== 'Done.' ? fin.res.headline : `Kova is talking to ${name}.`}` }} /> : <Note err={fin?.err} />}
          </View>
        ) : null}
      </Card>
    </View>
  );
}

export function IntegrationScreen({ route, navigation }: NativeStackScreenProps<Stack, 'Integration'>) {
  const { id } = route.params;
  const s = useSnap();
  const { api, say } = useHub();
  const setup = useIntegrationSetup();
  const known = setup.catalog?.find(c => c.id === id);
  const run = bySection(s.integrations).find(i => i.id === id);
  const item: CatalogItem | null = known ?? (run || setup.catalog ? { id, name: run?.name ?? id, icon: run?.icon ?? 'extension', kind: (run?.kind as 'Local') ?? 'Local', description: 'Built into Kova. There’s nothing to set up.', fields: [], actions: [], apply: 'hot' } : null);
  const saved = setup.config ? setup.config[id] : undefined;
  const isNew = saved === undefined && !run;
  const home: Home = useMemo(() => ({ rooms: s.rooms.map(r => ({ id: r.id, name: r.name })), people: s.people.map(p => ({ id: p.id, name: p.name })) }), [s.rooms, s.people]);

  const [form, setFormState] = useState<Form>(() => (known ? toForm(known.fields, saved) : {}));
  const dirty = useRef(false);
  // The saved settings arrive (or change after a save): the form follows unless something was typed.
  useEffect(() => { if (known && !dirty.current) setFormState(toForm(known.fields, saved)); }, [known, saved]);
  const set = (path: Path, v: unknown) => { dirty.current = true; setFormState(f => setIn(f, path, v)); setMsg(null); setErr(null); };
  const [tried, setTried] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const probs = known ? problems(known.fields, form) : [];
  const bad: Record<string, string> = tried ? Object.fromEntries(probs.map(p => [pathKey(p.path), p.message])) : {};

  // Actions: inputs, answers, and pairing that's watched until it's approved.
  const [inputs, setInputs] = useState<Record<string, Form>>({});
  const [results, setResults] = useState<Runner['results']>({});
  const polls = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  useEffect(() => () => { Object.values(polls.current).forEach(clearInterval); }, []);
  const put = (aid: string, v: Runner['results'][string]) => { animateLayout(); setResults(r => ({ ...r, [aid]: v })); };
  const watch = (a: Action, res: ActionResult) => {
    clearInterval(polls.current[a.id]);
    polls.current[a.id] = setInterval(async () => {
      try {
        const p = await api<{ status: PairState; error?: string }>('GET', a.path);
        if (p.status === 'pending') { setResults(r => ({ ...r, [a.id]: { res, pair: { state: 'pending', error: p.error } } })); return; }
        clearInterval(polls.current[a.id]);
        put(a.id, { res: p.status === 'approved' ? describeResult(p) : res, pair: { state: p.status, error: p.error } });
        if (p.status === 'approved') { haptic.success(); say(`${item?.name ?? 'It'} is paired`); void setup.reload(); }
      } catch { /* keep asking */ }
    }, 2500);
  };
  const runner: Runner = {
    inputs, results,
    setInput: (aid, path, v) => setInputs(x => ({ ...x, [aid]: setIn(x[aid] ?? {}, path, v) })),
    run: async (a: Action) => {
      const body = a.method === 'POST' ? fromForm(a.fields ?? [], inputs[a.id]) : undefined;
      if (body && typeof body.code === 'string') body.code = codeFromPaste(body.code);
      const missing = (a.fields ?? []).filter(f => f.required && !String((inputs[a.id] ?? {})[f.key] ?? '').trim());
      if (missing.length) { put(a.id, { err: `${missing.map(f => f.label).join(' and ')} ${missing.length > 1 ? 'are' : 'is'} needed` }); return false; }
      try {
        const r = await api<Record<string, unknown>>(a.method, a.path, body);
        // A POST may have saved settings (keys fetched, speakers found, an app made): read them again.
        if (a.method === 'POST') void setup.reload();
        if (a.opensUrl && typeof r?.url === 'string') {
          await Linking.openURL(r.url);
          put(a.id, { res: { headline: typeof r.next === 'string' ? r.next : 'Opened in the browser.', rows: [] } });
          return true;
        }
        const res = describeResult(r);
        if (pollsAfter(a, r)) { put(a.id, { res, pair: { state: 'pending' } }); watch(a, res); }
        else put(a.id, { res });
        return true;
      } catch (e) {
        put(a.id, { err: (e as Error).message });
        return false;
      }
    },
  };

  const save = async () => {
    if (!known) return false;
    setTried(true);
    if (probs.length) { setErr(probs.length === 1 ? 'One thing still needs filling in: it’s marked above.' : `${probs.length} things still need filling in: they’re marked above.`); return false; }
    setErr(null); setMsg(null);
    try {
      const r = await api<{ applied: boolean; restartRequired: boolean; status: { ok: boolean; note?: string } | null }>('PUT', `/api/integrations/config/${encodeURIComponent(id)}`, fromForm(known.fields, form));
      dirty.current = false;
      await setup.reload();
      animateLayout();
      setMsg(savedWords(r, isNew));
      setTried(false);
      say(`${known.name} saved`);
      return true;
    } catch (e) { setErr((e as Error).message); return false; }
  };
  const test = async () => {
    if (!known) return false;
    setErr(null); setMsg(null);
    try {
      const r = await api<{ ok: boolean; message: string }>('POST', `/api/integrations/${encodeURIComponent(id)}/test`, { config: fromForm(known.fields, form) });
      animateLayout();
      setMsg({ ok: r.ok, text: r.message });
      return r.ok;
    } catch (e) { setErr((e as Error).message); return false; }
  };
  const remove = async () => {
    try {
      await api('DELETE', `/api/integrations/config/${encodeURIComponent(id)}`);
      setConfirm(false);
      await setup.reload();
      say(`${item?.name ?? id} removed`);
      navigation.goBack();
      return true;
    } catch (e) { setConfirm(false); setErr((e as Error).message); return false; }
  };

  if (!item) {
    return (
      <Screen title={run?.name ?? 'Integration'} onBack={() => navigation.goBack()} gap={SP[5]}>
        {setup.error ? <Note err={`Couldn’t load the settings: ${setup.error}`} /> : <><Skeleton h={120} r={R.lg} /><Skeleton h={220} r={R.lg} /></>}
        {setup.error ? <Button kind="secondary" icon="refresh" label="Try again" onPress={() => setup.reload()} /> : null}
      </Screen>
    );
  }

  const st = statusOf(id, s.integrations, saved !== undefined, known);
  const plan = planActions(item);
  const hasFields = item.fields.length > 0;
  const required = item.fields.some(f => f.required);
  const fill = isNew && required;
  const linked = !!run?.ok;
  const top = (plan.signIn || plan.connect.length) ? (
    <View style={{ gap: SP[4] }}>
      {plan.signIn ? <SignIn open={plan.signIn.open} finish={plan.signIn.finish} r={runner} home={home} name={item.name.replace(/^.*\s(?=\S+$)/, '')} linked={linked} /> : null}
      {plan.connect.length ? (
        <View style={{ gap: SP[2] }}>
          <T v="overline" color={C.stone2} style={{ paddingHorizontal: 4 }}>{plan.signIn ? 'Or' : 'Connect'}</T>
          <View style={{ gap: SP[3] }}>{plan.connect.map(a => <ActionCard key={a.id} a={a} r={runner} home={home} folded={saved !== undefined} />)}</View>
        </View>
      ) : null}
    </View>
  ) : null;

  const settings = known && (hasFields || isNew) ? (
    <View style={{ gap: SP[3] }}>
      {hasFields ? (
        <View style={{ gap: SP[2] }}>
          <T v="overline" color={C.stone2} style={{ paddingHorizontal: 4 }}>Settings</T>
          <Card style={{ padding: SP[4] }}>
            <Fields fields={item.fields} form={form} set={set} home={home} bad={bad} />
          </Card>
        </View>
      ) : null}
      <Note msg={msg} err={err} />
      <View style={{ flexDirection: 'row', gap: SP[2] }}>
        <View style={{ flex: 1 }}>
          <Button full icon={isNew ? 'add_link' : 'check'} label={isNew ? (hasFields ? 'Save and connect' : 'Turn on') : 'Save'} doneLabel="Saved" onPress={save} />
        </View>
        {item.testable ? <Button kind="secondary" icon="science" label="Test" onPress={test} /> : null}
      </View>
      <T v="footnote" color={C.stone2} style={{ paddingHorizontal: 4 }}>{item.apply === 'hot' ? 'Saving restarts just this integration, straight away.' : 'Saved settings take effect when the hub restarts.'}</T>
    </View>
  ) : null;

  return (
    <Screen title={item.name} over={`${item.kind} · ${isNew ? 'Add integration' : 'Integration'}`} onBack={() => navigation.goBack()} gap={SP[6]}
      onRefresh={() => void setup.reload()} refreshing={setup.loading && !!setup.catalog}>
      <Card style={{ padding: SP[4], gap: SP[3] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
          <IconWell icon={item.icon} color={st.tone === 'idle' ? C.bone : TONE[st.tone]} bg={st.tone === 'idle' ? C.selected : undefined} size={44} />
          <View style={{ flex: 1, gap: 2 }} accessibilityLiveRegion="polite">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: TONE[st.tone] }} />
              <T v="headline" color={st.tone === 'warn' ? C.amber : C.bone}>{st.title}</T>
            </View>
            <T v="footnote" color={st.tone === 'warn' ? C.amber : C.stone}>{st.text}</T>
          </View>
        </View>
        <T v="callout" color={C.stone} style={{ paddingTop: SP[3], borderTopWidth: 1, borderTopColor: C.hairline }}>{item.description}</T>
      </Card>

      {fill ? settings : top}
      {fill ? top : settings}

      {plan.tools.length ? (
        <View style={{ gap: SP[2] }}>
          <T v="overline" color={C.stone2} style={{ paddingHorizontal: 4 }}>Tools</T>
          <View style={{ gap: SP[3] }}>{plan.tools.map(a => <ActionCard key={a.id} a={a} r={runner} home={home} tool />)}</View>
        </View>
      ) : null}

      {known && saved !== undefined ? (
        <Button kind="danger" icon="delete" label={`Remove ${item.name}`} onPress={() => setConfirm(true)} />
      ) : null}

      <Sheet open={confirm} onClose={() => setConfirm(false)} label={`Remove ${item.name}`}>
        <View style={{ gap: SP[4] }}>
          <View style={{ flexDirection: 'row', gap: SP[3], alignItems: 'center' }}>
            <IconWell icon="delete" color={C.red} size={44} />
            <T v="title" size={20} style={{ flex: 1 }}>{`Remove ${item.name}?`}</T>
          </View>
          <T v="body" color={C.bone2}>{`Its settings are deleted from the hub${run?.devices ? `, and its ${run.devices} device${run.devices === 1 ? '' : 's'} leave Kova` : ''}. Modes and automations that use them skip them. To bring it back, set it up again${item.fields.some(f => f.type === 'password') || plan.signIn ? ', with its passwords and sign-in' : ''}.`}</T>
          <Button kind="danger" full icon="delete" label="Remove" onPress={remove} />
          <Button kind="ghost" full label="Keep it" onPress={() => setConfirm(false)} />
        </View>
      </Sheet>
    </Screen>
  );
}
