// Links the hub puts in notifications, and where they go in the app.

/** Where a tapped notification should take the app: the hub gives web-app paths like /phone.html?cam=doorbell. */
export function routeFor(url: string | undefined): { cam?: string; lightsOff?: boolean; page?: string } {
  if (!url) return {};
  try {
    const u = new URL(url, 'http://hub');
    const cam = u.searchParams.get('cam');
    if (cam) return { cam };
    if (u.searchParams.get('do') === 'lights-off') return { lightsOff: true };
    const page = u.searchParams.get('page');
    return page ? { page } : {};
  } catch {
    return {};
  }
}
