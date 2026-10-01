import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { C, F } from '../theme';
import { hello } from '../api/client';
import { addManual, display, kindFor, KIND_LABEL, remove, sameHub } from '../logic/addresses';
import { normalizeHubUrl } from '../logic/connect';
import { useHub } from '../state/hub';
import { Icon } from '../ui/Icon';
import { Press } from '../ui/kit';
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
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Icon name="hub" size={20} color={C.stone} />
        <View style={{ flex: 1, gap: 2 }}>
          <T size={14} weight={700}>Hub</T>
          <T size={12} color={C.stone}>{conn === 'live' && route ? `Connected · ${KIND_LABEL[route.kind]}` : conn === 'offline' ? 'Can’t reach it right now' : 'Connecting…'}</T>
        </View>
      </View>
      {addresses.map(a => {
        const inUse = route?.url === a.url;
        return (
          <View key={a.url} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name={a.kind === 'local' ? 'home' : 'cloud'} size={17} color={inUse ? C.green : C.stone} />
            <View style={{ flex: 1, gap: 1 }}>
              <T mono size={11.5} color={inUse ? C.bone : C.stone} numberOfLines={1}>{display(a.url)}</T>
              <T size={11} color={C.stone2}>{`${KIND_LABEL[a.kind]}${a.manual ? ' · added by you' : ''}${inUse ? ' · in use' : ''}`}</T>
            </View>
            {addresses.length > 1 ? (
              <Press label={`Remove ${display(a.url)}`} hitSlop={8} onPress={() => void setAddresses(remove(addresses, a.url))}>
                <Icon name="close" size={17} color={C.stone2} />
              </Press>
            ) : null}
          </View>
        );
      })}
      {adding ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TextInput value={text} onChangeText={setText} placeholder="192.168.1.20 or https://…" placeholderTextColor={C.stone3} autoCapitalize="none" autoCorrect={false} keyboardType="url" autoFocus
            onSubmitEditing={() => void add()}
            style={{ flex: 1, paddingVertical: 9, paddingHorizontal: 11, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: C.page, color: C.bone, fontFamily: F[400], fontSize: 14 }} />
          <Press label="Add" onPress={busy ? undefined : () => void add()} style={{ padding: 6, opacity: busy ? 0.5 : 1 }}>
            <Icon name="check_circle" size={22} color={C.amber} />
          </Press>
        </View>
      ) : (
        <Press onPress={() => setAdding(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 }}>
          <Icon name="add" size={17} color={C.amber} />
          <T size={12.5} weight={600} color={C.amber}>Add an address</T>
        </Press>
      )}
    </View>
  );
}
