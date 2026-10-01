// Kova on a phone: open and close the menu the sidebar folds into (see responsive.css).
// Plain DOM, outside the app's rendering, so it works however the page re-renders.
(function () {
  var root = document.documentElement;
  var set = function (open) { root.classList.toggle('kova-nav-open', open); };
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('[data-kova-menu]')) { set(!root.classList.contains('kova-nav-open')); return; }
    if (t.closest('[data-kova-scrim]') || t.closest('[data-kova-navitem]')) set(false);
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
  // The day on Now scrolls sideways on a phone: start it with "now" in view (the white 2px marker).
  var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
  var centre = function () {
    if (!seen) return;
    var tl = document.querySelectorAll('[data-kova-timeline]');
    for (var i = 0; i < tl.length; i++) {
      var el = tl[i];
      if (seen.has(el) || el.scrollWidth <= el.clientWidth) continue;
      var mark = el.querySelector('[style*="width: 2px"]');
      var pct = mark ? parseFloat(mark.style.left) : NaN;
      if (isNaN(pct)) continue;
      seen.add(el);
      el.scrollLeft = Math.max(0, (el.scrollWidth * pct) / 100 - el.clientWidth / 2);
    }
  };
  if (seen && typeof MutationObserver === 'function') {
    var start = function () { new MutationObserver(centre).observe(document.body, { childList: true, subtree: true }); centre(); };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  }
  // A list beside its detail (Modes) stacks on a phone, so picking from the list moves to the detail below.
  var phone = function () { try { return matchMedia('(max-width: 760px)').matches; } catch (e) { return false; } };
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof Element) || !phone()) return;
    var stack = t.closest('[data-kova-stack]');
    if (!stack || !stack.firstElementChild || !stack.firstElementChild.contains(t)) return;
    // The page may re-render the detail as a new element, so find it again by position.
    var at = Array.prototype.indexOf.call(document.querySelectorAll('[data-kova-stack]'), stack);
    var before = stack.lastElementChild ? stack.lastElementChild.textContent : '';
    setTimeout(function () {
      var now = document.querySelectorAll('[data-kova-stack]')[at];
      var detail = now && now.lastElementChild;
      if (detail && detail.textContent !== before) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }, true); // capture: run before the page re-renders and detaches the tapped element
  // Rotating to a wide screen shows the sidebar again; don't leave the page locked.
  try { matchMedia('(max-width: 760px)').addEventListener('change', function (m) { if (!m.matches) set(false); }); } catch (e) {}
})();
