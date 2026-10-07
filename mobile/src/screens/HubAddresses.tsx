import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { C, F, R, SP } from '../theme';
import { hello } from '../api/client';
import { addManual, display, kindFor, KIND_LABEL, remove, sameHub } from '../logic/addresses';
import { linkWords } from '../logic/link';
import { normalizeHubUrl } from '../logic/connect';
import { useHub } from '../state/hub';
import { Icon } from '../ui/Icon';
import { Group, IconButton, Press, Row, Spinner } from '../ui/kit';
import { T } from '../ui/Text';

/**
 * The hub's addresses (server settings): home network first, then remote, the one in use marked. The app learns
 * them from the hub; here they can be added to or taken away. An added one must answer as this same hub.
 */
export function HubAddresses() {
  const { cfg, addresses, route, conn, setAddresses, say } = useHub();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const url = normalizeHubUrl(text);
    if (!url) { say('Type an address, e.g. 192.168.1.20 or https://kova.example.ts.net', { error: true }); return; }
    setBusy(true);
    try {
      const kind = kindFor(url);
      const h = await hello(url, kind === 'local' ? 3000 : 8000);
      if (!h) throw new Error(`Nothing answered as Kova at ${display(url)}`);
      if (!sameHub(cfg?.hubId, h)) throw new Error(`${display(url)} is a different Kova hub`);
      await setAddresses(addManual(addresses, url, kind));
      if (kind === 'remote' && url.startsWith('http:')) say('Added. It’s plain http, so the token crosses that network unencrypted');
      setText(''); setAdding(false);
    } catch (e) { say((e as Error).message, { error: true }); } finally { setBusy(false); }
  };

  return (
    <Group title="Hub" note="Kova uses the home network address at home and the remote one away, by itself.">
      <Row first icon="router" iconFg={{ ok: C.green, down: C.red, busy: C.amber, warn: C.amber }[linkWords({ state: conn }).tone]} title={conn === 'live' && route ? `Connected · ${KIND_LABEL[route.kind]}` : linkWords({ state: conn }).short} />
      {addresses.map(a => {
        const inUse = route?.url === a.url;
        return (
          <View key={a.url} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 56, paddingVertical: SP[2], paddingLeft: SP[4], paddingRight: SP[2], borderTopWidth: 1, borderTopColor: C.hairline }}>
            <Icon name={a.kind === 'local' ? 'home' : 'cloud'} size={19} color={inUse ? C.green : C.stone} fill={inUse} />
            <View style={{ flex: 1, gap: 1 }}>
              <T mono size={12} color={inUse ? C.bone : C.bone2} numberOfLines={1}>{display(a.url)}</T>
              <T v="footnote" size={11.5} color={inUse ? C.green : C.stone2}>{`${KIND_LABEL[a.kind]}${a.manual ? ' · added by you' : ''}${inUse ? ' · in use' : ''}`}</T>
            </View>
            {addresses.length > 1 ? <IconButton icon="close" label={`Remove ${display(a.url)}`} tone="ghost" size={36} color={C.stone2} onPress={() => void setAddresses(remove(addresses, a.url))} /> : null}
          </View>
        );
      })}
      {adding ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], padding: SP[3], borderTopWidth: 1, borderTopColor: C.hairline }}>
          <TextInput value={text} onChangeText={setText} placeholder="192.168.1.20 or https://…" placeholderTextColor={C.stone2} autoCapitalize="none" autoCorrect={false} keyboardType="url" autoFocus
            onSubmitEditing={() => void add()} accessibilityLabel="New address"
            style={{ flex: 1, height: 44, paddingHorizontal: SP[3], borderRadius: R.sm + 2, borderWidth: 1, borderColor: C.line, backgroundColor: C.page, color: C.bone, fontFamily: F[500], fontSize: 15 }} />
          {busy ? <Spinner /> : <IconButton icon="check" label="Add" tone="amber" size={40} onPress={() => void add()} />}
        </View>
      ) : (
        <Press onPress={() => setAdding(true)} label="Add an address" style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], minHeight: 48, paddingHorizontal: SP[4], borderTopWidth: 1, borderTopColor: C.hairline }}>
          <Icon name="add" size={19} color={C.amber} />
          <T v="labelSm" color={C.amber}>Add an address</T>
        </Press>
      )}
    </Group>
  );
}
