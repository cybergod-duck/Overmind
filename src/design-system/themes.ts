export type ThemeName = 'default' | 'obsidian' | 'cyber' | 'midnight';

export interface Theme {
  name: string;
  primary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  // Add more tokens as needed
}

export const themes: Record<ThemeName, Theme> = {
  default: {
    name: 'Default',
    primary: '#3b82f6',
    accent: '#64748b',
    background: '#0f172a',
    surface: '#1e2937',
    text: '#f1f5f9'
  },
  obsidian: {
    name: 'Obsidian',
    primary: '#c026d3',
    accent: '#14b8a6',
    background: '#0a0a0a',
    surface: '#1a1a1a',
    text: '#e2e8f0'
  },
  cyber: {
    name: 'Cyber',
    primary: '#22d3ee',
    accent: '#f97316',
    background: '#050505',
    surface: '#111111',
    text: '#67e8f9'
  },
  midnight: {
    name: 'Midnight',
    primary: '#eab308',
    accent: '#a3a3a3',
    background: '#020617',
    surface: '#0f172a',
    text: '#f8fafc'
  }
};
