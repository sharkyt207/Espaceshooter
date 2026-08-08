/**
 * RecoilPattern - the shape a weapon's spray draws, and why it is a shape.
 *
 * The version this replaces rolled the horizontal kick from a gaussian on
 * every shot. That is defensible physically and ruinous for play: a random
 * walk cannot be learned, so the correct response to full-auto at range is
 * always "don't", and nothing the player practises ever pays off. The user
 * asked for recoil the player can control, and control requires that the
 * weapon do the same thing twice.
 *
 * So each weapon gets a **pattern**: a fixed sequence of directions, one per
 * shot in the magazine, that repeats exactly. A player who has learned an
 * SK-762 can hold thirty rounds on a torso at forty metres. A player who has
 * not will walk the burst up and to the left, every time, in the same way.
 *
 * The randomness that remains is deliberate and small - a few percent of jitter
 * on top - so that two bursts are never pixel-identical and the pattern reads
 * as a weapon rather than as a machine. Turning it up destroys learnability;
 * turning it to zero makes bursts feel synthetic.
 *
 * Patterns are generated rather than hand-authored. Hand-authoring thirty
 * points for thirteen weapons is a lot of numbers to get subtly wrong, and the
 * shapes that matter are describable: how far it climbs, when the climb tails
 * off, which way it drifts, and how violently it snakes.
 */

import { Rng } from '../core/Random';

/** One shot's contribution, in multiples of the weapon's base recoil. */
export interface RecoilStep {
  vertical: number;
  horizontal: number;
}

/** The knobs that describe a weapon's character in the air. */
export interface PatternSpec {
  /**
   * How many shots the climb takes to flatten out.
   *
   * Real recoil is worst at the start of a burst - the shooter has not yet
   * loaded the stock - and then settles. A short value gives a weapon that
   * kicks hard and then sits still, which is what makes controlled bursts the
   * right answer for it.
   */
  climbShots: number;
  /** Vertical kick once the climb has settled, relative to the first shot. */
  sustainedRise: number;
  /**
   * Which way the muzzle wanders, -1 hard left to +1 hard right.
   *
   * The signature of a weapon. A consistent lean is what a player learns to
   * counter, and giving each weapon its own is most of what makes them feel
   * like different objects rather than different stat blocks.
   */
  drift: number;
  /** How far the horizontal wander swings around that drift. */
  snake: number;
  /** Shots before the horizontal wander reverses. Longer = lazier arcs. */
  snakePeriod: number;
  /** Per-shot random jitter, as a fraction. Small on purpose. */
  jitter: number;
}

/** A sensible middle, and the base every weapon's spec varies from. */
export const DEFAULT_PATTERN: PatternSpec = {
  climbShots: 5,
  sustainedRise: 0.55,
  drift: 0.15,
  snake: 0.7,
  snakePeriod: 7,
  jitter: 0.16,
};

/** How many shots a pattern covers before it repeats. */
const PATTERN_LENGTH = 40;

/**
 * Build the fixed sequence for one weapon.
 *
 * Deterministic from the weapon's id, so the same weapon always draws the same
 * shape - across sessions, across devices, and for every player. That is the
 * property the whole idea rests on: a pattern nobody can rely on is just noise
 * with extra steps.
 */
export function buildPattern(weaponId: string, spec: PatternSpec): RecoilStep[] {
  const rng = new Rng(`recoil:${weaponId}`);
  const steps: RecoilStep[] = [];

  for (let shot = 0; shot < PATTERN_LENGTH; shot++) {
    // Vertical: strongest on the first shot, decaying towards the sustained
    // level over `climbShots`. Exponential rather than linear because that is
    // how the felt impulse actually tails off, and because it keeps the first
    // two shots clearly the sharpest - which is what rewards tapping.
    const decay = Math.exp(-shot / Math.max(0.5, spec.climbShots));
    const vertical = spec.sustainedRise + (1 - spec.sustainedRise) * decay;

    // Horizontal: a slow triangle wave around the weapon's drift. A triangle
    // rather than a sine because the reversals are what a player actually
    // notices and remembers, and a sine rounds them off into mush.
    const phase = (shot % spec.snakePeriod) / spec.snakePeriod;
    const triangle = phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4;
    const horizontal = spec.drift + triangle * spec.snake;

    steps.push({ vertical, horizontal });
  }

  // A single deterministic pass of jitter, baked in rather than rolled per
  // shot at runtime. The pattern stays identical every time it is fired, but
  // it is not a clean mathematical curve either - which is the difference
  // between a weapon and a waveform.
  for (const step of steps) {
    step.vertical *= 1 + (rng.float() - 0.5) * spec.jitter;
    step.horizontal += (rng.float() - 0.5) * spec.jitter * 1.4;
  }

  return steps;
}

/** Cache, because a pattern is a pure function of the id and the spec. */
const cache = new Map<string, RecoilStep[]>();

export function patternFor(weaponId: string, spec: PatternSpec = DEFAULT_PATTERN): RecoilStep[] {
  const key = `${weaponId}|${spec.climbShots}|${spec.sustainedRise}|${spec.drift}|${spec.snake}|${spec.snakePeriod}|${spec.jitter}`;
  let pattern = cache.get(key);
  if (!pattern) {
    pattern = buildPattern(weaponId, spec);
    cache.set(key, pattern);
  }
  return pattern;
}

/**
 * Read one step, wrapping past the end of the pattern.
 *
 * Wrapping rather than clamping: a hundred-round belt should keep moving, and
 * a pattern that freezes after forty shots would make the last two thirds of
 * an LMG magazine trivially controllable.
 */
export function stepAt(pattern: RecoilStep[], shotIndex: number): RecoilStep {
  return pattern[((shotIndex % pattern.length) + pattern.length) % pattern.length];
}

/**
 * Per-class defaults.
 *
 * These are where the weapons stop being stat blocks and start having
 * handling. A pistol snaps and settles; an SMG snakes because it is light and
 * fast; a battle rifle climbs hard and drifts consistently; an LMG is a
 * long, lazy arc you lean into.
 */
export const PATTERN_BY_CLASS: Record<string, PatternSpec> = {
  pistol:   { climbShots: 2.5, sustainedRise: 0.75, drift: 0.10, snake: 0.55, snakePeriod: 5, jitter: 0.22 },
  smg:      { climbShots: 4,   sustainedRise: 0.5,  drift: -0.2, snake: 0.95, snakePeriod: 6, jitter: 0.2 },
  carbine:  { climbShots: 5,   sustainedRise: 0.52, drift: 0.18, snake: 0.62, snakePeriod: 8, jitter: 0.15 },
  rifle:    { climbShots: 6,   sustainedRise: 0.48, drift: 0.22, snake: 0.7,  snakePeriod: 9, jitter: 0.14 },
  battle:   { climbShots: 4,   sustainedRise: 0.68, drift: 0.3,  snake: 0.5,  snakePeriod: 6, jitter: 0.13 },
  dmr:      { climbShots: 2,   sustainedRise: 0.85, drift: 0.12, snake: 0.35, snakePeriod: 4, jitter: 0.12 },
  sniper:   { climbShots: 1.5, sustainedRise: 0.95, drift: 0.05, snake: 0.25, snakePeriod: 3, jitter: 0.1 },
  shotgun:  { climbShots: 2,   sustainedRise: 0.9,  drift: -0.1, snake: 0.4,  snakePeriod: 4, jitter: 0.2 },
  lmg:      { climbShots: 9,   sustainedRise: 0.42, drift: 0.34, snake: 0.85, snakePeriod: 13, jitter: 0.12 },
};
