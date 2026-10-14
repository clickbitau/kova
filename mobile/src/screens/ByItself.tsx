import { C } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { Group, Row, SwitchRow } from '../ui/kit';
import { findingCall, findingToast, learnedRows } from '../logic/learning';
import { features, meOf } from '../logic/roles';

/** Automations → what Kova does without an automation (pausing for the doorbell, learning from what you do), and what it has learned. */
export function ByItself() {
  const s = useSnap();
  const nav = useNav();
  const { act } = useHub();
  if (!features(meOf(s)).settings) return null;
  const put = (body: object, done: string) => act('PUT', '/api/home', body, done);
  const learnOn = s.home.learnFromYou !== false;
  const learned = learnedRows(s.learned, s.home.timezone, s.home.locale);
  return (
    <>
      <Group title="What Kova does by itself">
        <SwitchRow first icon="doorbell" iconFg={C.amber} title="Pause for the doorbell" sub="When it rings, pause what’s playing on players that can pause"
          on={s.home.pauseForDoorbell !== false} onChange={v => void put({ pauseForDoorbell: v }, v ? 'The doorbell pauses what’s playing' : 'The doorbell no longer pauses anything')} />
        <SwitchRow icon="auto_awesome" iconFg={C.amber} title="Learn from what you do" sub="Suggest changes when you keep doing the same thing by hand. Nothing changes until you say so"
          on={learnOn} onChange={v => void put({ learnFromYou: v }, v ? 'Kova learns from what you do again' : 'Kova no longer learns from what you do')} />
      </Group>
      {learnOn ? (
        <Group title="What Kova has learned" note={learned.length ? 'From what you do by hand. Each shows the days it’s based on, and nothing changes until you apply it.' : 'When you keep doing the same thing by hand on most days, Kova suggests a change in Worth a look, and lists it here.'}>
          {learned.length ? learned.map((r, i) => (
            <Row key={r.id} first={i === 0} icon={r.action === 'restore' ? 'history' : 'auto_awesome'} iconFg={r.tone === 'amber' ? C.amber : C.stone} title={r.title}
              sub={r.action === 'restore' ? `${r.status} · tap to suggest it again` : r.status} subColor={r.tone === 'amber' ? C.amber : C.stone}
              onPress={() => r.action === 'restore' ? void act('POST', findingCall({ id: r.id }, 'restore'), {}, findingToast({ id: r.id }, 'restore'))
                : r.automationId ? nav.navigate('AutomationEditor', { id: r.automationId }) : nav.navigate('Modes')} />
          )) : <Row first icon="auto_awesome" iconFg={C.stone} title="Nothing learned yet" sub="Kova keeps an eye on what you do by hand" />}
        </Group>
      ) : null}
    </>
  );
}
