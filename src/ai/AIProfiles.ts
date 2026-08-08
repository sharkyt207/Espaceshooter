/**
 * AIProfiles - difficulty tiers and the loadouts that go with them.
 *
 * Difficulty is expressed as *human* limitations rather than stat inflation:
 * how long someone takes to notice you, how quickly they shoulder a weapon,
 * how well they shoot under stress, how disciplined their trigger control is,
 * and how willing they are to leave cover. An expert enemy is dangerous because
 * they react fast and move well, not because their bullets hurt more - the
 * ballistics layer is identical for every combatant.
 *
 * The tiers also read differently in a fight, which is what makes contact
 * informative: a scavenger sprays and panics, a contractor bounds between
 * cover and suppresses while a partner flanks.
 */

export type AITier = 'scavenger' | 'guard' | 'contractor' | 'commander';

export interface AIProfile {
  tier: AITier;
  name: string;
  /** Names drawn at spawn so kill feed entries read as people. */
  namePool: string[];

  // --- perception ---------------------------------------------------------
  /** Half-angle of the vision cone, radians. */
  fovHalfAngle: number;
  /** Maximum spotting distance in tiles under good light. */
  sightRange: number;
  /** Seconds of continuous exposure needed to fully acquire a target. */
  acquireTime: number;
  /** Multiplier on how far sounds are noticed. */
  hearingFactor: number;
  /** Seconds between AI decision ticks. Slower = more exploitable. */
  thinkInterval: number;

  // --- reaction -----------------------------------------------------------
  /** Seconds between acquiring a target and the first shot. */
  reactionTime: number;
  /** Standard deviation of aim error in radians at 20 tiles. */
  aimError: number;
  /** How fast the aim converges on the target, radians/sec. */
  aimSpeed: number;
  /** Seconds of fire before pausing - trigger discipline. */
  burstDuration: number;
  /** Seconds of pause between bursts. */
  burstPause: number;

  // --- behaviour ----------------------------------------------------------
  /** 0..1 preference for pushing rather than holding. */
  aggression: number;
  /** 0..1 tendency to use cover rather than stand in the open. */
  coverDiscipline: number;
  /** 0..1 chance to attempt a flank when a squadmate is engaged. */
  flankTendency: number;
  /** Health fraction below which the AI disengages. */
  fleeThreshold: number;
  /** 0..1 resistance to suppression. */
  nerve: number;
  /** Movement speed in tiles/sec. */
  moveSpeed: number;
  /** Sprint multiplier. */
  sprintMultiplier: number;

  // --- loadout ------------------------------------------------------------
  /** Weapon ids, picked at random. */
  weapons: string[];
  /** Armour ids; null entries mean "no armour" and are weighted like the rest. */
  armor: (string | null)[];
  helmets: (string | null)[];
  rigs: string[];
  /** Extra loot dropped on death beyond their gear. */
  pocketLoot: { defId: string; chance: number; min: number; max: number }[];
  /** Experience awarded for a kill. */
  xpReward: number;
}

const SCAVENGER_NAMES = [
  'Streuner Kolb', 'Streuner Vetter', 'Streuner Radek', 'Streuner Mielke',
  'Streuner Fuchs', 'Streuner Pfeil', 'Streuner Brandt', 'Streuner Osk',
];
const GUARD_NAMES = [
  'Wachmann Deist', 'Wachmann Kloss', 'Wachmann Roth', 'Wachmann Ehlert',
  'Wachmann Sander', 'Wachmann Prill',
];
const CONTRACTOR_NAMES = [
  'Söldner Verhoeven', 'Söldner Ilic', 'Söldner Marek', 'Söldner Dahl',
  'Söldner Kestner', 'Söldner Nowak', 'Söldner Brühl',
];

export const AI_PROFILES: Record<AITier, AIProfile> = {
  scavenger: {
    tier: 'scavenger',
    name: 'Streuner',
    namePool: SCAVENGER_NAMES,
    fovHalfAngle: 0.95,
    sightRange: 22,
    acquireTime: 0.85,
    hearingFactor: 0.85,
    thinkInterval: 0.32,
    reactionTime: 0.62,
    aimError: 0.055,
    aimSpeed: 2.6,
    burstDuration: 0.55,
    burstPause: 0.85,
    aggression: 0.45,
    coverDiscipline: 0.35,
    flankTendency: 0.1,
    fleeThreshold: 0.35,
    nerve: 0.3,
    moveSpeed: 1.75,
    sprintMultiplier: 1.5,
    weapons: ['wp_pw9', 'wp_fs12', 'wp_sg545', 'wp_sk762', 'wp_mpn9'],
    armor: [null, null, 'arm_vest_soft'],
    helmets: [null, null, null, 'hlm_cap'],
    rigs: ['rig_light', 'rig_light', 'rig_chest'],
    pocketLoot: [
      { defId: 'val_cash', chance: 0.5, min: 1, max: 2 },
      { defId: 'med_bandage', chance: 0.45, min: 1, max: 2 },
      { defId: 'mat_scrap', chance: 0.35, min: 1, max: 3 },
      { defId: 'food_bar', chance: 0.3, min: 1, max: 1 },
    ],
    xpReward: 120,
  },

  guard: {
    tier: 'guard',
    name: 'Wachmann',
    namePool: GUARD_NAMES,
    fovHalfAngle: 1.05,
    sightRange: 28,
    acquireTime: 0.6,
    hearingFactor: 1.0,
    thinkInterval: 0.26,
    reactionTime: 0.42,
    aimError: 0.032,
    aimSpeed: 3.6,
    burstDuration: 0.45,
    burstPause: 0.6,
    aggression: 0.55,
    coverDiscipline: 0.62,
    flankTendency: 0.28,
    fleeThreshold: 0.22,
    nerve: 0.55,
    moveSpeed: 1.95,
    sprintMultiplier: 1.65,
    weapons: ['wp_sg545', 'wp_ar556', 'wp_sk762', 'wp_ks45', 'wp_sa12'],
    armor: ['arm_vest_soft', 'arm_plate_steel', null],
    helmets: ['hlm_cap', 'hlm_std', null],
    rigs: ['rig_chest', 'rig_chest', 'rig_light'],
    pocketLoot: [
      { defId: 'val_cash', chance: 0.6, min: 1, max: 3 },
      { defId: 'med_ifak', chance: 0.35, min: 1, max: 1 },
      { defId: 'med_tourniquet', chance: 0.3, min: 1, max: 1 },
      { defId: 'key_office', chance: 0.06, min: 1, max: 1 },
    ],
    xpReward: 260,
  },

  contractor: {
    tier: 'contractor',
    name: 'Söldner',
    namePool: CONTRACTOR_NAMES,
    fovHalfAngle: 1.15,
    sightRange: 34,
    acquireTime: 0.38,
    hearingFactor: 1.15,
    thinkInterval: 0.2,
    reactionTime: 0.26,
    aimError: 0.018,
    aimSpeed: 5.0,
    burstDuration: 0.35,
    burstPause: 0.42,
    aggression: 0.72,
    coverDiscipline: 0.82,
    flankTendency: 0.55,
    fleeThreshold: 0.12,
    nerve: 0.8,
    moveSpeed: 2.15,
    sprintMultiplier: 1.8,
    weapons: ['wp_ar556', 'wp_sk762', 'wp_dm762', 'wp_vs939', 'wp_br762'],
    armor: ['arm_plate_steel', 'arm_plate_ceramic', 'rig_armored'],
    helmets: ['hlm_std', 'hlm_std', 'hlm_heavy'],
    rigs: ['rig_chest', 'rig_armored'],
    pocketLoot: [
      { defId: 'val_cash', chance: 0.7, min: 2, max: 5 },
      { defId: 'med_trauma', chance: 0.3, min: 1, max: 1 },
      { defId: 'med_stim_combat', chance: 0.22, min: 1, max: 1 },
      { defId: 'val_chain', chance: 0.12, min: 1, max: 1 },
      { defId: 'key_depot', chance: 0.05, min: 1, max: 1 },
    ],
    xpReward: 620,
  },

  commander: {
    tier: 'commander',
    name: 'Kommandant Vasska',
    namePool: ['Kommandant Vasska'],
    fovHalfAngle: 1.3,
    sightRange: 40,
    acquireTime: 0.28,
    hearingFactor: 1.35,
    thinkInterval: 0.16,
    reactionTime: 0.2,
    aimError: 0.013,
    aimSpeed: 6.2,
    burstDuration: 0.5,
    burstPause: 0.32,
    aggression: 0.88,
    coverDiscipline: 0.7,
    flankTendency: 0.4,
    fleeThreshold: 0,
    nerve: 1,
    moveSpeed: 2.25,
    sprintMultiplier: 1.9,
    weapons: ['wp_br762', 'wp_lm556'],
    armor: ['arm_plate_composite'],
    helmets: ['hlm_heavy'],
    rigs: ['rig_armored'],
    pocketLoot: [
      { defId: 'val_datacore', chance: 0.55, min: 1, max: 1 },
      { defId: 'val_watch', chance: 0.6, min: 1, max: 1 },
      { defId: 'val_cash', chance: 1, min: 6, max: 12 },
      { defId: 'key_depot', chance: 0.75, min: 1, max: 1 },
      { defId: 'med_surgery', chance: 0.4, min: 1, max: 1 },
    ],
    xpReward: 3200,
  },
};

/**
 * Which tiers populate a zone, by danger level.
 * Guards hold the middle ground; contractors concentrate where the loot is.
 */
export function tierWeightsForDanger(danger: number): { tier: AITier; weight: number }[] {
  return [
    { tier: 'scavenger', weight: Math.max(0.5, 10 - danger * 9) },
    { tier: 'guard', weight: 3 + danger * 4 },
    { tier: 'contractor', weight: Math.max(0, danger * 7 - 1.2) },
  ];
}
