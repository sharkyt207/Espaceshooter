/**
 * Spatial - turning a world position into what the player's ears receive.
 *
 * Pulled out of `AudioEngine` because this is the part that decides whether a
 * player can locate a firefight, and it was previously unreachable by any test:
 * the engine needs an `AudioContext`, so the one piece of genuinely tricky
 * arithmetic in the audio system lived behind a browser dependency.
 *
 * Three cues, and only the first two are obvious:
 *
 *   - **Level.** Nearer is louder. Inverse falloff with a soft floor, so a
 *     distant firefight stays just audible - that audibility is the thing that
 *     lets a player orient towards trouble rather than being ambushed by it.
 *   - **Pan.** Where the sound sits between the ears, from its bearing.
 *   - **Timbre.** Which is the one that makes the difference between "a shot"
 *     and "a shot from behind me".
 *
 * The third exists because pan alone cannot tell front from back. The correct
 * law for stereo placement is the sine of the bearing - a source at ninety
 * degrees is fully lateral, one straight ahead is centred - and the sine of
 * ninety degrees behind you is exactly the sine of ninety degrees in front.
 * Panning is symmetric about the interaural axis and no amount of tuning fixes
 * that; it is the same cone of confusion real ears have.
 *
 * Real ears resolve it with the head and the outer ear, which shadow high
 * frequencies arriving from behind. So does this: a sound behind the listener
 * is filtered noticeably darker and dropped slightly in level. That is enough
 * for a player to whip round rather than hunt.
 */

/** What the mixer needs in order to place one sound. */
export interface SpatialResult {
  /** 0..1 linear. */
  gain: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
  /** Low-pass corner in Hz. */
  cutoff: number;
  /** 1 straight ahead, -1 straight behind. Exposed for the HUD. */
  facing: number;
}

export interface ListenerState {
  x: number;
  y: number;
  angle: number;
  /** Scales how far the player hears; injuries and gear move it. */
  hearingFactor: number;
  /** 0..1 temporary deafening from a nearby blast. */
  deafness: number;
}

/**
 * How much of the high end survives from directly behind.
 *
 * Chosen by what it has to accomplish rather than from a measurement: large
 * enough that "behind" is unmistakable on a phone speaker, small enough that a
 * shot behind you still sounds like a shot rather than like a different event.
 */
const REAR_BRIGHTNESS = 0.42;
/** Head shadow, in level. Deliberately slight - timbre carries this cue. */
const REAR_LEVEL = 0.88;

/**
 * Place a sound, or return null when it is inaudible.
 *
 * `occlusion` 0..1 comes from the same estimate the AI hearing model uses, so
 * what muffles an enemy's hearing muffles the player's identically - a wall is
 * a wall for both sides, which is what keeps sound a fair information channel
 * rather than a one-sided advantage.
 */
export function spatialise(
  listener: ListenerState,
  x: number,
  y: number,
  radius: number,
  occlusion: number,
): SpatialResult | null {
  const dx = x - listener.x;
  const dy = y - listener.y;
  const dist = Math.hypot(dx, dy);
  const audibleRange = radius * listener.hearingFactor;
  if (dist > audibleRange * 1.6) return null;

  // Inverse falloff with a soft floor - distant shots stay just audible,
  // which is what lets the player orient towards a firefight.
  const attenuation = 1 / (1 + (dist / Math.max(1, audibleRange * 0.35)) ** 1.7);
  let gain = attenuation * (1 - occlusion * 0.72) * (1 - listener.deafness * 0.85);
  gain *= listener.hearingFactor;

  const bearing = Math.atan2(dy, dx) - listener.angle;
  // Sine for the pan, which is the correct placement law and is also exactly
  // why it cannot distinguish front from back on its own.
  const pan = Math.max(-1, Math.min(1, Math.sin(bearing)));
  // Cosine for the front-back axis: 1 dead ahead, -1 dead behind.
  const facing = Math.cos(bearing);

  // Head shadow. `facing` maps to 0..1 with 1 at the front, and the brightness
  // and level both follow it.
  const front = facing * 0.5 + 0.5;
  const rearBrightness = REAR_BRIGHTNESS + (1 - REAR_BRIGHTNESS) * front;
  gain *= REAR_LEVEL + (1 - REAR_LEVEL) * front;

  if (gain < 0.004) return null;

  // Air and walls both eat high frequencies, and so does having your head in
  // the way.
  const cutoff = Math.max(
    260,
    16000 * (1 - occlusion * 0.8) * (1 / (1 + dist * 0.08)) * rearBrightness,
  );

  return { gain, pan, cutoff, facing };
}
