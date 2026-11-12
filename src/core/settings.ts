import type { Difficulty } from './types';

export type QualitySetting = 'auto' | 'low' | 'medium' | 'high';

export interface Settings {
  difficulty: Difficulty;
  /** Aim and placement help, 0..1. */
  assist: number;
  haptics: boolean;
  sound: boolean;
  voice: boolean;
  quality: QualitySetting;
  showFps: boolean;
  installDismissed: boolean;
}

const KEY = 'padel3d.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  difficulty: 'medium',
  assist: 0.5,
  haptics: true,
  sound: true,
  voice: true,
  quality: 'auto',
  showFps: false,
  installDismissed: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // Private mode or blocked storage: fall back to defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not persisted; the game still works.
  }
}
