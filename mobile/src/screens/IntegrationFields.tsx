import { useRef, useState, type ReactNode } from 'react';
import { TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { C, F, R, SP, alpha } from '../theme';
import { useHub } from '../state/hub';
import { canPaste, paste } from '../native/clipboard';
import {
  blankRow, getIn, isLocked, keyPath, nounOf, optionsFor, pathKey, rowSummary, segmentable,
  type Field, type Form, type Home, type Option,
} from '../logic/integrations';
import { Icon } from '../ui/Icon';
import { Button, IconButton, Press, Segmented, Sheet } from '../ui/kit';
import { animateLayout, haptic } from '../ui/motion';
import { T } from '../ui/Text';

// The setup form's controls, generated from the hub's catalog: text, secrets with show/hide, numbers, choices
// (segmented when there are a few short ones, a sheet otherwise, rooms and people from the home), and lists of
// rows (arrays and maps) that add, fold and remove with undo. Help under each field; problems in red under it.

type Path = (string | number)[];

/** A field's caption: the label, "Required" when it is, and anything on the right. */
function Label({ text, required, right }: { text: string; required?: boolean; right?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], minHeight: 20 }}>
      <T v="labelSm" color={C.bone2} style={{ flexShrink: 1 }}>{text}</T>
      {required ? <T v="micro" size={10.5} color={C.stone2}>REQUIRED</T> : null}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

const Help = ({ text }: { text?: string }) => (text ? <T v="footnote" color={C.stone2}>{text}</T> : null);
const Problem = ({ text }: { text?: string }) => (text ? (
  <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center' }} accessibilityLiveRegion="polite">
    <Icon name="error" size={14} color={C.redText} fill />
    <T v="footnote" weight={600} color={C.redText}>{text}</T>
  </View>
) : null);

/** A text box in the app's style: inset, amber edge while typing, red when there's a problem, tools on the right. */
export function Input({ value, onChange, placeholder, secure, keyboard, bad, label, right, mono, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string; secure?: boolean; keyboard?: KeyboardTypeOptions; bad?: boolean; label: string;
  right?: ReactNode; mono?: boolean; autoFocus?: boolean;
}) {
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingLeft: SP[3], paddingRight: right ? 4 : SP[3], borderRadius: R.md, backgroundColor: C.inset,
      borderWidth: 1, borderColor: bad ? C.redLine : focus ? C.amberLine : C.edge }}>
      <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.stone2} secureTextEntry={secure} keyboardType={keyboard}
        autoCapitalize="none" autoCorrect={false} spellCheck={false} autoFocus={autoFocus} accessibilityLabel={label}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={{ flex: 1, minWidth: 0, color: C.bone, fontFamily: mono ? F.mono : F[500], fontSize: 16, paddingVertical: 11 }} />
      {right}
    </View>
  );
}

/** A secret: "Saved" with Change while the hub keeps it; a hidden box with show/hide while typing a new one. */
function SecretInput({ f, value, onChange, bad }: { f: Field; value: string; onChange: (v: string) => void; bad?: boolean }) {
  const [show, setShow] = useState(false);
  const [was, setWas] = useState<string | null>(null);
  if (isLocked(f, value)) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], minHeight: 48, paddingLeft: SP[3], paddingRight: 4, borderRadius: R.md, backgroundColor: C.inset, borderWidth: 1, borderColor: C.edge }}>
        <Icon name="lock" size={17} color={C.green} fill />
        <T v="callout" color={C.bone2} style={{ flex: 1 }}>Saved on the hub</T>
        <View><Button size="sm" kind="ghost" label="Change" onPress={() => { setWas(value); onChange(''); }} /></View>
      </View>
    );
  }
  return (
    <View style={{ gap: SP[1] + 2 }}>
      <Input label={f.label} value={value} onChange={onChange} placeholder={f.placeholder} secure={!show} bad={bad} autoFocus={was != null}
        right={<IconButton icon={show ? 'visibility_off' : 'visibility'} label={show ? `Hide ${f.label}` : `Show ${f.label}`} size={38} tone="ghost" color={C.stone} onPress={() => setShow(v => !v)} />} />
      {was != null ? (
        <Press onPress={() => { onChange(was); setWas(null); }} hitSlop={10} label="Keep the saved one" style={{ alignSelf: 'flex-start' }}>
          <T v="labelSm" color={C.amber}>Keep the saved one</T>
        </Press>
      ) : null}
    </View>
  );
}

/** A choice from many: looks like a field, opens a sheet of the options with the chosen one ticked. */
function SelectSheet({ f, value, options, onChange, bad }: { f: Field; value: string; options: Option[]; onChange: (v: string) => void; bad?: boolean }) {
  const [open, setOpen] = useState(false);
  const cur = options.find(o => o.value === value);
  const empty = f.options === 'rooms' ? 'No rooms yet. Add them in Customise home.' : f.options === 'people' ? 'No people yet. Add them in Customise home.' : 'Nothing to choose from.';
  return (
    <>
      <Press onPress={() => setOpen(true)} give="soft" label={`${f.label}: ${cur?.label ?? (value || 'not chosen')}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], minHeight: 48, paddingHorizontal: SP[3], borderRadius: R.md, backgroundColor: C.inset, borderWidth: 1, borderColor: bad ? C.redLine : C.edge }}>
        {f.options === 'rooms' ? <Icon name="meeting_room" size={18} color={cur ? C.bone2 : C.stone2} /> : f.options === 'people' ? <Icon name="person" size={18} color={cur ? C.bone2 : C.stone2} /> : null}
        <T v="body" color={cur || value ? C.bone : C.stone2} style={{ flex: 1 }} numberOfLines={1}>{cur?.label ?? (value || 'Choose…')}</T>
        <Icon name="expand_more" size={20} color={C.stone} />
      </Press>
      <Sheet open={open} onClose={() => setOpen(false)} label={f.label}>
        <View style={{ gap: SP[3] }}>
          <T v="title" size={20}>{f.label}</T>
          {f.help ? <T v="callout" color={C.stone}>{f.help}</T> : null}
          {options.length ? (
            <View style={{ borderRadius: R.lg, backgroundColor: C.card, borderWidth: 1, borderColor: C.edge, overflow: 'hidden' }}>
              {[...(f.required ? [] : [{ value: '', label: 'None' }]), ...options].map((o, i) => {
                const on = o.value === value;
                return (
                  <Press key={o.value || '-'} role="radio" selected={on} haptic="select" label={o.label} onPress={() => { onChange(o.value); setOpen(false); }}
                    style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: SP[4], gap: SP[3], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline, backgroundColor: on ? alpha(C.amber, 0.08) : 'transparent' }}>
                    <T v="body" weight={on ? 700 : 500} color={o.value ? C.bone : C.stone} style={{ flex: 1 }}>{o.label}</T>
                    {on ? <Icon name="check" size={20} color={C.amber} /> : null}
                  </Press>
                );
              })}
            </View>
          ) : <T v="callout" color={C.stone}>{empty}</T>}
        </View>
      </Sheet>
    </>
  );
}

export interface FieldProps {
  f: Field;
  form: Form;
  /** Where this field's row sits in the form (empty at the top level). */
  base: Path;
  set: (path: Path, v: unknown) => void;
  home: Home;
  /** Problems by path, shown once Save was tried. */
  bad: Record<string, string>;
  /** A code pasted from a sign-in page: a Paste button, and the code taken out of a whole address. */
  pasteCode?: boolean;
}

/** One field, any type. */
export function FieldInput({ f, form, base, set, home, bad, pasteCode }: FieldProps) {
  const path = [...base, ...keyPath(f)];
  if (f.type === 'list') return <ListField f={f} form={form} base={base} set={set} home={home} bad={bad} />;
  const raw = getIn(form, path);
  const value = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  const problem = bad[pathKey(path)];
  const put = (v: string) => set(path, v);
  let control: ReactNode;
  let labelRight: ReactNode = null;
  if (f.type === 'password') control = <SecretInput f={f} value={value} onChange={put} bad={!!problem} />;
  else if (f.type === 'select') {
    const opts = optionsFor(f, home);
    if (segmentable(opts) && opts.some(o => o.value === value || !value)) {
      control = <Segmented compact label={f.label} options={opts.map(o => ({ id: o.value, label: o.label }))} value={value || null} onChange={put} />;
      if (!f.required && value) labelRight = <Press onPress={() => put('')} hitSlop={10} label={`Clear ${f.label}`}><T v="labelSm" color={C.stone}>Clear</T></Press>;
    } else control = <SelectSheet f={f} value={value} options={opts} onChange={put} bad={!!problem} />;
  } else {
    const code = pasteCode && f.key === 'code';
    control = (
      <Input label={f.label} value={value} onChange={put} placeholder={f.placeholder ?? (code ? 'https://…?code=…' : undefined)} bad={!!problem}
        keyboard={f.type === 'number' ? 'numeric' : f.key.toLowerCase().includes('email') || f.key === 'username' ? 'email-address' : f.key === 'url' || /address/i.test(f.label) ? 'url' : 'default'}
        mono={code || /ip address|mac|id$/i.test(f.label)}
        right={code && canPaste ? (
          <Button size="sm" kind="secondary" icon="content_paste" label="Paste" onPress={async () => {
            const t = await paste();
            if (!t.trim()) return false;
            haptic.success();
            put(t.trim());
            return true;
          }} />
        ) : undefined} />
    );
  }
  return (
    <View style={{ gap: SP[2] }}>
      <Label text={f.label} required={f.required} right={labelRight} />
      {control}
      <Problem text={problem} />
      <Help text={f.multiple ? [f.help, 'Separate several with commas.'].filter(Boolean).join(' ') : f.help} />
    </View>
  );
}

/** A list of rows (devices, speakers to rooms): each row folds to one line once it's filled in; remove has Undo. */
function ListField({ f, form, base, set, home, bad }: Omit<FieldProps, 'pasteCode'>) {
  const { say } = useHub();
  const path = [...base, ...keyPath(f)];
  const rows = (getIn(form, path) as Form[] | undefined) ?? [];
  // Rows that came filled in start folded; new ones start open.
  const [open, setOpen] = useState<Set<number>>(() => new Set(rows.map((r, i) => (rowSummary(f, r, home) ? -1 : i)).filter(i => i >= 0)));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const problem = bad[pathKey(path)];
  const noun = nounOf(f);
  const add = () => {
    animateLayout();
    set(path, [...rows, blankRow(f)]);
    setOpen(o => new Set(o).add(rows.length));
  };
  const remove = (i: number) => {
    const before = rowsRef.current;
    animateLayout();
    set(path, before.filter((_, j) => j !== i));
    setOpen(o => new Set([...o].filter(j => j !== i).map(j => (j > i ? j - 1 : j))));
    const what = rowSummary(f, before[i], home);
    say(`${noun.length > 24 ? 'Row' : noun} removed${what ? `: ${what}` : ''}. Save to keep it that way.`, { action: { label: 'Undo', run: () => { animateLayout(); set(path, before); } } });
  };
  const rowBad = (i: number) => Object.keys(bad).some(k => k.startsWith(`${pathKey([...path, i])}/`));
  return (
    <View style={{ gap: SP[2] }}>
      <Label text={f.label} required={f.required} right={rows.length ? <T v="footnote" color={C.stone2}>{String(rows.length)}</T> : null} />
      <Help text={f.help} />
      <Problem text={problem} />
      {rows.map((r, i) => {
        const isOpen = open.has(i) || rowBad(i);
        const sum = rowSummary(f, r, home);
        const title = noun.length > 24 ? `${i + 1}` : `${noun} ${i + 1}`;
        return (
          <View key={i} style={{ borderRadius: R.md, borderWidth: 1, borderColor: rowBad(i) ? C.redLine : C.line, backgroundColor: alpha('#ffffff', 0.015), overflow: 'hidden' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: SP[3], paddingRight: 4, minHeight: 48 }}>
              <Press onPress={() => { animateLayout(); setOpen(o => { const n = new Set(o); if (n.has(i)) n.delete(i); else n.add(i); return n; }); }} label={`${title}${sum ? `, ${sum}` : ''}`} hint={isOpen ? 'Folds it' : 'Opens it'}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: SP[2], minHeight: 48 }}>
                <Icon name={isOpen ? 'expand_more' : 'chevron_right'} size={18} color={C.stone} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T v="labelSm" color={C.bone}>{title}</T>
                  {!isOpen && sum ? <T v="footnote" color={C.stone} numberOfLines={1}>{sum}</T> : null}
                </View>
              </Press>
              <IconButton icon="delete" label={`Remove ${title}`} size={38} tone="ghost" color={C.stone} onPress={() => remove(i)} />
            </View>
            {isOpen ? (
              <View style={{ gap: SP[4], paddingHorizontal: SP[3], paddingBottom: SP[4], paddingTop: SP[1] }}>
                {(f.item ?? []).map(it => <FieldInput key={it.key} f={it} form={form} base={[...path, i]} set={set} home={home} bad={bad} />)}
              </View>
            ) : null}
          </View>
        );
      })}
      <Button size="sm" kind="secondary" icon="add" label={f.addLabel ?? 'Add'} onPress={add} />
    </View>
  );
}

/** A set of fields, spaced as a form. */
export function Fields({ fields, form, set, home, bad, pasteCode }: { fields: Field[]; form: Form; set: (path: Path, v: unknown) => void; home: Home; bad: Record<string, string>; pasteCode?: boolean }) {
  return (
    <View style={{ gap: SP[5] }}>
      {fields.map(f => <FieldInput key={f.key} f={f} form={form} base={[]} set={set} home={home} bad={bad} pasteCode={pasteCode} />)}
    </View>
  );
}
