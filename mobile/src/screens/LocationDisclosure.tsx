import { useCallback, useRef, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, SP } from '../theme';
import { DISCLOSURE, type LocationStage } from '../logic/location-consent';
import { Icon } from '../ui/Icon';
import { Button, Card, IconWell } from '../ui/kit';
import { PrivacyLink } from '../ui/PrivacyLink';
import { Glow } from '../ui/Screen';
import { T } from '../ui/Text';

/**
 * Kova's own full-screen location disclosure (Google Play's "prominent disclosure"), shown before every system
 * location prompt: the first one, the upgrade to "all the time", and the one-off use in Settings. It says what is
 * collected, that it runs with the app closed, and how it's used, with Continue and Not now. Only Continue goes on
 * to the system prompt (logic/location-consent.ts keeps that order, and its tests check it).
 */
export function LocationDisclosure({ stage, onAnswer }: { stage: LocationStage | null; onAnswer: (go: boolean) => void }) {
  const insets = useSafeAreaInsets();
  const bg = stage === 'background', once = stage === 'once';
  const title = once ? DISCLOSURE.once.title : bg ? DISCLOSURE.background.title : DISCLOSURE.title;
  const lead = once ? DISCLOSURE.once.lead : bg ? DISCLOSURE.background.lead : DISCLOSURE.lead;
  return (
    <Modal visible={!!stage} animationType="slide" presentationStyle="fullScreen" statusBarTranslucent onRequestClose={() => onAnswer(false)}>
      <View style={{ flex: 1, backgroundColor: C.page }} accessibilityViewIsModal>
        <Glow color={C.amber} opacity={0.14} />
        <ScrollView contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + SP[8], paddingHorizontal: SP[6], paddingBottom: SP[6], gap: SP[5] }}>
          <IconWell icon={once ? 'location_on' : 'person_pin_circle'} color={C.amber} bg={C.amberTint} size={64} radius={22} fill />
          <T v="largeTitle" size={28} accessibilityRole="header">{title}</T>
          <T v="body" size={17} weight={700} color={C.bone} lineHeight={1.4}>{lead}</T>
          {once ? (
            <T v="body" color={C.soft}>{DISCLOSURE.once.step}</T>
          ) : (
            <Card style={{ padding: SP[4], gap: SP[4] }}>
              {DISCLOSURE.points.map(([icon, head, text]) => (
                <View key={head} style={{ flexDirection: 'row', gap: SP[3] }}>
                  <IconWell icon={icon} color={C.green} size={34} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T v="headline">{head}</T>
                    <T v="footnote" color={C.stone}>{text}</T>
                  </View>
                </View>
              ))}
            </Card>
          )}
          {bg ? (
            <View style={{ flexDirection: 'row', gap: SP[2] + 2, padding: SP[3] + 2, borderRadius: R.md, backgroundColor: C.amberTint, borderWidth: 1, borderColor: C.amberLine }}>
              <Icon name="info" size={19} color={C.amber} />
              <T v="callout" color={C.bone2} style={{ flex: 1 }}>{DISCLOSURE.background.step}</T>
            </View>
          ) : null}
          <PrivacyLink center={false} />
        </ScrollView>
        <View style={{ paddingHorizontal: SP[6], paddingTop: SP[3], paddingBottom: insets.bottom + SP[5], gap: SP[2], borderTopWidth: 1, borderTopColor: C.hairline, backgroundColor: C.page }}>
          <Button size="lg" label={DISCLOSURE.cta} onPress={() => onAnswer(true)} />
          <Button kind="ghost" label={DISCLOSURE.no} onPress={() => onAnswer(false)} />
        </View>
      </View>
    </Modal>
  );
}

/**
 * The disclosure as a promise: `disclose(stage)` shows it and resolves true for Continue, false for Not now.
 * Render `view` once in the screen. The system prompt waits until the disclosure has slid away.
 */
export function useLocationDisclosure() {
  const [stage, setStage] = useState<LocationStage | null>(null);
  const answer = useRef<((go: boolean) => void) | null>(null);
  const disclose = useCallback((s: LocationStage) => new Promise<boolean>(resolve => { answer.current = resolve; setStage(s); }), []);
  const onAnswer = useCallback((go: boolean) => {
    const r = answer.current;
    answer.current = null;
    setStage(null);
    setTimeout(() => r?.(go), 350);
  }, []);
  return { disclose, view: <LocationDisclosure stage={stage} onAnswer={onAnswer} /> };
}
