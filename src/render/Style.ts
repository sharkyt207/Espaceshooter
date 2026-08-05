/**
 * Style - the three visual directions the game can be played in.
 *
 * A "style" here is not a colour swap. Each one is a complete position on how
 * the game should look, and it reaches every layer at once: the grade applied
 * to the rendered frame, the treatment on the quest portraits, how the weapon
 * in your hands is lit, and the chrome of every menu. Changing one and leaving
 * the others is what makes a game look like it was assembled from parts, so
 * they all move together or not at all.
 *
 * The three are deliberately far apart rather than three settings of the same
 * dial, because the point is to choose a direction:
 *
 *   - **Feldbericht** is documentary. Desaturated, cool, low contrast, almost
 *     no treatment. The camera is not supposed to be noticeable. Chrome is
 *     hairline-thin and the only colour is a single restrained amber.
 *   - **Signal** is the readable-at-arms-length end. Deep blue shadows against
 *     warm highlights, more saturation and more contrast, real bloom, cyan
 *     chrome with weight to it. Built for a phone screen in daylight.
 *   - **Archiv** is analogue. Warm amber near-monochrome, heavy grain,
 *     scanlines, lens fringing, hard corners. It is the least photoreal of the
 *     three and the most cohesive, because every part of it is pretending to
 *     be the same piece of degraded footage.
 *
 * Everything here is authored for this project - the palettes, the names, the
 * treatment values. Nothing is sampled from anywhere.
 */

export type StyleId = 'feldbericht' | 'signal' | 'archiv';

/** How the rendered frame is graded, in both renderers. */
export interface GradeSpec {
  /** Multiplier pulled towards in the shadows, and how strongly. */
  shadowTint: [number, number, number];
  shadowAmount: number;
  /** The same for the highlights. */
  highlightTint: [number, number, number];
  highlightAmount: number;
  /** 1 leaves saturation alone; below 1 drains it, above 1 pushes it. */
  saturation: number;
  /** Pivoted on mid grey, so contrast does not change overall exposure. */
  contrast: number;
  bloomStrength: number;
  grain: number;
  vignette: number;
  /**
   * Lateral colour fringing, strongest at the edges of the frame.
   *
   * A real lens cannot focus every wavelength at the same point, and the error
   * grows away from the axis. Faked here by sampling red and blue at slightly
   * different radii - cheap, and it is most of what separates "rendered" from
   * "photographed through glass".
   */
  aberration: number;
  /** Horizontal line pattern, for the analogue direction. */
  scanlines: number;
}

/** How a quest portrait is treated after it is drawn. */
export interface PortraitSpec {
  /** How hard the image is pulled towards the character's tint colour. */
  tintPull: number;
  grain: number;
  scanlines: number;
  vignette: number;
  contrast: number;
  /** Drains colour before the tint is applied, towards a duotone. */
  desaturation: number;
  /**
   * A colour every character's own tint is pulled towards, and how far.
   *
   * Each trader carries a tint that makes them recognisable at a glance in the
   * contacts list. Left alone that is a strength in the two colour styles and
   * a problem in the monochrome one, where a teal face beside three amber ones
   * does not read as a different person - it reads as a different photograph
   * from a different camera. Pulling the tints together is what makes them all
   * look shot on the same stock.
   */
  unify: string;
  unifyAmount: number;
}

/** How the weapon in the player's hands is finished. */
export interface WeaponSpec {
  /** Receiver, furniture and barrel, dark to light. */
  metal: string;
  metalLit: string;
  furniture: string;
  furnitureLit: string;
  /** Outline. Empty disables it. */
  outline: string;
  /** Rim light along the top edge: colour and strength. */
  rim: string;
  rimStrength: number;
  /** Small painted details - selector marks, optic housing accents. */
  detail: string;
  /** Overall contrast of the panel shading. */
  modelling: number;
}

export interface VisualStyle {
  id: StyleId;
  /** Shown in the settings list. */
  name: string;
  /** One line, what the direction is going for. */
  tagline: string;
  grade: GradeSpec;
  portrait: PortraitSpec;
  weapon: WeaponSpec;
  /** CSS custom properties, applied to the document root. */
  css: Record<string, string>;
}

// ===========================================================================
// The three
// ===========================================================================

export const STYLES: Record<StyleId, VisualStyle> = {
  feldbericht: {
    id: 'feldbericht',
    name: 'Feldbericht',
    tagline: 'Dokumentarisch. Entsättigt, kühl, kaum Nachbearbeitung.',
    grade: {
      // Barely there. The whole point of this direction is that the treatment
      // should not be visible as treatment.
      shadowTint: [0.93, 0.99, 1.08],
      shadowAmount: 0.3,
      highlightTint: [1.05, 1.01, 0.94],
      highlightAmount: 0.26,
      saturation: 0.86,
      contrast: 1.02,
      bloomStrength: 0.5,
      grain: 0.03,
      vignette: 0.45,
      aberration: 0.0,
      scanlines: 0.0,
    },
    portrait: {
      tintPull: 0.28,
      grain: 18,
      scanlines: 0.05,
      vignette: 0.5,
      contrast: 1.0,
      desaturation: 0.15,
      unify: '#b8873c',
      unifyAmount: 0.12,
    },
    weapon: {
      metal: '#242730',
      metalLit: '#3c4250',
      furniture: '#2b2b26',
      furnitureLit: '#3f3f36',
      outline: '#0d0f13',
      rim: '#9fb0c4',
      rimStrength: 0.32,
      detail: '#6b7280',
      modelling: 0.85,
    },
    css: {
      '--bg-0': '#0a0c0e',
      '--bg-1': '#111418',
      '--bg-2': '#171b20',
      '--bg-3': '#1f242a',
      '--line': '#2a3037',
      '--line-bright': '#3a424b',
      '--text': '#d2d7dc',
      '--text-dim': '#868f99',
      '--text-faint': '#565e68',
      '--accent': '#b8873c',
      '--accent-dim': '#725429',
      '--good': '#4f9e6a',
      '--bad': '#b8453a',
      '--warn': '#b8873c',
      '--info': '#4f7d9e',
      '--radius': '3px',
      '--panel-border': '1px',
      '--chrome-glow': 'none',
      // Item tiers. These carry information, so all three styles keep five
      // distinguishable steps - what changes is the family they are drawn
      // from, because a saturated blue in a warm monochrome interface reads as
      // a mistake rather than as a rare item.
      '--rarity-common': '#8d9299',
      '--rarity-uncommon': '#5fa86b',
      '--rarity-rare': '#4f86c6',
      '--rarity-epic': '#9a6cc9',
      '--rarity-legendary': '#c98a3c',
    },
  },

  signal: {
    id: 'signal',
    name: 'Signal',
    tagline: 'Klar und kontrastreich. Für den Blick aufs Handy bei Tageslicht.',
    grade: {
      // Complementary grade, pushed hard enough to be a look rather than a
      // correction: the shadows go properly blue and the lit side goes warm,
      // which is what separates planes from each other at a glance.
      shadowTint: [0.82, 0.95, 1.22],
      shadowAmount: 0.42,
      highlightTint: [1.14, 1.02, 0.86],
      highlightAmount: 0.4,
      saturation: 1.18,
      contrast: 1.1,
      bloomStrength: 0.95,
      grain: 0.012,
      vignette: 0.34,
      aberration: 0.15,
      scanlines: 0.0,
    },
    portrait: {
      tintPull: 0.22,
      grain: 9,
      scanlines: 0.0,
      vignette: 0.4,
      contrast: 1.12,
      desaturation: 0.0,
      unify: '#35c8d8',
      unifyAmount: 0.1,
    },
    weapon: {
      metal: '#1c2632',
      metalLit: '#3e5870',
      furniture: '#20303c',
      furnitureLit: '#3d5f74',
      outline: '#080d13',
      rim: '#7fe4f0',
      rimStrength: 0.55,
      detail: '#35c8d8',
      modelling: 1.15,
    },
    css: {
      '--bg-0': '#060a10',
      '--bg-1': '#0d141d',
      '--bg-2': '#142031',
      '--bg-3': '#1d2c40',
      '--line': '#27405a',
      '--line-bright': '#3d6288',
      '--text': '#e8eef5',
      '--text-dim': '#93a6b8',
      '--text-faint': '#5d7085',
      '--accent': '#35c8d8',
      '--accent-dim': '#1c7784',
      '--good': '#3fd08a',
      '--bad': '#ef5a4a',
      '--warn': '#f0a83c',
      '--info': '#4fa8e0',
      '--radius': '7px',
      '--panel-border': '1px',
      '--chrome-glow': '0 0 0 1px rgba(53, 200, 216, 0.10), 0 4px 18px rgba(0, 0, 0, 0.5)',
      // Brighter and cleaner, to survive a phone screen outdoors.
      '--rarity-common': '#9aa8b6',
      '--rarity-uncommon': '#3fd08a',
      '--rarity-rare': '#4fa8e0',
      '--rarity-epic': '#b07ce8',
      '--rarity-legendary': '#f0a83c',
    },
  },

  archiv: {
    id: 'archiv',
    name: 'Archiv',
    tagline: 'Analog. Warmes Monochrom, Korn, Zeilen, harte Kanten.',
    grade: {
      shadowTint: [1.1, 0.98, 0.82],
      shadowAmount: 0.45,
      highlightTint: [1.16, 1.04, 0.78],
      highlightAmount: 0.5,
      // Not all the way to monochrome. A trace of colour left in is what stops
      // it reading as a filter laid over a colour game.
      saturation: 0.52,
      contrast: 1.18,
      bloomStrength: 0.72,
      grain: 0.075,
      vignette: 0.62,
      aberration: 0.35,
      scanlines: 0.055,
    },
    portrait: {
      tintPull: 0.62,
      grain: 34,
      scanlines: 0.14,
      vignette: 0.66,
      contrast: 1.2,
      desaturation: 0.55,
      unify: '#e0a23c',
      unifyAmount: 0.72,
    },
    weapon: {
      metal: '#1b1712',
      metalLit: '#4a3d2b',
      furniture: '#231c14',
      furnitureLit: '#54432c',
      outline: '#000000',
      rim: '#e8b45c',
      rimStrength: 0.62,
      detail: '#b8862f',
      modelling: 1.25,
    },
    css: {
      '--bg-0': '#090705',
      '--bg-1': '#12100b',
      '--bg-2': '#1a1610',
      '--bg-3': '#241f16',
      '--line': '#3a3226',
      '--line-bright': '#55492f',
      '--text': '#e6d9bd',
      '--text-dim': '#9c8c6d',
      '--text-faint': '#6b5f47',
      '--accent': '#e0a23c',
      '--accent-dim': '#8a6222',
      '--good': '#8fa84e',
      '--bad': '#c25a34',
      '--warn': '#e0a23c',
      '--info': '#a89055',
      '--radius': '0px',
      '--panel-border': '1px',
      '--chrome-glow': 'none',
      // Warm throughout, separated by value and by how far each one is allowed
      // to leave the amber family. Five steps, still countable at a glance,
      // none of them fighting the film stock.
      '--rarity-common': '#8d8371',
      '--rarity-uncommon': '#8fa84e',
      '--rarity-rare': '#6f9c9a',
      '--rarity-epic': '#b08a5e',
      '--rarity-legendary': '#e0a23c',
    },
  },
};

export const STYLE_ORDER: StyleId[] = ['feldbericht', 'signal', 'archiv'];

export const DEFAULT_STYLE: StyleId = 'feldbericht';

export function styleById(id: string): VisualStyle {
  return STYLES[id as StyleId] ?? STYLES[DEFAULT_STYLE];
}

/**
 * Push a style's chrome onto the document.
 *
 * The custom properties do the colour work on their own, because every screen
 * is already written against them. The `data-style` attribute is for the
 * handful of things a colour cannot express - hard corners against soft ones,
 * a scanline overlay, whether panels glow - which live in the stylesheet as
 * attribute-scoped rules.
 */
/**
 * Pull a character's own colour towards the active style's.
 *
 * Each trader carries a colour that identifies them at a glance - it names
 * them in the contacts list and rings their portrait. In the two colour styles
 * that identity is worth keeping intact. In the monochrome one a saturated
 * teal name beside three amber ones does not read as a different person, it
 * reads as a different application, so the same unification the portraits get
 * is applied to the text and the borders that go with them.
 */
export function unifyColor(color: string, style: VisualStyle): string {
  const k = style.portrait.unifyAmount;
  if (k <= 0) return color;
  const a = parseInt(color.slice(1), 16);
  const b = parseInt(style.portrait.unify.slice(1), 16);
  const mix = (shift: number): number => {
    const ca = (a >> shift) & 0xff;
    const cb = (b >> shift) & 0xff;
    return Math.round(ca + (cb - ca) * k);
  };
  return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, '0')}`;
}

/** The style currently applied to the document. */
let current: VisualStyle = STYLES[DEFAULT_STYLE];

export function activeStyle(): VisualStyle {
  return current;
}

export function applyStyleToDocument(style: VisualStyle): void {
  current = style;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(style.css)) {
    root.style.setProperty(name, value);
  }
  root.dataset.style = style.id;
}
