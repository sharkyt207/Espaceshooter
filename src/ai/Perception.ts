import { clamp01, angleDelta, distance } from '../core/Math2D';
import type { SoundEventPayload } from '../core/GameEvents';
import { hasLineOfSight } from '../world/Raycast';
import type { TileMap } from '../world/TileMap';
import type { Combatant } from '../combat/Combatant';
import type { AIProfile } from './AIProfiles';

/**
 * Perception - what an AI knows, and how sure it is.
 *
 * Detection is a *build-up*, not a boolean. Standing in the open at 10 m in
 * daylight gets you spotted in a fraction of a second; crawling through shadow
 * at 30 m may never trip it at all. This gives the player real agency over
 * being seen - stance, light, distance and movement all feed the same
 * awareness accumulator - and it means an AI that loses sight of you keeps a
 * decaying belief about where you went rather than snapping to omniscience.
 *
 * Hearing produces a *degraded* position: loud, close sounds localise well,
 * distant ones only give a bearing. That is what makes suppressors valuable
 * and makes sprinting past a patrol a genuine gamble.
 */

export interface Awareness {
  /** 0..1 how certain the AI is that a target is there. */
  level: number;
  /** Last position the AI actually saw or accurately heard. */
  lastKnownX: number;
  lastKnownY: number;
  /** Seconds since the target was last directly visible. */
  timeSinceSeen: number;
  /** True while the target is in the vision cone with clear line of sight. */
  visible: boolean;
  /** Distance at the last update, in tiles. */
  distance: number;
  /** Set when the AI has a firing solution. */
  canEngage: boolean;
}

export function createAwareness(): Awareness {
  return {
    level: 0,
    lastKnownX: 0,
    lastKnownY: 0,
    timeSinceSeen: 999,
    visible: false,
    distance: 999,
    canEngage: false,
  };
}

/** Awareness above this counts as "I know exactly where you are". */
export const ENGAGE_THRESHOLD = 0.85;
/** Above this the AI starts investigating but will not shoot yet. */
export const SUSPICION_THRESHOLD = 0.3;

export interface PerceptionInput {
  observerX: number;
  observerY: number;
  observerAngle: number;
  /** Multiplier from equipment - a closed helmet costs hearing. */
  hearingMultiplier: number;
  /** True while the observer is suppressed; tunnel vision reduces the cone. */
  suppressed: boolean;
  /**
   * Environmental multiplier on spotting range: darkness, fog and heavy rain
   * all shorten it. 1 = clear daylight.
   */
  sightScale: number;
}

/**
 * Update awareness of one target for one observer.
 * Called at the AI's think rate, not every frame.
 */
export function updateVision(
  awareness: Awareness,
  profile: AIProfile,
  input: PerceptionInput,
  target: Combatant,
  map: TileMap,
  dt: number,
  targetSpeed: number,
  targetStance: number,
  targetGlow = 0,
): void {
  awareness.timeSinceSeen += dt;

  const dist = distance(input.observerX, input.observerY, target.x, target.y);
  awareness.distance = dist;

  // A lit torch is visible long past the range at which a body is, which is
  // the whole reason carrying one is a decision rather than a free upgrade.
  const sightRange = profile.sightRange * input.sightScale * (1 + targetGlow * 0.9);

  // --- gating ------------------------------------------------------------
  let detected = false;
  if (target.alive && dist <= sightRange) {
    const bearing = Math.atan2(target.y - input.observerY, target.x - input.observerX);
    // Suppression narrows the cone: people under fire stop scanning wide.
    const fov = profile.fovHalfAngle * (input.suppressed ? 0.6 : 1);
    if (Math.abs(angleDelta(input.observerAngle, bearing)) <= fov) {
      // Line of sight is tested against the target's eye line, so someone
      // crouched behind a crate is genuinely hidden.
      detected = hasLineOfSight(map, input.observerX, input.observerY, target.x, target.y);
    }
  }

  awareness.visible = detected;

  if (detected) {
    // --- how conspicuous is the target right now? ------------------------
    // Distance: full strength up close, tapering to nothing at max range.
    const distanceFactor = 1 - clamp01(dist / sightRange) ** 1.5;
    // Light: the lightmap the renderer uses is also what the AI "sees" by, so
    // shadows are real cover, not a cosmetic effect. A torch overrides all of
    // it - you cannot hide in a shadow you are illuminating.
    const light = map.lightAt(Math.floor(target.x), Math.floor(target.y)) / 255;
    const lightFactor = 0.25 + clamp01(light + targetGlow * 1.15) * 0.75;
    // Stance: prone is a fraction of the silhouette of a standing target.
    const stanceFactor = targetStance === 0 ? 0.34 : targetStance === 1 ? 0.62 : 1;
    // Movement draws the eye more than anything else.
    const motionFactor = 1 + clamp01(targetSpeed / 3) * 1.1;

    const conspicuity = distanceFactor * lightFactor * stanceFactor * motionFactor;
    const gain = (conspicuity / Math.max(0.05, profile.acquireTime)) * dt;
    awareness.level = clamp01(awareness.level + gain);

    // Only a reasonably confident observer commits the position to memory.
    if (awareness.level > SUSPICION_THRESHOLD) {
      awareness.lastKnownX = target.x;
      awareness.lastKnownY = target.y;
      awareness.timeSinceSeen = 0;
    }
  } else {
    // Belief decays: fast at first, then a long tail so an AI keeps searching
    // the area for a while instead of instantly forgetting.
    const decay = awareness.level > ENGAGE_THRESHOLD ? 0.22 : 0.4;
    awareness.level = Math.max(0, awareness.level - decay * dt);
  }

  awareness.canEngage = awareness.visible && awareness.level >= ENGAGE_THRESHOLD;
}

/**
 * Fold a heard sound into awareness.
 *
 * The reported position is deliberately *wrong* in proportion to how faint the
 * sound was, so AI converge on a general area rather than beelining to the
 * exact tile a footstep came from.
 */
export function hearSound(
  awareness: Awareness,
  profile: AIProfile,
  input: PerceptionInput,
  sound: SoundEventPayload,
  map: TileMap,
  jitter: (magnitude: number) => number,
): boolean {
  const dist = distance(input.observerX, input.observerY, sound.x, sound.y);
  const effectiveRadius = sound.radius * profile.hearingFactor * input.hearingMultiplier;
  if (dist > effectiveRadius) return false;

  // Walls muffle: accumulate damping along the line to the source.
  const occlusion = estimateOcclusion(map, input.observerX, input.observerY, sound.x, sound.y);
  const attenuation = (1 - clamp01(dist / effectiveRadius)) * (1 - occlusion);
  const strength = sound.intensity * attenuation;
  if (strength < 0.06) return false;

  // Gunfire is unambiguous; a footstep through a wall is a vague direction.
  const isLoud = sound.kind === 'gunshot' || sound.kind === 'explosion';
  const positionalError = (1 - strength) * (isLoud ? 3.5 : 9);

  awareness.level = clamp01(awareness.level + strength * (isLoud ? 0.75 : 0.4));
  // Never overwrite a fresher visual fix with a vaguer audio one.
  if (awareness.timeSinceSeen > 1.5 || awareness.level < ENGAGE_THRESHOLD) {
    awareness.lastKnownX = sound.x + jitter(positionalError);
    awareness.lastKnownY = sound.y + jitter(positionalError);
  }
  return true;
}

/**
 * Approximate sound occlusion between two points, 0 (clear) to 1 (blocked).
 * Sampled rather than walked: perception runs often enough that a coarse
 * estimate is the right trade.
 */
export function estimateOcclusion(map: TileMap, ax: number, ay: number, bx: number, by: number): number {
  const steps = 8;
  let damping = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = Math.floor(ax + (bx - ax) * t);
    const y = Math.floor(ay + (by - ay) * t);
    damping += map.soundDampingOf(x, y);
    if (damping >= 1) return 1;
  }
  return clamp01(damping);
}
