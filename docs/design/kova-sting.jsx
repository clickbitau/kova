const { useComposition, animate, Easing, CompositionStage, useTweaks, TweaksPanel, TweakToggle } = window;
const MOTION = { enter: Easing.easeOutCubic, draw: Easing.easeInOutCubic, pop: Easing.easeOutBack };
const tw = (from, to, start, end, ease) => animate({ from, to, start, end, ease });
const AMBER = '#f2b14c', INK = '#f1efea';

function Half({ d, len, p, dy }) {
  return <path d={d} fill="none" stroke={INK} strokeWidth="5" strokeLinecap="round"
    strokeDasharray={len} strokeDashoffset={len * (1 - p)} opacity={p > 0.01 ? 1 : 0}
    transform={`translate(0 ${dy})`} />;
}

function Mark({ T, C }) {
  const dot = tw(0, 1, C.Signal + 0.2, C.Signal + 0.75, MOTION.pop)(T);
  const ring = tw(0, 1, C.Signal + 0.55, C.Signal + 1.4, MOTION.enter)(T);
  const ring2 = tw(0, 1, C.Waves + 0.9, C.Waves + 1.7, MOTION.enter)(T);
  const sP = tw(0, 1, C.Waves, C.Waves + 0.6, MOTION.draw)(T);
  const sY = tw(7, 0, C.Waves, C.Waves + 0.7, MOTION.enter)(T);
  const bP = tw(0, 1, C.Waves + 0.4, C.Waves + 1.1, MOTION.draw)(T);
  const bY = tw(9, 0, C.Waves + 0.4, C.Waves + 1.2, MOTION.enter)(T);
  const S = 21.93, s = 10.97;
  return (
    <svg viewBox="0 0 48 48" width="100%" height="100%" style={{ overflow: 'visible' }}>
      <circle cx="24" cy="38.5" r={3.5 + ring * 14} fill="none" stroke={AMBER} strokeWidth="0.8" opacity={ring > 0 && ring < 1 ? 0.7 * (1 - ring) : 0} />
      <circle cx="24" cy="38.5" r={3.5 + ring2 * 22} fill="none" stroke={AMBER} strokeWidth="0.6" opacity={ring2 > 0 && ring2 < 1 ? 0.5 * (1 - ring2) : 0} />
      <Half d="M24 24.5L16 32" len={s} p={sP} dy={sY} />
      <Half d="M24 24.5L32 32" len={s} p={sP} dy={sY} />
      <Half d="M24 11L8 26" len={S} p={bP} dy={bY} />
      <Half d="M24 11L40 26" len={S} p={bP} dy={bY} />
      <circle cx="24" cy="38.5" r={3.5 * Math.max(0, dot)} fill={AMBER} />
    </svg>
  );
}

function Wordmark({ T, C }) {
  return (
    <div style={{ position: 'absolute', left: 850, top: 540, transform: 'translateY(-50%)', display: 'flex', fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 210, letterSpacing: '-0.04em', lineHeight: 1, color: INK }}>
      {'Kova'.split('').map((ch, i) => {
        const p = tw(0, 1, C.Settle + 0.35 + i * 0.08, C.Settle + 0.95 + i * 0.08, MOTION.enter)(T);
        return <span key={i} style={{ display: 'inline-block', opacity: p, transform: `translateY(${(1 - p) * 60}px)` }}>{ch}</span>;
      })}
    </div>
  );
}

function Piece() {
  const { T, CUES: C } = useComposition();
  const settle = tw(0, 1, C.Settle, C.Settle + 0.9, MOTION.draw)(T);
  const cam = tw(0.97, 1.03, 0, C.Out, Easing.linear)(T);
  const glow = tw(0, 1, C.Waves, C.Settle, MOTION.enter)(T);
  const pulse = tw(0, 1, C.Hold + 0.3, C.Hold + 1.4, MOTION.enter)(T);
  const out = tw(1, 0, C.Out, C.Out + 0.6, MOTION.draw)(T);
  const size = 360 - settle * 110;
  const cx = 960 - settle * 270;
  return (
    <div data-screen-label={`t=${Math.floor(T)}s`} style={{ position: 'absolute', inset: 0, background: '#111214', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, opacity: out, transform: `scale(${cam})`, transformOrigin: '50% 50%' }}>
        <div style={{ position: 'absolute', left: cx - 520, top: 540 - 520, width: 1040, height: 1040, borderRadius: '50%', background: 'radial-gradient(circle, rgba(242,177,76,0.16) 0%, rgba(242,177,76,0) 62%)', opacity: glow * (1 + 0.4 * Math.sin(pulse * Math.PI)) }} />
        <div style={{ position: 'absolute', left: cx - size / 2, top: 540 - size / 2, width: size, height: size }}>
          <Mark T={T} C={C} />
        </div>
        <Wordmark T={T} C={C} />
      </div>
    </div>
  );
}

function KovaSting() {
  const [t, setTweak] = useTweaks(window.TWEAK_DEFAULTS);
  return (
    <>
      <CompositionStage width={1920} height={1080} scenes={window.OM_SCENES} playback={window.OM_PLAYBACK} bg="#111214">
        <Piece />
      </CompositionStage>
      <TweaksPanel>
        <TweakToggle label="Motion editor" value={t.motionEditor} onChange={(v) => setTweak('motionEditor', v)} />
      </TweaksPanel>
    </>
  );
}
window.KovaSting = KovaSting;
