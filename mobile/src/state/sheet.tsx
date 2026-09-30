import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

// Which device's panel is open. One at a time, from any screen.
const Ctx = createContext<{ open: (id: string) => void; close: () => void; id: string | null } | null>(null);

export function SheetProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<string | null>(null);
  const v = useMemo(() => ({ id, open: (x: string) => setId(x), close: () => setId(null) }), [id]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useSheet() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSheet outside SheetProvider');
  return c;
}
