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
 * The three sit at genuinely different places, and only one of them is a
 * grade:
 *
 *   - **Comic** is drawn. The lighting is quantised into four bands *before*
 *     it touches the texture, silhouettes are inked from the depth buffer, and
 *     the shadows carry ben-day dots. None of that is something a camera can
 *     do, which is the point - it is the only one of the three that changes
 *     how the world is shaded rather than how the result is developed.
 *   - **Futuristisch** is clean and lit. Deep blue-violet shadows, strong
 *     bloom, a faint cyan edge on every silhouette, lens fringing. Bright,
 *     high-contrast, and built to read on a phone in daylight.
 *   - **Realistisch** is photographic. Near-neutral colour, a filmic curve, a
 *     trace of grain and just enough lens error to stop it looking computed.
 *     No treatment you are meant to notice.
 *
 * Everything here is authored for this project - the palettes, the names, the
 * treatment values. Nothing is sampled from anywhere.
 */

export type StyleId = 'comic' | 'futuristisch' | 'realistisch';

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

  // --- non-photographic treatment ----------------------------------------
  //
  // The three above are things a camera does. These are things a camera does
  // not, and they are what separates a drawn look from a graded one.

  /**
   * Quantise the lighting into this many bands. 0 leaves it continuous.
   *
   * This is the heart of a cel-shaded look and it happens in the world shader,
   * not in the composite: light has to be banded *before* it is multiplied by
   * the texture, or the bands land on the albedo instead of on the form and
   * the surface reads as posterised paint rather than as a lit object.
   */
  celBands: number;
  /**
   * How dark the lowest band is allowed to get, 0 = black.
   *
   * With four bands and no floor, anything below an eighth of full light
   * collapses to nothing, and a dusk scene loses its whole lower half. Comics
   * do use solid black, but as a deliberate mark - not as everything that
   * happened to fall under a threshold.
   */
  celFloor: number;
  /**
   * Ink the silhouettes, found by looking for abrupt depth changes.
   *
   * Strength is how dark the line gets; width is how far apart the samples
   * sit, in pixels, which is effectively the pen nib.
   */
  outline: number;
  outlineWidth: number;
  outlineColor: [number, number, number];
  /**
   * Ben-day dots in the shadows, at this strength.
   *
   * Screen-space and scaled to the display, because it is printing, not
   * something in the world - a halftone locked to the geometry would swim.
   */
  halftone: number;
  /** Flatten colour to this many steps per channel. 0 leaves it alone. */
  posterize: number;
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
  /** Flatten to this many steps per channel. 0 leaves the image continuous. */
  posterize: number;
  /** Darken the outer edge of the head into a drawn contour. */
  ink: number;
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
  comic: {
    id: 'comic',
    name: 'Comic',
    tagline: 'Gezeichnet. Vier Lichtstufen, gezogene Konturen, Rasterpunkte im Schatten.',
    grade: {
      // Warm-cool split kept modest: the banding and the ink already carry the
      // look, and a strong grade on top would just muddy the flat areas.
      shadowTint: [0.9, 0.96, 1.14],
      shadowAmount: 0.3,
      highlightTint: [1.1, 1.03, 0.9],
      highlightAmount: 0.3,
      saturation: 1.5,
      contrast: 1.16,
      // Printed pages do not glow. Just enough to keep a muzzle flash reading
      // as light rather than as a white sticker.
      bloomStrength: 0.35,
      grain: 0.0,
      vignette: 0.26,
      aberration: 0.0,
      scanlines: 0.0,
      celBands: 4,
      celFloor: 0.2,
      outline: 0.95,
      outlineWidth: 1.5,
      // Not pure black. Ink on paper picks up the colour around it, and a
      // dead-black line against a blue scene reads as a hole.
      outlineColor: [0.05, 0.05, 0.09],
      halftone: 0.38,
      // Ten steps per channel: enough to flatten the gradients that survive
      // the banding, not so few that the sky posterises into stripes.
      posterize: 10,
    },
    portrait: {
      tintPull: 0.3,
      grain: 0,
      scanlines: 0,
      vignette: 0.34,
      contrast: 1.3,
      desaturation: 0,
      unify: '#f0a830',
      unifyAmount: 0.1,
      posterize: 7,
      ink: 0.8,
    },
    weapon: {
      // Flat, saturated, and lit hard - a drawn object, not a photographed one.
      metal: '#2b3550',
      metalLit: '#63799e',
      furniture: '#3a3020',
      furnitureLit: '#7c6438',
      outline: '#0b0c12',
      rim: '#ffe9a8',
      rimStrength: 0.85,
      detail: '#e8483c',
      modelling: 1.35,
    },
    css: {
      '--bg-0': '#141726',
      '--bg-1': '#1d2237',
      '--bg-2': '#262d47',
      '--bg-3': '#333c5c',
      '--line': '#4a5680',
      '--line-bright': '#6d7cae',
      '--text': '#fdf6e8',
      '--text-dim': '#b3bcd8',
      '--text-faint': '#7b86ad',
      '--accent': '#ffc23c',
      '--accent-dim': '#a8761c',
      '--good': '#48d97b',
      '--bad': '#f0503c',
      '--warn': '#ffc23c',
      '--info': '#49b6f0',
      '--radius': '10px',
      '--panel-border': '2px',
      '--chrome-glow': '0 3px 0 rgba(11, 12, 18, 0.85)',
      '--rarity-common': '#b7c0d8',
      '--rarity-uncommon': '#48d97b',
      '--rarity-rare': '#49b6f0',
      '--rarity-epic': '#c07ef0',
      '--rarity-legendary': '#ffc23c',
    },
  },

  futuristisch: {
    id: 'futuristisch',
    name: 'Futuristisch',
    tagline: 'Sauber und hell. Blauviolette Schatten, starkes Leuchten, Zyan-Kante.',
    grade: {
      shadowTint: [0.78, 0.9, 1.28],
      shadowAmount: 0.48,
      highlightTint: [1.1, 1.06, 0.94],
      highlightAmount: 0.4,
      saturation: 1.26,
      contrast: 1.12,
      // The loudest thing in this direction. Emissive surfaces need somewhere
      // to bleed to, or "high-tech" is just blue.
      bloomStrength: 1.3,
      grain: 0.008,
      vignette: 0.3,
      aberration: 0.22,
      // A trace, so the image reads as being behind glass rather than printed.
      scanlines: 0.018,
      celBands: 0,
      celFloor: 0,
      // A cool edge rather than an ink line: it separates silhouettes the way
      // a rim light would, without turning the scene into a drawing.
      outline: 0.3,
      outlineWidth: 1.2,
      outlineColor: [0.45, 0.92, 1.0],
      halftone: 0.0,
      posterize: 0,
    },
    portrait: {
      tintPull: 0.24,
      grain: 7,
      scanlines: 0.06,
      vignette: 0.42,
      contrast: 1.14,
      desaturation: 0.1,
      unify: '#3ad8e8',
      unifyAmount: 0.16,
      posterize: 0,
      ink: 0,
    },
    weapon: {
      metal: '#151c2a',
      metalLit: '#3c5a7c',
      furniture: '#1b2534',
      furnitureLit: '#38566e',
      outline: '#060a10',
      rim: '#7ff0ff',
      rimStrength: 0.7,
      detail: '#3ad8e8',
      modelling: 1.2,
    },
    css: {
      '--bg-0': '#05070d',
      '--bg-1': '#0b1119',
      '--bg-2': '#111b28',
      '--bg-3': '#19283a',
      '--line': '#23415c',
      '--line-bright': '#3a6a94',
      '--text': '#eaf4fa',
      '--text-dim': '#93aec4',
      '--text-faint': '#5c7891',
      '--accent': '#3ad8e8',
      '--accent-dim': '#1b7d89',
      '--good': '#38e2a0',
      '--bad': '#ff5d6c',
      '--warn': '#ffb03a',
      '--info': '#5aa8ff',
      '--radius': '8px',
      '--panel-border': '1px',
      '--chrome-glow': '0 0 0 1px rgba(58, 216, 232, 0.14), 0 6px 26px rgba(0, 0, 0, 0.6)',
      '--rarity-common': '#93aec4',
      '--rarity-uncommon': '#38e2a0',
      '--rarity-rare': '#5aa8ff',
      '--rarity-epic': '#b478ff',
      '--rarity-legendary': '#ffb03a',
    },
  },

  realistisch: {
    id: 'realistisch',
    name: 'Realistisch',
    tagline: 'Fotografisch. Nahezu neutral, filmische Kurve, kaum sichtbare Nachbearbeitung.',
    grade: {
      // Close to how daylight actually behaves: shadows pick up the sky, lit
      // surfaces pick up the sun. Small numbers on purpose.
      shadowTint: [0.94, 0.99, 1.09],
      shadowAmount: 0.32,
      highlightTint: [1.07, 1.02, 0.93],
      highlightAmount: 0.3,
      saturation: 0.96,
      contrast: 1.05,
      bloomStrength: 0.55,
      // A sensor is never silent. Barely visible, and the image looks wrong
      // without it - too clean reads as computed.
      grain: 0.022,
      vignette: 0.5,
      // Every real lens has some. Six hundredths is under the threshold of
      // noticing and over the threshold of mattering.
      aberration: 0.06,
      scanlines: 0.0,
      celBands: 0,
      celFloor: 0,
      outline: 0.0,
      outlineWidth: 1.0,
      outlineColor: [0, 0, 0],
      halftone: 0.0,
      posterize: 0,
    },
    portrait: {
      tintPull: 0.2,
      grain: 14,
      scanlines: 0.03,
      vignette: 0.5,
      contrast: 1.02,
      desaturation: 0.08,
      unify: '#b8873c',
      unifyAmount: 0.1,
      posterize: 0,
      ink: 0,
    },
    weapon: {
      metal: '#23262c',
      metalLit: '#3a414c',
      furniture: '#2b2b25',
      furnitureLit: '#414036',
      outline: '#0c0e11',
      rim: '#a8b4c2',
      rimStrength: 0.34,
      detail: '#69707a',
      modelling: 0.9,
    },
    css: {
      '--bg-0': '#0b0c0e',
      '--bg-1': '#121417',
      '--bg-2': '#191c20',
      '--bg-3': '#22262b',
      '--line': '#2d3238',
      '--line-bright': '#3e444c',
      '--text': '#d5d9de',
      '--text-dim': '#8a929b',
      '--text-faint': '#5a626b',
      '--accent': '#b8873c',
      '--accent-dim': '#72542a',
      '--good': '#5a9c6d',
      '--bad': '#b34a3c',
      '--warn': '#b8873c',
      '--info': '#4f7d9e',
      '--radius': '4px',
      '--panel-border': '1px',
      '--chrome-glow': 'none',
      '--rarity-common': '#8d9299',
      '--rarity-uncommon': '#5fa86b',
      '--rarity-rare': '#4f86c6',
      '--rarity-epic': '#9a6cc9',
      '--rarity-legendary': '#c98a3c',
    },
  },
};

export const STYLE_ORDER: StyleId[] = ['comic', 'futuristisch', 'realistisch'];

export const DEFAULT_STYLE: StyleId = 'realistisch';

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
