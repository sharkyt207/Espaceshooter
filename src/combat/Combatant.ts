import type { HealthSystem } from '../health/HealthSystem';
import type { Inventory } from '../inventory/Inventory';
import type { BodyPart } from '../data/ItemTypes';

/**
 * Combatant - the minimal contract anything shootable must satisfy.
 *
 * Ballistics, AI perception and the audio system all work against this
 * interface rather than against the Player or Enemy classes. That keeps the
 * damage pipeline identical for both sides: the player is hit by exactly the
 * same code path as an AI, so there is no asymmetry to balance around.
 */
export interface Combatant {
  readonly id: number;
  /** World position in tiles. */
  x: number;
  y: number;
  /** Collision radius in tiles. */
  readonly radius: number;
  /** Standing height in metres, used for hit-zone resolution. */
  height: number;
  /** Current eye height in metres (drops when crouched or prone). */
  eyeHeight: number;
  /** Facing in radians. */
  angle: number;

  readonly health: HealthSystem;
  /** Armour lookup source. AI without gear may pass a minimal inventory. */
  readonly inventory: Inventory;

  readonly isPlayer: boolean;
  readonly name: string;

  /** Convenience: alive means the health system has not flagged death. */
  readonly alive: boolean;

  /** Called when a round connects, before damage is applied. */
  onHit?(attackerId: number, part: BodyPart, damage: number, penetrated: boolean, dirX: number, dirY: number): void;

  /**
   * Called when a round passes close by without connecting.
   * This is what drives suppression - being shot at changes behaviour even
   * when nothing lands, which is most of what a real firefight is.
   */
  onNearMiss?(attackerId: number, closeness: number, fromX: number, fromY: number): void;
}

/**
 * Vertical hit zones as fractions of standing height.
 *
 * Deliberately generous towards the torso and stingy towards the head: a
 * headshot should be a skill outcome, not a lottery win from spray.
 */
export const HIT_ZONES: { part: BodyPart; from: number; to: number }[] = [
  { part: 'head', from: 0.88, to: 1.06 },
  { part: 'thorax', from: 0.62, to: 0.88 },
  { part: 'stomach', from: 0.48, to: 0.62 },
  { part: 'leftLeg', from: 0.0, to: 0.48 },
];

/**
 * Resolve which body part a round strikes.
 *
 * `heightFraction` is the impact height divided by the target's standing
 * height. `lateralFraction` is the horizontal offset from centre mass, -1..1,
 * which is what decides arms versus torso and left leg versus right.
 */
export function resolveHitZone(
  heightFraction: number,
  lateralFraction: number,
  roll: () => number,
): BodyPart {
  // Outer third of the silhouette at torso height is an arm.
  const lateral = Math.abs(lateralFraction);
  if (heightFraction >= 0.5 && heightFraction < 0.9 && lateral > 0.52) {
    return lateralFraction < 0 ? 'leftArm' : 'rightArm';
  }
  if (heightFraction >= 0.88) {
    // Very wide hits at head height clip a shoulder instead.
    return lateral > 0.6 ? (lateralFraction < 0 ? 'leftArm' : 'rightArm') : 'head';
  }
  if (heightFraction >= 0.62) return 'thorax';
  if (heightFraction >= 0.48) return 'stomach';
  // Below the waist: pick the leg on the side that was hit, with a coin flip
  // for dead-centre impacts.
  if (Math.abs(lateralFraction) < 0.08) return roll() < 0.5 ? 'leftLeg' : 'rightLeg';
  return lateralFraction < 0 ? 'leftLeg' : 'rightLeg';
}
