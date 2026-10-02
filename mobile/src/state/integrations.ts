import { useCallback, useEffect, useRef, useState } from 'react';
import { useHub } from './hub';
import type { CatalogItem } from '../logic/integrations';

/**
 * The hub's integration catalog and saved settings, shared by the Integrations list, the add picker and a setup
 * screen, so moving between them doesn't load again. `reload` reads both again (after a save, on pull to refresh).
 */
interface Store { hub?: string; catalog: CatalogItem[] | null; config: Record<string, unknown> | null; error: string | null; loading: boolean }

let store: Store = { catalog: null, config: null, error: null, loading: false };
let inflight: Promise<void> | null = null;
const subs = new Set<(s: Store) => void>();
const set = (p: Partial<Store>) => { store = { ...store, ...p }; subs.forEach(f => f(store)); };

type Api = <T>(method: 'GET', path: string) => Promise<T>;

function load(api: Api): Promise<void> {
  if (inflight) return inflight;
  set({ loading: true });
  inflight = Promise.all([api<CatalogItem[]>('GET', '/api/integrations/catalog'), api<Record<string, unknown>>('GET', '/api/integrations/config')])
    .then(([catalog, config]) => set({ catalog, config: config ?? {}, error: null, loading: false }))
    .catch(e => set({ error: (e as Error).message, loading: false }))
    .finally(() => { inflight = null; });
  return inflight;
}

export function useIntegrationSetup() {
  const { api, cfg } = useHub();
  const [s, setS] = useState(store);
  useEffect(() => {
    subs.add(setS);
    setS(store);
    return () => { subs.delete(setS); };
  }, []);
  const apiRef = useRef(api);
  apiRef.current = api;
  const reload = useCallback(() => load(apiRef.current as Api), []);
  // Loaded once per hub; a different hub starts over.
  useEffect(() => {
    if (store.hub !== cfg?.url) set({ hub: cfg?.url, catalog: null, config: null, error: null });
    if (!store.catalog && !inflight) void reload();
  }, [reload, cfg?.url]);
  return { ...s, reload };
}
