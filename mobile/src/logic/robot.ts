import { C } from '../theme';
import type { RobotState } from '../api/types';

// Robot vacuums: the words and choices the panel and the automation editor use (hub util/robot.ts says the same).

/** A robot's floor map (GET /api/devices/:id/map): areas as SVG paths with their names and rooms, walls, the dock. */
export interface RobotMap {
  viewBox: [number, number, number, number];
  areas: { id: string; path: string; x: number; y: number; name: string; own: string | null; room: string | null }[];
  walls: string;
  dock: { x: number; y: number } | null;
}

export const SUCTIONS: [NonNullable<RobotState['suction']>, string][] = [['quiet', 'Quiet'], ['standard', 'Standard'], ['max', 'Max'], ['max+', 'Max+']];
export const CLEAN_MODES: [NonNullable<RobotState['mode']>, string, string][] = [['both', 'Vacuum and mop', 'cleaning_services'], ['vacuum', 'Vacuum only', 'mode_fan'], ['mop', 'Mop only', 'water_drop'], ['mopAfter', 'Vacuum, then mop', 'swap_vert']];
const JOBS = { empty: 'Empty the bin', wash: 'Wash the mop', dry: 'Dry the mop' } as const;
export const robotJobLabel = (j: keyof typeof JOBS) => JOBS[j];
const STATION = { idle: 'ready', emptying: 'emptying the dust bin', washing: 'washing the mop', drying: 'drying the mop' } as const;
export const robotStation = (s: keyof typeof STATION) => STATION[s];
/** A part's colour by the life it has left: red at the end, amber when it's time to get a new one. */
export const partColor = (left: number) => left <= 5 ? C.red : left <= 20 ? C.amber : C.green;
