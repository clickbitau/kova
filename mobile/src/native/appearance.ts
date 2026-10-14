import { useEffect, useState } from 'react';
import { parseAppearance, type Appearance } from '../logic/appearance';
import { getItem, setItem } from './storage';

// Light, dark or the phone's own: kept on this phone, like the lock and the speech language.
const KEY = 'kova.appearance';
let choice: Appearance = 'system';
let ready = false;
const watchers = new Set<(c: Appearance) => void>();
const loaded = getItem(KEY).then(v => { choice = parseAppearance(v); }).catch(() => {}).finally(() => { ready = true; watchers.forEach(w => w(choice)); });

/** The choice, kept current; `ready` once it has been read (so the first screen isn't drawn in the wrong scheme). */
export function useAppearance(): { choice: Appearance; ready: boolean; setChoice: (c: Appearance) => void } {
  const [c, setC] = useState(choice);
  const [r, setR] = useState(ready);
  useEffect(() => {
    watchers.add(setC);
    void loaded.then(() => { setC(choice); setR(true); });
    return () => { watchers.delete(setC); };
  }, []);
  const setChoice = (next: Appearance) => { choice = next; void setItem(KEY, next === 'system' ? null : next).catch(() => {}); watchers.forEach(w => w(next)); };
  return { choice: c, ready: r, setChoice };
}
