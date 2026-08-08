import { primeIdCounters, snapshotIdCounters } from '../core/Ids';
import { ItemDB } from '../data/ItemDatabase';
import { GridContainer } from '../inventory/GridContainer';
import type { GridSlotState, ItemStack } from '../inventory/ItemStack';
import type { EquipSlot } from '../data/ItemTypes';
import type { Profile } from '../meta/Profile';
import { DEFAULT_STYLE, type StyleId } from '../render/Style';
import { defaultTouchConfig, type TouchConfig } from '../input/TouchConfig';

/**
 * SaveSystem - versioned persistence to localStorage.
 *
 * Three rules keep saves from becoming a liability:
 *
 *   1. **Versioned with migrations.** Every save records the schema version it
 *      was written with. Loading an older save runs it forward through the
 *      migration chain instead of being discarded.
 *   2. **Unknown ids are dropped, not fatal.** If a balance pass removes an
 *      item, saves referencing it load fine minus that item. A content change
 *      must never brick a player's profile.
 *   3. **Id counters are restored.** Item instance ids are integers; without
 *      priming the counters after a load, new items would collide with saved
 *      ones and inventory operations would silently target the wrong stack.
 *
 * Writes are debounced because localStorage is synchronous and a write in the
 * middle of a frame is a visible hitch on mobile.
 */

const STORAGE_KEY = 'grayzone.profile.v1';
const SETTINGS_KEY = 'grayzone.settings.v1';
export const SAVE_VERSION = 1;

export interface SaveEnvelope {
  version: number;
  savedAt: number;
  ids: { actor: number; item: number; container: number };
  profile: Record<string, unknown>;
}

export interface GameSettings {
  masterVolume: number;
  muted: boolean;
  lookSensitivity: number;
  invertY: boolean;
  /** 0 = auto (performance governor), otherwise a fixed render scale. */
  renderScale: number;
  showFps: boolean;
  /** Hold to aim, or tap to toggle. */
  toggleAds: boolean;
  /** Vibration feedback. Android only - iOS has never shipped the API. */
  haptics: boolean;
  /** The first-run primer has been read once. */
  primerSeen: boolean;
  /** 0 = off, 1 = tone mapping, 2 = bloom and tone mapping. -1 = by device. */
  postQuality: number;
  /**
   * Which renderer draws the raid.
   *
   * -1 picks the GPU where WebGL2 works and falls back silently otherwise,
   * which is what almost everyone should be on. 1 and 0 force the GPU and
   * software paths respectively - kept as an escape hatch because a driver
   * that reports WebGL2 and then renders garbage is a real thing on cheap
   * Android hardware, and a player who hits that needs a way out that does not
   * involve reinstalling.
   *
   * Takes effect at the next raid: swapping canvases mid-frame is not worth
   * the failure modes.
   */
  renderer: number;
  /** Which visual direction the game is played in. See `render/Style.ts`. */
  style: StyleId;
  /**
   * Touch layout and aim tuning. See `input/TouchConfig.ts`.
   *
   * Stored whole rather than flattened into a dozen sibling fields, because it
   * is edited as a unit, shipped as presets, and will grow - and because a
   * partial object merged over the defaults degrades gracefully when a build
   * adds a knob that an existing save has never heard of.
   */
  touch: TouchConfig;
}

export function defaultSettings(): GameSettings {
  return {
    masterVolume: 0.8,
    muted: false,
    lookSensitivity: 1,
    invertY: false,
    renderScale: 0,
    showFps: false,
    toggleAds: true,
    haptics: true,
    primerSeen: false,
    postQuality: -1,
    renderer: -1,
    style: DEFAULT_STYLE,
    touch: defaultTouchConfig(),
  };
}

export class SaveSystem {
  private writeTimer: number | null = null;
  private pending: Profile | null = null;

  /** Is persistence available at all? Private browsing can refuse it. */
  readonly available: boolean;

  constructor() {
    this.available = this.testStorage();
  }

  private testStorage(): boolean {
    try {
      const probe = '__grayzone_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  hasSave(): boolean {
    if (!this.available) return false;
    return localStorage.getItem(STORAGE_KEY) !== null;
  }

  /** Queue a save. Multiple calls in the same second collapse into one write. */
  save(profile: Profile, immediate = false): void {
    if (!this.available) return;
    this.pending = profile;
    if (immediate) {
      this.flush();
      return;
    }
    if (this.writeTimer !== null) return;
    this.writeTimer = window.setTimeout(() => this.flush(), 900);
  }

  flush(): void {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const profile = this.pending;
    this.pending = null;
    if (!profile || !this.available) return;

    try {
      const envelope: SaveEnvelope = {
        version: SAVE_VERSION,
        savedAt: Date.now(),
        ids: snapshotIdCounters(),
        profile: profile.serialize(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    } catch (err) {
      // Quota exceeded is the realistic failure. Better to keep playing than
      // to crash - the player is told, and the next write may succeed.
      console.error('[SaveSystem] write failed:', err);
    }
  }

  /** Load into an existing profile. Returns false when there was nothing to load. */
  load(profile: Profile): boolean {
    if (!this.available) return false;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;

    let envelope: SaveEnvelope;
    try {
      envelope = JSON.parse(raw) as SaveEnvelope;
    } catch {
      console.error('[SaveSystem] corrupt save - starting fresh');
      return false;
    }

    const migrated = migrate(envelope);
    if (!migrated) return false;

    try {
      applyProfile(profile, migrated.profile);
      primeIdCounters(migrated.ids.actor, migrated.ids.item, migrated.ids.container);
      // Advance the metagame by however long the app was closed.
      const elapsed = Math.max(0, (Date.now() - (migrated.profile.lastTickMs as number ?? Date.now())) / 1000);
      profile.tick(elapsed);
      return true;
    } catch (err) {
      console.error('[SaveSystem] failed to apply save:', err);
      return false;
    }
  }

  clear(): void {
    if (!this.available) return;
    localStorage.removeItem(STORAGE_KEY);
  }

  loadSettings(): GameSettings {
    const fallback = defaultSettings();
    if (!this.available) return fallback;
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return fallback;
      const stored = JSON.parse(raw) as Partial<GameSettings>;
      const merged = { ...fallback, ...stored };
      // The touch config is nested, so a shallow spread would replace the
      // whole object with whatever an older build happened to write - losing
      // every knob added since. Merge it a level deeper, buttons included.
      merged.touch = {
        ...fallback.touch,
        ...(stored.touch ?? {}),
        buttons: { ...fallback.touch.buttons, ...(stored.touch?.buttons ?? {}) },
      };
      return merged;
    } catch {
      return fallback;
    }
  }

  saveSettings(settings: GameSettings): void {
    if (!this.available) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Settings are not worth surfacing an error for.
    }
  }
}

/**
 * Run a save envelope forward to the current schema version.
 * Each step transforms one version to the next; returns null when the save is
 * from a newer build than this one and cannot be understood.
 */
function migrate(envelope: SaveEnvelope): SaveEnvelope | null {
  if (typeof envelope.version !== 'number') return null;
  if (envelope.version > SAVE_VERSION) {
    console.warn('[SaveSystem] save is from a newer version - refusing to load');
    return null;
  }
  // No migrations yet. When the schema changes, add:
  //   if (envelope.version === 1) { ...transform...; envelope.version = 2; }
  return envelope;
}

/** Rehydrate a profile from a serialised snapshot. */
function applyProfile(profile: Profile, data: Record<string, unknown>): void {
  profile.name = (data.name as string) ?? profile.name;
  profile.money = (data.money as number) ?? profile.money;
  profile.raids = (data.raids as number) ?? 0;
  profile.survived = (data.survived as number) ?? 0;
  profile.kills = (data.kills as number) ?? 0;
  profile.deaths = (data.deaths as number) ?? 0;
  profile.bestHaul = (data.bestHaul as number) ?? 0;
  profile.totalEarned = (data.totalEarned as number) ?? 0;

  profile.progression.restore((data.progression as never) ?? {});
  profile.hideout.restore((data.hideout as never) ?? {});
  profile.traders.restore((data.traders as never) ?? {});
  profile.quests.restore((data.quests as never) ?? {});
  profile.crafting.restore((data.crafting as never) ?? []);
  profile.insurance.restore((data.insurance as never) ?? {});

  // Stash: rebuild at the size the hideout level dictates, then refill. Doing
  // it in this order means a Lager upgrade completed offline is respected.
  profile.applyStashSize();
  const stashData = data.stash as { width?: number; height?: number; slots?: GridSlotState[] } | undefined;
  const size = profile.hideout.stashSize;
  profile.stash = new GridContainer(size.width, size.height);
  for (const slot of stashData?.slots ?? []) {
    const stack = sanitiseStack(slot.stack);
    if (stack) profile.stash.add(stack);
  }

  // Loadout.
  const loadoutData = data.loadout as
    | { equipped?: Partial<Record<EquipSlot, ItemStack>>; pockets?: GridSlotState[] }
    | undefined;
  for (const slot of Object.keys(loadoutData?.equipped ?? {}) as EquipSlot[]) {
    const stack = sanitiseStack(loadoutData!.equipped![slot]);
    if (stack) profile.loadout.equip(slot, stack);
  }
  profile.loadout.pockets.clear();
  for (const slot of loadoutData?.pockets ?? []) {
    const stack = sanitiseStack(slot.stack);
    if (stack) profile.loadout.pockets.add(stack);
  }
  profile.loadout.markDirty();

  profile.quests.refreshAvailability(profile.progression.level);
}

/**
 * Validate a deserialised item, recursively.
 * Returns null when the definition no longer exists, which prunes the item and
 * everything nested inside it rather than failing the whole load.
 */
function sanitiseStack(stack: ItemStack | undefined): ItemStack | null {
  if (!stack || typeof stack.defId !== 'string') return null;
  const def = ItemDB.tryGet(stack.defId);
  if (!def) {
    console.warn(`[SaveSystem] dropping unknown item "${stack.defId}"`);
    return null;
  }

  stack.count = Math.max(1, Math.min(stack.count ?? 1, def.maxStack));

  if (stack.rounds) {
    stack.rounds = stack.rounds.filter((id) => ItemDB.has(id));
  }
  if (stack.chamber && !ItemDB.has(stack.chamber)) stack.chamber = null;
  if (stack.magazine) stack.magazine = sanitiseStack(stack.magazine);
  if (stack.attachments) {
    for (const key of Object.keys(stack.attachments)) {
      const slot = key as keyof NonNullable<ItemStack['attachments']>;
      const cleaned = sanitiseStack(stack.attachments[slot]);
      if (cleaned) stack.attachments[slot] = cleaned;
      else delete stack.attachments[slot];
    }
  }
  if (stack.contents) {
    const kept: GridSlotState[] = [];
    for (const slot of stack.contents) {
      const cleaned = sanitiseStack(slot.stack);
      if (cleaned) kept.push({ ...slot, stack: cleaned });
    }
    stack.contents = kept;
  }
  return stack;
}
