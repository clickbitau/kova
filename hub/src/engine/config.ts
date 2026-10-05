import { EventEmitter } from 'node:events';
import type { HomeConfig } from '../model/types.ts';
import type { Store } from '../store/db.ts';

/** The home's configuration (rooms, people, modes…), persisted in the store. */
export class ConfigStore extends EventEmitter<{ changed: [] }> {
  private cfg: HomeConfig;

  constructor(private store: Store, initial: () => HomeConfig) {
    super();
    const saved = store.get<HomeConfig>('config');
    this.cfg = saved ?? initial();
    // Older configs only had latitude/longitude. Keep those, and make `home.location` the canonical field too.
    this.cfg.location ??= { latitude: this.cfg.latitude, longitude: this.cfg.longitude };
    if (!saved || !saved.location) store.set('config', this.cfg);
  }

  get(): HomeConfig { return this.cfg; }

  /** Mutate a copy and save it. Returns a function that restores the previous config. */
  update(fn: (c: HomeConfig) => void): () => void {
    const before = structuredClone(this.cfg);
    const next = structuredClone(this.cfg);
    fn(next);
    this.cfg = next;
    this.store.set('config', next);
    this.emit('changed');
    return () => {
      this.cfg = before;
      this.store.set('config', before);
      this.emit('changed');
    };
  }
}
