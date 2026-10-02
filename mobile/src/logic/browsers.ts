// Signing a browser in from the app: the code a browser shows, as it's typed.

/** Letters and digits only, upper-case, as "ABCD-1234" once there are more than four. No 0/O, 1/I/L are ever shown. */
export function formatCode(input: string): string {
  const c = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

export const codeComplete = (code: string) => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);

/** "just now", "5 min ago", "3 h ago", "2 d ago" */
export function ago(t: number, now = Date.now()): string {
  const m = Math.round((now - t) / 60000);
  return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

/** Which icon a session gets from its name ("Safari on iPhone"). */
export const sessionIcon = (name: string) => /iPhone|Android/.test(name) ? 'smartphone' : /iPad/.test(name) ? 'tablet' : 'computer';
