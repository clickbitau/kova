// Kova motion helpers (see motion.css). kovaClose(fn): play a sheet's or drawer's exit, then run fn to remove it.
// Sheets sink back down, drawers slide back right, scrims fade; 200ms, as the Design Language's state changes.
window.kovaClose = function (fn) {
  try {
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var panels = document.querySelectorAll('[style*="border-radius: 28px 28px 0px 0px"], [style*="position: fixed"][style*="right: 0px"][style*="width: min("]');
    if (reduce || !panels.length) return fn();
    panels.forEach(function (p) {
      var drawer = getComputedStyle(p).position === 'fixed';
      p.style.animation = 'none';
      p.style.transition = 'transform 0.2s cubic-bezier(0.65, 0, 0.35, 1)';
      p.style.transform = drawer ? 'translateX(100%)' : 'translateY(100%)';
    });
    document.querySelectorAll('[style*="background: rgba(0, 0, 0, 0.55)"]').forEach(function (s) {
      s.style.animation = 'none'; s.style.transition = 'opacity 0.2s'; s.style.opacity = '0';
    });
    setTimeout(fn, 190);
  } catch (e) { fn(); }
};
