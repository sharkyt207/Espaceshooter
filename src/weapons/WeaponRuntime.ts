import { ItemDB } from '../data/ItemDatabase';
import type { AttachmentSlot, FireMode, ItemDef, WeaponStats } from '../data/ItemTypes';
import { TUBE_MAGAZINES } from '../data/WeaponData';
import { defOf, type ItemStack } from '../inventory/ItemStack';
import { clamp } from '../core/Math2D';

/**
 * WeaponRuntime - turns a weapon item plus its fitted parts into the numbers
 * the combat loop actually uses.
 *
 * Kept as a pure function over the item stack so that the inventory screen can
 * preview a modification's effect without touching gameplay state: the same
 * resolver produces both the stat panel and the live weapon behaviour, so what
 * the player is shown is guaranteed to be what they get.
 *
 * Multipliers compose multiplicatively (recoil, accuracy, loudness); absolute
 * values compose additively (ergonomics seconds, muzzle velocity).
 */

export interface ResolvedWeapon {
  def: ItemDef;
  base: WeaponStats;

  caliber: string;
  fireModes: FireMode[];
  rpm: number;
  burstCount: number;

  /** Degrees of muzzle rise per shot. */
  recoilVertical: number;
  /** Degrees of lateral kick per shot (sign randomised at fire time). */
  recoilHorizontal: number;
  /** Degrees per second the muzzle settles back down. */
  recoilRecovery: number;

  /** Mechanical dispersion in MOA, after wear and parts. */
  accuracyMoa: number;
  /** Seconds to bring the weapon into the aimed position. */
  adsTime: number;
  /** Seconds to swap to this weapon. */
  swapTime: number;

  reloadTactical: number;
  reloadEmpty: number;
  magCapacity: number;
  /** Tube-fed weapons load one shell at a time. */
  tubeFed: boolean;

  /** World-unit radius at which the shot is audible. */
  loudness: number;
  suppressed: boolean;

  /** Sighted magnification, 1 = none. */
  zoom: number;
  illuminatedReticle: boolean;
  /** Weapon light radius in tiles, 0 = none. */
  lightRadius: number;
  /** m/s added to the cartridge's muzzle velocity. */
  velocityBonus: number;

  /** 0-100 condition. */
  durability: number;
  /** Probability per shot of a malfunction. */
  jamChance: number;
}

export interface ResolveContext {
  /** Ergonomics penalty in seconds from worn armour and rigs. */
  gearErgoPenalty: number;
  /** 0..1 progress in the weapon-handling skill; reduces handling times. */
  handlingSkill: number;
  /** 0..1 progress in the recoil-control skill. */
  recoilSkill: number;
}

const NEUTRAL_CONTEXT: ResolveContext = { gearErgoPenalty: 0, handlingSkill: 0, recoilSkill: 0 };

export function resolveWeapon(stack: ItemStack, ctx: ResolveContext = NEUTRAL_CONTEXT): ResolvedWeapon {
  const def = defOf(stack);
  const base = def.weapon;
  if (!base) throw new Error(`[WeaponRuntime] item "${stack.defId}" is not a weapon`);

  let recoilMul = 1;
  // Tracked per axis as well as overall, so a grip and a stock do different
  // things to the same weapon rather than the same thing by different amounts.
  let recoilMulV = 1;
  let recoilMulH = 1;
  let accuracyMul = 1;
  let loudnessMul = 1;
  let ergoDelta = 0;
  let zoom = base.ironSightZoom;
  let illuminated = false;
  let lightRadius = 0;
  let velocityBonus = 0;
  let suppressed = false;

  if (stack.attachments) {
    for (const slot of Object.keys(stack.attachments) as AttachmentSlot[]) {
      const att = stack.attachments[slot];
      if (!att) continue;
      const a = ItemDB.get(att.defId).attachment;
      if (!a) continue;
      recoilMul *= a.recoilMultiplier;
      // Split the part's benefit across the axes by its bias. A part that
      // removes 20 percent of recoil with a bias of -0.7 takes most of that
      // from the climb and only a little from the wander; the total effect is
      // preserved either way, so nothing gets stronger by being specialised.
      const effect = 1 - a.recoilMultiplier;
      const bias = a.recoilAxis ?? 0;
      recoilMulV *= 1 - effect * (1 - bias) * 0.5 * 2;
      recoilMulH *= 1 - effect * (1 + bias) * 0.5 * 2;
      accuracyMul *= a.accuracyMultiplier;
      loudnessMul *= a.loudnessMultiplier;
      ergoDelta += a.ergonomicsDelta;
      velocityBonus += a.velocityDelta;
      if (a.zoom > 1 || slot === 'optic') {
        zoom = Math.max(zoom, a.zoom);
        illuminated = illuminated || a.illuminated;
      }
      if (a.lightRadius > lightRadius) lightRadius = a.lightRadius;
      if (a.loudnessMultiplier < 0.5) suppressed = true;
    }
  }

  // Magazine: capacity, reload speed and a handling penalty for big mags.
  const magStack = stack.magazine;
  const magDef = magStack ? ItemDB.get(magStack.defId).magazine : ItemDB.get(base.defaultMagazine).magazine;
  const magCapacity = magDef?.capacity ?? 10;
  const magReloadMul = magDef?.reloadModifier ?? 1;
  ergoDelta -= magDef?.ergonomicsPenalty ?? 0;

  // Wear: a neglected weapon loses accuracy and starts to malfunction. The
  // curve is flat until roughly 60% so light use never feels punishing.
  const durability = stack.durability ?? 100;
  const wear = clamp(1 - durability / 100, 0, 1);
  const wearAccuracy = 1 + Math.max(0, wear - 0.4) * 1.8;
  const ammoMalfunction = 1;
  const jamChance = Math.max(0, wear - 0.35) ** 2 * 0.09 * ammoMalfunction;

  // Handling: base ergonomics plus attachment deltas plus gear penalty, then
  // reduced by the handling skill. Better parts can offset heavy armour.
  const handlingScale = 1 - ctx.handlingSkill * 0.28;
  const adsTime = Math.max(0.08, (base.ergonomics - ergoDelta + ctx.gearErgoPenalty) * handlingScale);

  const recoilScale = recoilMul * (1 - ctx.recoilSkill * 0.22);

  return {
    def,
    base,
    caliber: base.caliber,
    fireModes: base.fireModes,
    rpm: base.rpm,
    burstCount: base.burstCount,
    recoilVertical: base.recoilVertical * recoilScale * recoilMulV / Math.max(0.01, recoilMul),
    recoilHorizontal: base.recoilHorizontal * recoilScale * recoilMulH / Math.max(0.01, recoilMul),
    // Better parts also settle the weapon faster, not just kick it less.
    recoilRecovery: base.recoilRecovery * (1 + (1 - recoilMul) * 0.6) * (1 + ctx.recoilSkill * 0.25),
    accuracyMoa: base.accuracyMoa * accuracyMul * wearAccuracy,
    adsTime,
    swapTime: adsTime * 1.6,
    reloadTactical: base.reloadTactical * magReloadMul * handlingScale,
    reloadEmpty: base.reloadEmpty * magReloadMul * handlingScale,
    magCapacity,
    tubeFed: TUBE_MAGAZINES.has(magStack?.defId ?? base.defaultMagazine),
    loudness: base.loudness * loudnessMul,
    suppressed,
    zoom,
    illuminatedReticle: illuminated,
    lightRadius,
    velocityBonus,
    durability,
    jamChance,
  };
}

/** Rounds currently available to fire: chambered round plus magazine. */
export function totalRounds(stack: ItemStack): number {
  const inMag = stack.magazine?.rounds?.length ?? 0;
  return inMag + (stack.chamber ? 1 : 0);
}

export function roundsInMagazine(stack: ItemStack): number {
  return stack.magazine?.rounds?.length ?? 0;
}

/** The cartridge that will be fired next, without consuming it. */
export function peekNextRound(stack: ItemStack): string | null {
  if (stack.chamber) return stack.chamber;
  const rounds = stack.magazine?.rounds;
  if (!rounds || rounds.length === 0) return null;
  return rounds[rounds.length - 1];
}

/**
 * Consume one round: fire the chambered cartridge and cycle the next one out
 * of the magazine. Returns the fired cartridge, or null on an empty chamber.
 */
export function cycleRound(stack: ItemStack): string | null {
  const fired = stack.chamber ?? null;
  if (!fired) return null;
  const rounds = stack.magazine?.rounds;
  stack.chamber = rounds && rounds.length > 0 ? rounds.pop()! : null;
  return fired;
}

/** Chamber a round from the magazine if the chamber is empty. */
export function chamberFromMagazine(stack: ItemStack): boolean {
  if (stack.chamber) return true;
  const rounds = stack.magazine?.rounds;
  if (!rounds || rounds.length === 0) return false;
  stack.chamber = rounds.pop()!;
  return true;
}

/** Fill a magazine stack with a cartridge type up to its capacity. */
export function loadMagazine(magStack: ItemStack, ammoDefId: string, count: number): number {
  const magDef = ItemDB.get(magStack.defId).magazine;
  if (!magDef) return 0;
  const ammoDef = ItemDB.tryGet(ammoDefId);
  if (!ammoDef?.ammo || ammoDef.ammo.caliber !== magDef.caliber) return 0;
  if (!magStack.rounds) magStack.rounds = [];
  const room = magDef.capacity - magStack.rounds.length;
  const loaded = Math.min(room, count);
  for (let i = 0; i < loaded; i++) magStack.rounds.push(ammoDefId);
  return loaded;
}

/** Remove every round from a magazine, grouped by cartridge type. */
export function unloadMagazine(magStack: ItemStack): Map<string, number> {
  const out = new Map<string, number>();
  if (!magStack.rounds) return out;
  for (const r of magStack.rounds) out.set(r, (out.get(r) ?? 0) + 1);
  magStack.rounds.length = 0;
  return out;
}

/** Does this attachment fit this weapon? */
export function canAttach(weapon: ItemStack, attachment: ItemStack): boolean {
  const wDef = defOf(weapon).weapon;
  const aDef = defOf(attachment).attachment;
  if (!wDef || !aDef) return false;
  if (!wDef.slots.includes(aDef.slot)) return false;
  if (aDef.fits.length > 0 && !aDef.fits.includes(weapon.defId)) return false;
  return true;
}

/** Fit an attachment, returning whatever was displaced from that slot. */
export function attach(weapon: ItemStack, attachment: ItemStack): ItemStack | null {
  const aDef = defOf(attachment).attachment;
  if (!aDef || !canAttach(weapon, attachment)) return null;
  if (!weapon.attachments) weapon.attachments = {};
  const previous = weapon.attachments[aDef.slot] ?? null;
  weapon.attachments[aDef.slot] = attachment;
  return previous;
}

export function detach(weapon: ItemStack, slot: AttachmentSlot): ItemStack | null {
  if (!weapon.attachments) return null;
  const removed = weapon.attachments[slot] ?? null;
  delete weapon.attachments[slot];
  return removed;
}

/** Human-readable fire mode label for the HUD. */
export const FIRE_MODE_LABEL: Record<FireMode, string> = {
  single: 'EINZEL',
  burst: 'STOSS',
  auto: 'DAUER',
};
