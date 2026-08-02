import type { TileMap } from './TileMap';

/**
 * Conditions - the time of day and the weather a raid runs under.
 *
 * This is one table that every system reads, rather than five systems each
 * inventing their own idea of "night". The same numbers drive:
 *
 *   - the baked lightmap (how dark the world actually is)
 *   - fog density and colour, and the sky gradient
 *   - how far AI can see and how far sound carries
 *   - what the raid pays out
 *
 * That last one is the point. Darkness and weather are not decoration: a night
 * raid in a storm is a genuinely harder deployment that pays genuinely better,
 * and the only way to see in it is a weapon light that also tells every hostile
 * on the map exactly where you are. The tension between "I need to see" and
 * "I do not want to be seen" is the reason this system exists.
 *
 * Conditions never touch map *layout*. Generation is unaffected, so the same
 * seed produces the same ground under every sky - route knowledge stays worth
 * having, and a bug report with a seed stays reproducible.
 */

export type TimeOfDayId = 'dawn' | 'day' | 'dusk' | 'night';
export type WeatherId = 'clear' | 'overcast' | 'fog' | 'rain' | 'storm';

/** Baseline fog density; weather adds to it. Matches the renderer default. */
export const BASE_FOG_DENSITY = 0.055;

export interface TimeProfile {
  id: TimeOfDayId;
  label: string;
  /** Short line for the deployment screen. */
  blurb: string;
  /** Multiplies the blueprint's sky ambient when the lightmap is applied. */
  ambientScale: number;
  /** Multiplies lamp contribution - street lighting is off in daylight. */
  lampScale: number;
  /** Absolute floor on the lightmap so nothing is pure black. */
  minLight: number;
  skyTop: number;
  skyHorizon: number;
  fogColor: number;
  /** Multiplies AI spotting range. */
  sightScale: number;
  /** Multiplies sound radii - still air at night carries further. */
  soundScale: number;
  /** Multiplies XP and the rare-loot roll. */
  rewardScale: number;
}

export interface WeatherProfile {
  id: WeatherId;
  label: string;
  blurb: string;
  /** Added to the base fog density. */
  fogDensityAdd: number;
  /** Fog and sky are pulled towards this colour by `tint`. */
  tintColor: number;
  tint: number;
  ambientScale: number;
  sightScale: number;
  soundScale: number;
  rewardScale: number;
  /** 0..1 rain intensity, drives the screen overlay and the ambience bed. */
  precipitation: number;
  /** 0..1 wind, for the ambience bed. */
  wind: number;
  /** Occasional thunder, which lights the whole map for an instant. */
  thunder: boolean;
  /** Relative weight when the weather is rolled from the raid seed. */
  weight: number;
}

/**
 * Resolved conditions: one flat record, because this gets read in inner loops
 * and per AI think tick.
 */
export interface RaidConditions {
  time: TimeOfDayId;
  weather: WeatherId;
  /** "Nacht - Sturm", for the HUD and the debrief. */
  label: string;
  ambientScale: number;
  lampScale: number;
  minLight: number;
  fogDensity: number;
  fogColor: number;
  skyTop: number;
  skyHorizon: number;
  sightScale: number;
  soundScale: number;
  rewardScale: number;
  precipitation: number;
  wind: number;
  thunder: boolean;
  /** True when a weapon light is worth the risk of carrying one. */
  darkEnoughForLight: boolean;
}

// ===========================================================================
// Tables
// ===========================================================================

export const TIME_PROFILES: TimeProfile[] = [
  {
    id: 'day',
    label: 'Tag',
    blurb: 'Volle Sicht in beide Richtungen. Sicherster Einsatz, geringster Ertrag.',
    ambientScale: 1,
    lampScale: 0.25,
    minLight: 0,
    skyTop: 0x2c3442,
    skyHorizon: 0x8c94a0,
    fogColor: 0x2a3038,
    sightScale: 1,
    soundScale: 1,
    rewardScale: 1,
  },
  {
    id: 'dawn',
    label: 'Morgengrauen',
    blurb: 'Flaches Licht, lange Schatten. Ein guter Kompromiss.',
    ambientScale: 0.44,
    lampScale: 0.9,
    minLight: 16,
    skyTop: 0x1c2436,
    skyHorizon: 0x7a6248,
    fogColor: 0x3a3a42,
    sightScale: 0.8,
    soundScale: 1.05,
    rewardScale: 1.12,
  },
  {
    id: 'dusk',
    label: 'Abenddämmerung',
    blurb: 'Das Licht bricht weg, während du noch draußen bist.',
    ambientScale: 0.34,
    lampScale: 1,
    minLight: 14,
    skyTop: 0x171b2c,
    skyHorizon: 0x6e412a,
    fogColor: 0x33303a,
    sightScale: 0.74,
    soundScale: 1.05,
    rewardScale: 1.2,
  },
  {
    id: 'night',
    label: 'Nacht',
    blurb: 'Ohne Licht am Lauf siehst du nichts. Mit Licht sieht dich jeder.',
    ambientScale: 0.16,
    lampScale: 1.2,
    minLight: 10,
    skyTop: 0x05070e,
    skyHorizon: 0x141c2a,
    fogColor: 0x0d1118,
    sightScale: 0.5,
    soundScale: 1.15,
    rewardScale: 1.45,
  },
];

export const WEATHER_PROFILES: WeatherProfile[] = [
  {
    id: 'clear',
    label: 'Klar',
    blurb: 'Freie Sicht.',
    fogDensityAdd: 0,
    tintColor: 0x2a3038,
    tint: 0,
    ambientScale: 1,
    sightScale: 1,
    soundScale: 1,
    rewardScale: 1,
    precipitation: 0,
    wind: 0.08,
    thunder: false,
    weight: 30,
  },
  {
    id: 'overcast',
    label: 'Bedeckt',
    blurb: 'Geschlossene Wolkendecke, gedämpftes Licht.',
    fogDensityAdd: 0.012,
    tintColor: 0x3c424a,
    tint: 0.35,
    ambientScale: 0.82,
    sightScale: 0.94,
    soundScale: 1,
    rewardScale: 1.04,
    precipitation: 0,
    wind: 0.22,
    thunder: false,
    weight: 28,
  },
  {
    id: 'fog',
    label: 'Nebel',
    blurb: 'Sichtweite unter 20 Metern. Beide Seiten sind blind.',
    fogDensityAdd: 0.08,
    tintColor: 0x6a7079,
    tint: 0.6,
    ambientScale: 0.78,
    sightScale: 0.58,
    soundScale: 0.92,
    rewardScale: 1.16,
    precipitation: 0,
    wind: 0.04,
    thunder: false,
    weight: 12,
  },
  {
    id: 'rain',
    label: 'Regen',
    blurb: 'Regen übertönt Schritte - deine und ihre.',
    fogDensityAdd: 0.03,
    tintColor: 0x39424c,
    tint: 0.4,
    ambientScale: 0.72,
    sightScale: 0.82,
    soundScale: 0.7,
    rewardScale: 1.12,
    precipitation: 0.62,
    wind: 0.4,
    thunder: false,
    weight: 20,
  },
  {
    id: 'storm',
    label: 'Sturm',
    blurb: 'Starkregen und Donner. Man hört nichts kommen.',
    fogDensityAdd: 0.05,
    tintColor: 0x2f373f,
    tint: 0.5,
    ambientScale: 0.55,
    sightScale: 0.7,
    soundScale: 0.52,
    rewardScale: 1.22,
    precipitation: 1,
    wind: 0.95,
    thunder: true,
    weight: 10,
  },
];

export function timeProfile(id: TimeOfDayId): TimeProfile {
  return TIME_PROFILES.find((t) => t.id === id) ?? TIME_PROFILES[0];
}

export function weatherProfile(id: WeatherId): WeatherProfile {
  return WEATHER_PROFILES.find((w) => w.id === id) ?? WEATHER_PROFILES[0];
}

// ===========================================================================
// Resolution
// ===========================================================================

/** Linear blend between two packed 0xRRGGBB colours. */
export function mixColor(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = (ar + (br - ar) * k) | 0;
  const g = (ag + (bg - ag) * k) | 0;
  const bl = (ab + (bb - ab) * k) | 0;
  return (r << 16) | (g << 8) | bl;
}

/**
 * Combine a time of day with a weather state.
 *
 * The multipliers compose rather than override, so "night" and "storm" stack
 * into something genuinely punishing without either table needing to know the
 * other exists.
 */
export function makeConditions(time: TimeOfDayId, weather: WeatherId): RaidConditions {
  const t = timeProfile(time);
  const w = weatherProfile(weather);

  const ambientScale = t.ambientScale * w.ambientScale;

  // Fog and cloud are only as bright as the light falling on them. Applying the
  // weather tint at full strength after dark produced a luminous grey wall at
  // midnight - fog that glowed instead of a night you could not see through.
  const tint = w.tint * (0.3 + 0.7 * t.ambientScale);

  return {
    time: t.id,
    weather: w.id,
    label: w.id === 'clear' ? t.label : `${t.label} · ${w.label}`,
    ambientScale,
    lampScale: t.lampScale,
    minLight: t.minLight,
    fogDensity: BASE_FOG_DENSITY + w.fogDensityAdd,
    fogColor: mixColor(t.fogColor, w.tintColor, tint),
    skyTop: mixColor(t.skyTop, w.tintColor, tint * 0.7),
    skyHorizon: mixColor(t.skyHorizon, w.tintColor, tint * 0.7),
    sightScale: t.sightScale * w.sightScale,
    soundScale: t.soundScale * w.soundScale,
    rewardScale: t.rewardScale * w.rewardScale,
    precipitation: w.precipitation,
    wind: w.wind,
    thunder: w.thunder,
    // Below roughly a third of daylight, unlit interiors stop being readable.
    darkEnoughForLight: ambientScale < 0.55,
  };
}

export function defaultConditions(): RaidConditions {
  return makeConditions('day', 'clear');
}

/**
 * Pick the weather for a raid from its seed.
 *
 * Weather is rolled, not chosen: the player commits to a time of day on the
 * deployment screen and finds out what the sky is doing when they get there.
 * Deriving it from the seed keeps a given deployment reproducible.
 */
export function rollWeather(roll: number): WeatherId {
  const total = WEATHER_PROFILES.reduce((sum, w) => sum + w.weight, 0);
  let ticket = (roll < 0 ? -roll : roll) % total;
  for (const w of WEATHER_PROFILES) {
    ticket -= w.weight;
    if (ticket < 0) return w.id;
  }
  return 'clear';
}

// ===========================================================================
// Lighting
// ===========================================================================

/**
 * Re-derive the lightmap for a set of conditions.
 *
 * The generator bakes two things: the lamp contribution (expensive, involves a
 * line-of-sight test per lit tile) and the sky base (trivial). Only the sky
 * base depends on conditions, so this can run whenever - at raid start, or
 * mid-raid if the sky ever needs to change - without repeating the bake.
 *
 * Lamps are deliberately *not* scaled down at night. A floodlit yard under a
 * black sky is the most dangerous ground on the map, and that only works if the
 * floodlight stays bright while everything around it goes dark.
 */
export function applyConditions(map: TileMap, ambient: number, cond: RaidConditions): void {
  const skyLevel = ambient * 255 * cond.ambientScale;
  const indoorBase = ambient * 62 * cond.ambientScale;
  const lampScale = cond.lampScale;
  const floor = cond.minLight;
  const n = map.width * map.height;

  for (let i = 0; i < n; i++) {
    const base = map.ceiling[i] !== 0 ? indoorBase : skyLevel;
    const lit = base + map.lampLight[i] * lampScale;
    const value = lit < floor ? floor : lit > 255 ? 255 : lit;
    map.lightmap[i] = value | 0;
  }
}
