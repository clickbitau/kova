import { Linking, View } from 'react-native';
import { C, SP } from '../theme';
import { PRIVACY_POLICY_URL } from '../logic/links';
import { Icon } from './Icon';
import { Press } from './kit';
import { T } from './Text';

export const openPrivacyPolicy = () => { void Linking.openURL(PRIVACY_POLICY_URL).catch(() => {}); };

/** "Privacy policy", as a quiet link (first run, the location disclosure). Opens it in the browser. */
export function PrivacyLink({ center = true }: { center?: boolean }) {
  return (
    <Press onPress={openPrivacyPolicy} label="Privacy policy" role="link" hitSlop={10} style={{ alignSelf: center ? 'center' : 'flex-start' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[1] + 2, paddingVertical: SP[1] }}>
        <Icon name="lock" size={15} color={C.stone} />
        <T v="footnote" weight={600} color={C.stone} style={{ textDecorationLine: 'underline' }}>Privacy policy</T>
      </View>
    </Press>
  );
}
