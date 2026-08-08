/**
 * ItemTypes - the shared vocabulary for everything that can exist in an
 * inventory, a container, a corpse or a trader's stock.
 *
 * Design rule: item *definitions* are immutable data (one per archetype),
 * item *stacks* are the mutable instances the player carries. Anything that
 * changes during play - durability, loaded rounds, fitted attachments - lives
 * on the stack. This keeps saves small and makes balancing a data-only edit.
 *
 * Unity port note: every `ItemDef` maps directly onto a ScriptableObject.
 */

export type ItemCategory =
  | 'weapon'
  | 'ammo'
  | 'magazine'
  | 'attachment'
  | 'armor'
  | 'helmet'
  | 'rig'
  | 'backpack'
  | 'secure'
  | 'med'
  | 'food'
  | 'drink'
  | 'tool'
  | 'valuable'
  | 'material'
  | 'key'
  | 'quest';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

/** Ordered so comparisons and colour ramps can index it. */
export const RARITY_ORDER: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/**
 * Item tier colour, as a CSS custom property reference.
 *
 * A reference rather than a literal because the tiers have to belong to
 * whichever style is active: five fixed colours that look right against a cool
 * grey interface look like a mistake against a warm monochrome one. Each style
 * declares its own five, and every one of them keeps the tiers countable at a
 * glance - that is information, not decoration, and it is not the style's to
 * throw away.
 *
 * Canvas code cannot use these directly; it goes through `cssVar`.
 */
export const RARITY_COLOR: Record<Rarity, string> = {
  common: 'var(--rarity-common)',
  uncommon: 'var(--rarity-uncommon)',
  rare: 'var(--rarity-rare)',
  epic: 'var(--rarity-epic)',
  legendary: 'var(--rarity-legendary)',
};

export const RARITY_LABEL: Record<Rarity, string> = {
  common: 'Gewöhnlich',
  uncommon: 'Ungewöhnlich',
  rare: 'Selten',
  epic: 'Episch',
  legendary: 'Legendär',
};

/** Where a piece of gear can be equipped. */
export type EquipSlot =
  | 'primary'
  | 'secondary'
  | 'sidearm'
  | 'armor'
  | 'helmet'
  | 'rig'
  | 'backpack'
  | 'secure';

/** Attachment mounting points on a weapon. */
export type AttachmentSlot = 'muzzle' | 'optic' | 'foregrip' | 'stock' | 'magazine' | 'tactical';

export type FireMode = 'single' | 'burst' | 'auto';

/** Body parts, matching the health model. */
export type BodyPart = 'head' | 'thorax' | 'stomach' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

export const BODY_PARTS: readonly BodyPart[] = [
  'head', 'thorax', 'stomach', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg',
];

export const BODY_PART_LABEL: Record<BodyPart, string> = {
  head: 'Kopf',
  thorax: 'Brust',
  stomach: 'Bauch',
  leftArm: 'Linker Arm',
  rightArm: 'Rechter Arm',
  leftLeg: 'Linkes Bein',
  rightLeg: 'Rechtes Bein',
};

// ---------------------------------------------------------------------------
// Category-specific payloads
// ---------------------------------------------------------------------------

export interface AmmoStats {
  /** Cartridge designation - weapons accept ammo by matching caliber. */
  caliber: string;
  /** Base damage to unprotected flesh, per projectile. */
  damage: number;
  /**
   * Penetration power on a 0-70 scale. Compared against armour class * 10 to
   * decide whether a round defeats a plate. This is the single most important
   * ammo stat: a cheap rifle with good ammo beats an expensive one with bad.
   */
  penetration: number;
  /** Durability removed from armour per impact, as a percentage. */
  armorDamage: number;
  /** Chance a penetrating round fragments, multiplying flesh damage. */
  fragmentation: number;
  /** m/s at the muzzle - drives time of flight and drop. */
  muzzleVelocity: number;
  /** Ballistic coefficient; higher retains velocity better. */
  ballisticCoefficient: number;
  /** Projectiles per shot (buckshot > 1). */
  projectiles: number;
  /** Extra spread in MOA applied per projectile (shot cups, poor QC). */
  spreadMoa: number;
  /** Multiplier on weapon recoil. */
  recoilModifier: number;
  /** Multiplier on weapon accuracy (lower is better). */
  accuracyModifier: number;
  /** Fraction of rounds that are tracers. */
  tracerFraction: number;
  /** Chance per shot of inducing a malfunction on a worn weapon. */
  malfunctionModifier: number;
}

export interface WeaponStats {
  caliber: string;
  /** Fire modes the weapon supports, in cycle order. */
  fireModes: FireMode[];
  /** Rounds per minute in automatic fire. */
  rpm: number;
  /** Rounds fired per burst when in burst mode. */
  burstCount: number;
  /** Vertical recoil impulse per shot, in degrees. */
  recoilVertical: number;
  /** Horizontal recoil impulse per shot, in degrees (sign randomised). */
  recoilHorizontal: number;
  /** How fast the muzzle returns to point of aim, degrees/sec. */
  recoilRecovery: number;
  /** Inherent mechanical dispersion, in MOA. */
  accuracyMoa: number;
  /** Handling: seconds to raise the weapon / swap to it. */
  ergonomics: number;
  /** Seconds for a magazine change with rounds remaining (tactical). */
  reloadTactical: number;
  /** Seconds for a reload from empty (bolt must be released). */
  reloadEmpty: number;
  /** Default magazine definition id. */
  defaultMagazine: string;
  /** Attachment slots this weapon exposes. */
  slots: AttachmentSlot[];
  /** Sight radius bonus - longer barrels are steadier but slower to swing. */
  barrelLength: number;
  /** Loudness in world units; suppressors cut this hard. */
  loudness: number;
  /** Sighted (ADS) FOV multiplier when no optic is fitted. */
  ironSightZoom: number;
  /** Handling family, which selects the recoil pattern. */
  weaponClass: string;
}

export interface MagazineStats {
  caliber: string;
  capacity: number;
  /** Multiplier on reload time - drum mags are slow, quick-mags are fast. */
  reloadModifier: number;
  /** Ergonomics penalty while fitted. */
  ergonomicsPenalty: number;
}

export interface AttachmentStats {
  slot: AttachmentSlot;
  /** Which weapon ids accept this. Empty = any weapon with the slot. */
  fits: string[];
  /** Additive modifiers, applied multiplicatively where they are ratios. */
  recoilMultiplier: number;
  /**
   * How the recoil benefit splits between the axes.
   *
   * -1 is entirely vertical, +1 entirely horizontal, 0 even. See the note in
   * `AttachmentData` for why this is not just another percentage.
   */
  recoilAxis: number;
  accuracyMultiplier: number;
  ergonomicsDelta: number;
  /** Suppressors reduce loudness and muzzle flash. */
  loudnessMultiplier: number;
  /** Sighted magnification. 1 = no magnification. */
  zoom: number;
  /** Optics with an illuminated reticle work in the dark. */
  illuminated: boolean;
  /** Weapon-mounted light: radius in tiles, 0 = none. */
  lightRadius: number;
  /** Adds muzzle velocity (longer barrels, boosters). */
  velocityDelta: number;
}

export interface ArmorStats {
  /** Protection class 1-6. Compared against ammo penetration. */
  armorClass: number;
  /** Total durability points. */
  maxDurability: number;
  /**
   * Material toughness: how much durability a hit costs. Ceramic stops more
   * but degrades fast; steel is heavy but lasts.
   */
  materialFactor: number;
  /** Body parts this piece covers. */
  covers: BodyPart[];
  /** Movement speed multiplier while worn. */
  speedPenalty: number;
  /** Turn-rate multiplier. */
  turnPenalty: number;
  /** Ergonomics penalty applied to weapon handling. */
  ergonomicsPenalty: number;
  /** Sound perception multiplier - a closed helmet costs you your ears. */
  hearingPenalty: number;
  /** Blocks facial hits; visors can shatter. */
  blocksFace?: boolean;
}

export interface ContainerStats {
  /** Grid width and height in cells. */
  gridWidth: number;
  gridHeight: number;
  /**
   * Secure containers survive death. This is the risk/reward release valve:
   * small enough that you still lose the raid, big enough that you never lose
   * everything.
   */
  secure: boolean;
  /** Only items of these categories may be placed inside. */
  allowedCategories?: ItemCategory[];
}

export type MedEffect =
  | { kind: 'heal'; amount: number; perPart: boolean }
  | { kind: 'stopBleed'; heavy: boolean }
  | { kind: 'fixFracture' }
  | { kind: 'painkiller'; durationSec: number }
  | { kind: 'stimulant'; staminaRegen: number; durationSec: number }
  | { kind: 'energy'; amount: number }
  | { kind: 'hydration'; amount: number }
  | { kind: 'surgery'; restoreFraction: number };

export interface MedStats {
  /** Seconds of continuous use. Interrupted use is wasted. */
  useTimeSec: number;
  /** Charges consumed per use; item is destroyed at 0. */
  maxCharges: number;
  effects: MedEffect[];
  /** Some stims cost you something - realism over pure upside. */
  sideEffects?: MedEffect[];
}

export interface KeyStats {
  /** Number of uses before the key breaks; -1 = unlimited. */
  uses: number;
  /** Extract or door ids this key opens. */
  opens: string[];
}

// ---------------------------------------------------------------------------
// Item definition
// ---------------------------------------------------------------------------

export interface ItemDef {
  id: string;
  name: string;
  /** Compact label for the HUD and grid cells. */
  shortName: string;
  category: ItemCategory;
  rarity: Rarity;
  /** Footprint in inventory cells. */
  width: number;
  height: number;
  /** Kilograms. Drives the weight/stamina system. */
  weight: number;
  /** Reference trader price in the game's currency. */
  basePrice: number;
  stackable: boolean;
  maxStack: number;
  /** Items with durability show a condition bar and lose value when worn. */
  hasDurability: boolean;
  description: string;
  /** UI accent, independent of rarity - helps recognise items at a glance. */
  color: string;

  ammo?: AmmoStats;
  weapon?: WeaponStats;
  magazine?: MagazineStats;
  attachment?: AttachmentStats;
  armor?: ArmorStats;
  container?: ContainerStats;
  med?: MedStats;
  key?: KeyStats;
  /** Crafting inputs reference these tags rather than exact ids. */
  tags?: string[];
}

/** Convenience factory that fills the boilerplate defaults. */
export function defineItem(partial: Partial<ItemDef> & Pick<ItemDef, 'id' | 'name' | 'category'>): ItemDef {
  return {
    shortName: partial.name.slice(0, 12),
    rarity: 'common',
    width: 1,
    height: 1,
    weight: 0.2,
    basePrice: 100,
    stackable: false,
    maxStack: 1,
    hasDurability: false,
    description: '',
    color: '#8d9299',
    ...partial,
  } as ItemDef;
}
