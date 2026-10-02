// Links the hub puts in notifications, and where they go in the app.

/** Where a tapped notification should take the app: the hub gives web-app paths like /phone.html?cam=doorbell. */
export function routeFor(url: string | undefined): { cam?: string; lightsOff?: boolean; page?: string; setup?: string } {
  if (!url) return {};
  try {
    const u = new URL(url, 'http://hub');
    const cam = u.searchParams.get('cam');
    if (cam) return { cam };
    if (u.searchParams.get('do') === 'lights-off') return { lightsOff: true };
    // One integration's setup (e.g. "Link Google Nest"): its own screen in the app.
    const setup = u.searchParams.get('setup');
    if (setup) return { setup };
    const page = u.searchParams.get('page');
    return page ? { page } : {};
  } catch {
    return {};
  }
}

/** Web-app pages (`?page=`) the app has its own screen for, and that screen. */
export const NATIVE_PAGES: Record<string, 'Modes' | 'Activity' | 'Automations' | 'Energy' | 'Media' | 'Customise' | 'Integrations'> = {
  modes: 'Modes', activity: 'Activity', autos: 'Automations', automations: 'Automations', energy: 'Energy', media: 'Media', customise: 'Customise',
  integrations: 'Integrations',
};
