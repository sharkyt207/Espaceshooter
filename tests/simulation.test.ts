import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../src/core/Random';
import { SpatialHash } from '../src/core/SpatialHash';
import { Pool } from '../src/core/Pool';
import { angleDelta, clamp, damp, pointSegmentDistSq, wrapAngle } from '../src/core/Math2D';
import { EventBus } from '../src/core/EventBus';
import { Tile, TileMap } from '../src/world/TileMap';
import { hasLineOfSight, walkSegment } from '../src/world/Raycast';
import { circleFits, moveCircle } from '../src/world/Physics';
import { CoverMap, NavGrid } from '../src/world/NavGrid';
import { generateMap } from '../src/world/MapGenerator';
import { AXIS_UP, AXIS_WEST, buildWorldMesh, FLOATS_PER_VERTEX } from '../src/render/gl/WorldMesh';
import { DEFAULT_STYLE, STYLE_ORDER, STYLES, styleById } from '../src/render/Style';
import { filmicToneMap } from '../src/render/PostProcess';
import { COMPOSITE_FS } from '../src/render/gl/Shaders';
import { WeaponController } from '../src/weapons/WeaponController';
import { peekNextRound } from '../src/weapons/WeaponRuntime';
import {
  buildPattern, patternFor, stepAt, PATTERN_BY_CLASS,
} from '../src/weapons/RecoilPattern';
import { MAP_BLUEPRINTS } from '../src/data/MapData';
import { ItemDB } from '../src/data/ItemDatabase';
import { GridContainer } from '../src/inventory/GridContainer';
import { createStack, stackValue, stackWeight } from '../src/inventory/ItemStack';
import { Inventory } from '../src/inventory/Inventory';
import { HealthSystem } from '../src/health/HealthSystem';
import { Player } from '../src/player/Player';
import { spatialise, type ListenerState } from '../src/audio/Spatial';
import {
  chamberFromMagazine,
  cycleRound,
  loadMagazine,
  resolveWeapon,
  totalRounds,
} from '../src/weapons/WeaponRuntime';
import { LootSystem } from '../src/loot/LootSystem';
import { LOOT_TABLES } from '../src/loot/LootTables';
import { Progression } from '../src/meta/Progression';
import { Profile } from '../src/meta/Profile';
import { RaidSession } from '../src/raid/RaidSession';
import { Hideout } from '../src/meta/Hideout';
import { QuestSystem } from '../src/meta/Quests';
import { TraderSystem } from '../src/meta/Traders';
import {
  applyConditions,
  makeConditions,
  rollWeather,
  WEATHER_PROFILES,
} from '../src/world/Conditions';
import { AI_PROFILES } from '../src/ai/AIProfiles';
import { Enemy } from '../src/ai/Enemy';
import { BallisticsSystem } from '../src/combat/Ballistics';
import { EffectSystem } from '../src/render/Effects';
import { createAwareness, updateVision, type PerceptionInput } from '../src/ai/Perception';
import type { Combatant } from '../src/combat/Combatant';

/**
 * Simulation tests.
 *
 * These cover the parts of the game where a silent regression would be
 * expensive and hard to notice by playing: determinism, spatial correctness,
 * inventory bookkeeping and the damage/economy rules. Rendering, audio and UI
 * are verified by the browser smoke test instead - they need a DOM.
 */

const bus = new EventBus<Record<string, never>>() as never;

// ===========================================================================
// Core
// ===========================================================================

describe('Rng', () => {
  test('is deterministic for a given seed', () => {
    const a = new Rng('seed-1');
    const b = new Rng('seed-1');
    for (let i = 0; i < 200; i++) assert.equal(a.next(), b.next());
  });

  test('different seeds diverge', () => {
    const a = new Rng('seed-1');
    const b = new Rng('seed-2');
    let differences = 0;
    for (let i = 0; i < 50; i++) if (a.next() !== b.next()) differences++;
    assert.ok(differences > 40, 'streams should be independent');
  });

  test('float stays in [0,1) and int is inclusive', () => {
    const rng = new Rng(42);
    for (let i = 0; i < 5000; i++) {
      const f = rng.float();
      assert.ok(f >= 0 && f < 1);
      const n = rng.int(3, 5);
      assert.ok(n >= 3 && n <= 5);
    }
  });

  test('weighted picks respect zero weights', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 500; i++) {
      assert.equal(rng.weighted(['a', 'b'], [0, 1]), 'b');
    }
    assert.equal(rng.weighted(['a', 'b'], [0, 0]), undefined);
  });

  test('gaussianClamped never exceeds its sigma bound', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 2000; i++) {
      const v = rng.gaussianClamped(0, 1, 2);
      assert.ok(Math.abs(v) <= 2 + 1e-9);
    }
  });
});

describe('Math2D', () => {
  test('wrapAngle maps into (-PI, PI]', () => {
    for (let i = -20; i <= 20; i++) {
      const a = wrapAngle(i * 1.1);
      assert.ok(a > -Math.PI - 1e-9 && a <= Math.PI + 1e-9);
    }
  });

  test('angleDelta takes the short way round', () => {
    assert.ok(Math.abs(angleDelta(0.1, Math.PI * 2 - 0.1) + 0.2) < 1e-6);
  });

  test('damp is frame-rate independent', () => {
    // One 0.5 s step and fifty 0.01 s steps must land in the same place.
    const one = damp(0, 100, 4, 0.5);
    let many = 0;
    for (let i = 0; i < 50; i++) many = damp(many, 100, 4, 0.01);
    assert.ok(Math.abs(one - many) < 1e-6);
  });

  test('pointSegmentDistSq handles the endpoints and the middle', () => {
    assert.equal(pointSegmentDistSq(0, 0, 0, 0, 10, 0), 0);
    assert.equal(pointSegmentDistSq(5, 3, 0, 0, 10, 0), 9);
    // Beyond the end clamps to the endpoint rather than the infinite line.
    assert.equal(pointSegmentDistSq(20, 0, 0, 0, 10, 0), 100);
  });

  test('clamp bounds both ends', () => {
    assert.equal(clamp(-5, 0, 1), 0);
    assert.equal(clamp(5, 0, 1), 1);
  });
});

describe('SpatialHash', () => {
  test('finds only entities within the radius', () => {
    const hash = new SpatialHash(64, 64, 4, 128);
    hash.begin();
    hash.insert(1, 10, 10);
    hash.insert(2, 10.5, 10.5);
    hash.insert(3, 40, 40);
    hash.build();

    const out: number[] = [];
    hash.queryRadius(10, 10, 2, out);
    assert.deepEqual(out.sort(), [1, 2]);

    hash.queryRadius(40, 40, 1, out);
    assert.deepEqual(out, [3]);

    hash.queryRadius(0, 0, 1, out);
    assert.equal(out.length, 0);
  });

  test('handles entities on the far edge of the grid', () => {
    const hash = new SpatialHash(32, 32, 4, 16);
    hash.begin();
    hash.insert(9, 31.9, 31.9);
    hash.build();
    const out: number[] = [];
    hash.queryRadius(31, 31, 3, out);
    assert.deepEqual(out, [9]);
  });
});

describe('Pool', () => {
  test('acquires up to capacity and releases by swap', () => {
    const pool = new Pool(() => ({ v: 0 }), (o) => { o.v = -1; }, 3);
    const a = pool.acquire()!;
    const b = pool.acquire()!;
    pool.acquire();
    assert.equal(pool.active, 3);
    assert.equal(pool.acquire(), undefined);

    a.v = 1;
    b.v = 2;
    pool.releaseAt(0);
    assert.equal(pool.active, 2);
    pool.releaseAll();
    assert.equal(pool.active, 0);
  });
});

// ===========================================================================
// World
// ===========================================================================

describe('TileMap', () => {
  test('treats out of bounds as solid and opaque', () => {
    const map = new TileMap(8, 8);
    assert.equal(map.isSolid(-1, 0), true);
    assert.equal(map.isOpaque(99, 0), true);
    assert.equal(map.isSolid(4, 4), false);
  });

  test('material properties drive penetration and cover height', () => {
    const map = new TileMap(8, 8);
    map.set(2, 2, Tile.Concrete);
    map.set(3, 2, Tile.Wood);
    assert.ok(map.penetrationOf(2, 2) > map.penetrationOf(3, 2));
    assert.equal(map.heightOf(2, 2), 3);
  });

  test('nearestOpen escapes a solid tile', () => {
    const map = new TileMap(8, 8);
    map.fillRect(0, 0, 7, 7, Tile.Concrete);
    map.set(5, 5, Tile.Floor);
    const open = map.nearestOpen(4, 4, 4);
    assert.deepEqual(open, { x: 5, y: 5 });
  });
});

describe('Raycast', () => {
  test('line of sight is blocked by opaque tiles only', () => {
    const map = new TileMap(16, 16);
    assert.equal(hasLineOfSight(map, 1.5, 1.5, 14.5, 1.5), true);

    map.set(8, 1, Tile.Concrete);
    assert.equal(hasLineOfSight(map, 1.5, 1.5, 14.5, 1.5), false);

    // A fence blocks movement but not vision, which is the whole point of it.
    map.set(8, 1, Tile.Fence);
    assert.equal(hasLineOfSight(map, 1.5, 1.5, 14.5, 1.5), true);
  });

  test('walkSegment visits every tile crossed, in order', () => {
    const visited: string[] = [];
    walkSegment(0.5, 0.5, 4.5, 0.5, (x, y) => {
      visited.push(`${x},${y}`);
      return true;
    });
    assert.deepEqual(visited, ['0,0', '1,0', '2,0', '3,0', '4,0']);
  });

  test('walkSegment stops early when the visitor returns false', () => {
    let count = 0;
    walkSegment(0.5, 0.5, 20.5, 0.5, () => {
      count++;
      return count < 3;
    });
    assert.equal(count, 3);
  });
});

describe('Physics', () => {
  test('a circle cannot overlap a solid tile', () => {
    const map = new TileMap(8, 8);
    map.set(4, 4, Tile.Concrete);
    assert.equal(circleFits(map, 4.5, 4.5, 0.3), false);
    assert.equal(circleFits(map, 2.5, 2.5, 0.3), true);
    // Just outside the tile edge, by less than the radius.
    assert.equal(circleFits(map, 3.8, 4.5, 0.3), false);
  });

  test('movement slides along a wall instead of stopping dead', () => {
    const map = new TileMap(8, 8);
    for (let y = 0; y < 8; y++) map.set(4, y, Tile.Concrete);
    // Push diagonally into the wall: X is blocked, Y should still resolve.
    const result = moveCircle(map, 3.5, 3.5, 0.5, 0.5, 0.3);
    assert.ok(result.hitX, 'x should be blocked by the wall');
    assert.ok(result.y > 3.5, 'y component should still apply');
  });

  test('fast movement does not tunnel through a thin wall', () => {
    const map = new TileMap(32, 8);
    for (let y = 0; y < 8; y++) map.set(10, y, Tile.Concrete);
    const result = moveCircle(map, 2.5, 3.5, 20, 0, 0.3);
    assert.ok(result.x < 10, `expected to stop before the wall, got ${result.x}`);
  });
});

describe('NavGrid', () => {
  test('finds a route around an obstacle', () => {
    const map = new TileMap(24, 24);
    // A wall with a single gap: the path must go through the gap.
    for (let y = 0; y < 24; y++) map.set(12, y, Tile.Concrete);
    map.set(12, 20, Tile.Floor);

    const nav = new NavGrid(map);
    const path = nav.findPath(3.5, 3.5, 20.5, 3.5);
    assert.equal(path.found, true);
    assert.ok(path.points.length > 0);

    const last = path.points[path.points.length - 1];
    assert.ok(Math.abs(last.x - 20.5) < 1.5 && Math.abs(last.y - 3.5) < 1.5);
  });

  test('reports failure when the target is walled off', () => {
    const map = new TileMap(16, 16);
    map.strokeRect(8, 8, 11, 11, Tile.Concrete);
    const nav = new NavGrid(map);
    const path = nav.findPath(2.5, 2.5, 9.5, 9.5);
    assert.equal(path.found, false);
  });

  test('flow field points downhill toward the target', () => {
    const map = new TileMap(24, 24);
    const nav = new NavGrid(map);
    nav.buildFlowField(20.5, 20.5, true);

    const near = nav.flowCostAt(19, 19);
    const far = nav.flowCostAt(3, 3);
    assert.ok(far > near, 'cost must grow with distance from the target');

    const dir = { x: 0, y: 0 };
    assert.equal(nav.sampleFlow(3, 3, dir), true);
    assert.ok(dir.x > 0 || dir.y > 0, 'should point towards the target');
  });
});

describe('CoverMap', () => {
  test('marks the side a wall protects', () => {
    const map = new TileMap(16, 16);
    // Wall directly north of (5,5).
    map.set(5, 4, Tile.Concrete);
    const cover = new CoverMap(map);
    // Threat coming from the north (negative y).
    assert.equal(cover.coversFrom(5, 5, 0, -1), true);
    // Threat from the south is not covered by a wall to the north.
    assert.equal(cover.coversFrom(5, 5, 0, 1), false);
  });

  test('open ground scores zero', () => {
    const map = new TileMap(16, 16);
    const cover = new CoverMap(map);
    assert.equal(cover.scoreAt(8, 8), 0);
  });
});

describe('MapGenerator', () => {
  test('is deterministic for a seed', () => {
    const bp = MAP_BLUEPRINTS[0];
    const a = generateMap(bp, 12345);
    const b = generateMap(bp, 12345);
    assert.deepEqual(Array.from(a.map.tiles), Array.from(b.map.tiles));
    assert.equal(a.extracts.length, b.extracts.length);
    assert.equal(a.aiSpawns.length, b.aiSpawns.length);
  });

  test('produces a playable layout', () => {
    for (const bp of MAP_BLUEPRINTS) {
      const gen = generateMap(bp, 777);
      assert.ok(gen.playerSpawns.length > 0, `${bp.id}: needs a player spawn`);
      assert.ok(gen.extracts.length >= 2, `${bp.id}: needs multiple exits`);
      assert.ok(gen.lootAnchors.length > 5, `${bp.id}: needs loot`);
      assert.ok(gen.aiSpawns.length > 5, `${bp.id}: needs hostiles`);

      // At least one exit must be unconditional, or a raid could be unwinnable.
      const free = gen.extracts.filter((e) => !e.condition || e.condition.kind === 'always');
      assert.ok(free.length >= 1, `${bp.id}: needs an unconditional exit`);

      // Spawns must be on walkable ground.
      for (const spawn of gen.playerSpawns) {
        assert.equal(gen.map.isSolid(Math.floor(spawn.x), Math.floor(spawn.y)), false);
      }
    }
  });

  test('every extraction is reachable from the player spawn', () => {
    const gen = generateMap(MAP_BLUEPRINTS[0], 4242);
    const nav = new NavGrid(gen.map);
    const spawn = gen.playerSpawns[0];
    let reachable = 0;
    for (const extract of gen.extracts) {
      const path = nav.findPath(spawn.x, spawn.y, extract.x, extract.y, 20000);
      if (path.found) reachable++;
    }
    assert.equal(reachable, gen.extracts.length, 'all exits must be reachable');
  });
});

// ===========================================================================
// Items and inventory
// ===========================================================================

describe('ItemDatabase', () => {
  test('every referenced id resolves', () => {
    for (const def of ItemDB.all) {
      if (def.weapon) {
        assert.ok(ItemDB.has(def.weapon.defaultMagazine), `${def.id}: bad default magazine`);
        const mag = ItemDB.get(def.weapon.defaultMagazine);
        assert.equal(mag.magazine?.caliber, def.weapon.caliber, `${def.id}: magazine calibre mismatch`);
      }
    }
  });

  test('every weapon calibre has ammunition', () => {
    for (const def of ItemDB.ofCategory('weapon')) {
      const ammo = ItemDB.ofCategory('ammo').filter((a) => a.ammo?.caliber === def.weapon!.caliber);
      assert.ok(ammo.length > 0, `${def.id}: no ammunition for ${def.weapon!.caliber}`);
    }
  });

  test('stackable items declare a stack size and vice versa', () => {
    for (const def of ItemDB.all) {
      if (def.stackable) assert.ok(def.maxStack > 1, `${def.id}: stackable but maxStack ${def.maxStack}`);
      else assert.equal(def.maxStack, 1, `${def.id}: not stackable but maxStack ${def.maxStack}`);
    }
  });
});

describe('GridContainer', () => {
  test('rejects placements that do not fit', () => {
    const grid = new GridContainer(4, 2);
    const rifle = createStack('wp_sg545'); // 4x2
    assert.equal(grid.place(rifle, 0, 0), true);
    const second = createStack('wp_sg545');
    assert.equal(grid.place(second, 0, 0), false);
    assert.equal(grid.findSpot(second), null);
  });

  test('rotates an item when that is the only way it fits', () => {
    const grid = new GridContainer(2, 4);
    const rifle = createStack('wp_sg545'); // 4 wide, 2 tall
    const spot = grid.findSpot(rifle);
    assert.ok(spot, 'should find a rotated placement');
    assert.equal(spot!.rotated, true);
  });

  test('merges stackable items before taking a new cell', () => {
    const grid = new GridContainer(4, 4);
    grid.add(createStack('ammo_545_ps', 40));
    assert.equal(grid.slots.length, 1);
    grid.add(createStack('ammo_545_ps', 15));
    // 40 + 15 = 55, below the 60 cap, so it merges into the same slot.
    assert.equal(grid.slots.length, 1);
    assert.equal(grid.countOf('ammo_545_ps'), 55);
  });

  test('overflows into a second slot past the stack cap', () => {
    const grid = new GridContainer(4, 4);
    grid.add(createStack('ammo_545_ps', 60));
    grid.add(createStack('ammo_545_ps', 30));
    assert.equal(grid.countOf('ammo_545_ps'), 90);
    assert.equal(grid.slots.length, 2);
  });

  test('consume takes from existing stacks and cleans up empties', () => {
    const grid = new GridContainer(4, 4);
    grid.add(createStack('ammo_545_ps', 60));
    grid.add(createStack('ammo_545_ps', 20));
    assert.equal(grid.consume('ammo_545_ps', 70), 70);
    assert.equal(grid.countOf('ammo_545_ps'), 10);
    assert.equal(grid.consume('ammo_545_ps', 999), 10);
    assert.equal(grid.slots.length, 0);
  });

  test('slotAt maps every covered cell back to its item', () => {
    const grid = new GridContainer(6, 4);
    const rifle = createStack('wp_sg545');
    grid.place(rifle, 1, 1);
    assert.equal(grid.slotAt(1, 1)?.stack.id, rifle.id);
    assert.equal(grid.slotAt(4, 2)?.stack.id, rifle.id);
    assert.equal(grid.slotAt(5, 2), null);
  });
});

describe('ItemStack', () => {
  test('weight includes nested magazines and rounds', () => {
    const rifle = createStack('wp_sg545');
    const bare = stackWeight(rifle);
    const mag = createStack('mag_545_30');
    loadMagazine(mag, 'ammo_545_ps', 30);
    rifle.magazine = mag;
    assert.ok(stackWeight(rifle) > bare, 'a loaded magazine must add weight');
  });

  test('value falls with wear', () => {
    const pristine = createStack('wp_sg545');
    const worn = createStack('wp_sg545');
    worn.durability = 20;
    assert.ok(stackValue(worn) < stackValue(pristine));
  });

  test('secure containers report their contents in weight and value', () => {
    const box = createStack('sec_small');
    const emptyValue = stackValue(box);
    const grid = new GridContainer(2, 2);
    grid.add(createStack('val_chain'));
    box.contents = grid.slots;
    assert.ok(stackValue(box) > emptyValue);
  });
});

describe('Inventory', () => {
  test('an armoured rig and a plate carrier are mutually exclusive', () => {
    const inv = new Inventory();
    inv.equip('armor', createStack('arm_plate_steel'));
    assert.equal(inv.canEquip('rig', createStack('rig_armored')), false);
    assert.equal(inv.canEquip('rig', createStack('rig_chest')), true);
  });

  test('derived stats reflect worn gear', () => {
    const inv = new Inventory();
    const before = inv.stats.speedFactor;
    inv.equip('armor', createStack('arm_plate_composite'));
    assert.ok(inv.stats.speedFactor < before, 'heavy armour must slow you down');
    assert.ok(inv.stats.weight > 10, 'armour weight must be counted');
  });

  test('armorFor finds the piece covering a body part', () => {
    const inv = new Inventory();
    inv.equip('armor', createStack('arm_plate_steel')); // thorax only
    assert.ok(inv.armorFor('thorax'));
    assert.equal(inv.armorFor('leftLeg'), null);
    assert.equal(inv.armorFor('head'), null);
  });

  test('destroyed armour stops protecting', () => {
    const inv = new Inventory();
    const plate = createStack('arm_plate_steel');
    plate.durability = 0;
    inv.equip('armor', plate);
    assert.equal(inv.armorFor('thorax'), null);
  });

  test('death strips everything except the secure container', () => {
    const inv = new Inventory();
    inv.equip('primary', createStack('wp_sg545'));
    inv.equip('secure', createStack('sec_small'));
    inv.equip('backpack', createStack('bp_small'));
    const secureGrid = inv.gridFor('secure')!;
    secureGrid.add(createStack('val_chain'));

    const lost = inv.stripOnDeath();
    assert.ok(lost.length >= 2, 'gear outside the container is lost');
    assert.ok(inv.equipped.secure, 'the secure container survives');
    assert.equal(inv.gridFor('secure')!.countOf('val_chain'), 1);
  });
});

// ===========================================================================
// Weapons
// ===========================================================================

describe('WeaponRuntime', () => {
  test('feeding cycles the chamber from the magazine', () => {
    const rifle = createStack('wp_sg545');
    const mag = createStack('mag_545_30');
    loadMagazine(mag, 'ammo_545_ps', 3);
    rifle.magazine = mag;

    assert.equal(totalRounds(rifle), 3);
    assert.equal(chamberFromMagazine(rifle), true);
    assert.equal(totalRounds(rifle), 3, 'chambering moves a round, it does not consume it');

    assert.equal(cycleRound(rifle), 'ammo_545_ps');
    assert.equal(totalRounds(rifle), 2);
    cycleRound(rifle);
    cycleRound(rifle);
    assert.equal(totalRounds(rifle), 0);
    assert.equal(cycleRound(rifle), null, 'an empty weapon fires nothing');
  });

  test('magazines refuse the wrong calibre', () => {
    const mag = createStack('mag_545_30');
    assert.equal(loadMagazine(mag, 'ammo_9_fmj', 10), 0);
    assert.equal(loadMagazine(mag, 'ammo_545_ps', 10), 10);
  });

  test('magazines cannot be overfilled', () => {
    const mag = createStack('mag_545_30');
    assert.equal(loadMagazine(mag, 'ammo_545_ps', 100), 30);
    assert.equal(mag.rounds!.length, 30);
  });

  test('a suppressor trades loudness for handling', () => {
    const bare = createStack('wp_sg545');
    const suppressed = createStack('wp_sg545');
    suppressed.attachments = { muzzle: createStack('att_suppressor') };

    const a = resolveWeapon(bare);
    const b = resolveWeapon(suppressed);
    assert.ok(b.loudness < a.loudness * 0.4, 'a suppressor must be a big cut');
    assert.equal(b.suppressed, true);
    assert.ok(b.adsTime > a.adsTime, 'and it must cost handling');
  });

  test('wear degrades accuracy and introduces malfunctions', () => {
    const good = createStack('wp_sg545');
    good.durability = 100;
    const bad = createStack('wp_sg545');
    bad.durability = 15;

    const a = resolveWeapon(good);
    const b = resolveWeapon(bad);
    assert.ok(b.accuracyMoa > a.accuracyMoa);
    assert.equal(a.jamChance, 0, 'a serviced weapon should not jam');
    assert.ok(b.jamChance > 0, 'a neglected weapon should');
  });

  test('skills improve handling without changing the weapon', () => {
    const rifle = createStack('wp_sg545');
    const novice = resolveWeapon(rifle, { gearErgoPenalty: 0, handlingSkill: 0, recoilSkill: 0 });
    const expert = resolveWeapon(rifle, { gearErgoPenalty: 0, handlingSkill: 1, recoilSkill: 1 });
    assert.ok(expert.adsTime < novice.adsTime);
    assert.ok(expert.recoilVertical < novice.recoilVertical);
  });
});

// ===========================================================================
// Health
// ===========================================================================

describe('HealthSystem', () => {
  test('a destroyed head is fatal, a destroyed leg is not', () => {
    const head = new HealthSystem(bus, false);
    head.applyDamage('head', 999);
    assert.equal(head.dead, true);

    const leg = new HealthSystem(bus, false);
    leg.applyDamage('leftLeg', 999);
    assert.equal(leg.dead, false);
    assert.equal(leg.parts.leftLeg.blackedOut, true);
  });

  test('damage to a blacked-out limb carries into the thorax', () => {
    const h = new HealthSystem(bus, false);
    h.applyDamage('leftLeg', 999);
    const before = h.parts.thorax.hp;
    h.applyDamage('leftLeg', 40);
    assert.ok(h.parts.thorax.hp < before, 'a dead limb still transmits damage');
  });

  test('an untreated heavy bleed is lethal within about a minute', () => {
    const h = new HealthSystem(bus, false);
    h.applyDamage('leftArm', 5, { heavyBleedChance: 1, roll: () => 0 });
    assert.equal(h.hasHeavyBleed, true);

    let elapsed = 0;
    while (!h.dead && elapsed < 300) {
      h.update(1);
      elapsed++;
    }
    assert.equal(h.dead, true, 'a heavy bleed must eventually kill');
    assert.ok(elapsed > 20 && elapsed < 120, `expected 20-120 s, got ${elapsed}`);
  });

  test('a tourniquet stops a heavy bleed, a bandage does not', () => {
    const h = new HealthSystem(bus, false);
    h.applyDamage('leftArm', 5, { heavyBleedChance: 1, roll: () => 0 });
    assert.equal(h.stopBleed(false), false, 'a bandage cannot stop a heavy bleed');
    assert.equal(h.stopBleed(true), true);
    assert.equal(h.hasHeavyBleed, false);
  });

  test('fractures slow you down and painkillers mask it', () => {
    const h = new HealthSystem(bus, false);
    const healthy = h.modifiers.speed;
    h.applyDamage('leftLeg', 5, { fractureChance: 1, roll: () => 0 });
    const fractured = h.modifiers.speed;
    assert.ok(fractured < healthy, 'a fracture must cost speed');

    h.applyPainkiller(60);
    assert.ok(h.modifiers.speed > fractured, 'painkillers should mask the limp');
    assert.equal(h.hasFracture, true, 'but the bone is still broken');
  });

  test('healing never revives a destroyed limb, surgery does', () => {
    const h = new HealthSystem(bus, false);
    h.applyDamage('leftLeg', 999);
    assert.equal(h.heal(100, 'leftLeg'), 0);
    assert.equal(h.performSurgery(0.5), 'leftLeg');
    assert.equal(h.parts.leftLeg.blackedOut, false);
    assert.ok(h.parts.leftLeg.hp > 0);
  });

  test('running out of water eventually kills', () => {
    const h = new HealthSystem(bus, false);
    h.hydration = 0;
    h.energy = 50;
    for (let i = 0; i < 400; i++) h.update(1);
    assert.equal(h.dead, true);
  });

  test('triage healing treats the worst limb first', () => {
    const h = new HealthSystem(bus, false);
    h.applyDamage('leftArm', 40);
    h.applyDamage('rightLeg', 10);
    const armBefore = h.parts.leftArm.hp;
    h.heal(20);
    assert.ok(h.parts.leftArm.hp > armBefore, 'the worst injury is treated first');
  });
});

// ===========================================================================
// Loot and economy
// ===========================================================================

describe('LootSystem', () => {
  test('the same seed produces the same containers', () => {
    const gen = generateMap(MAP_BLUEPRINTS[2], 999);
    const a = new LootSystem(999);
    const b = new LootSystem(999);
    a.populate(gen.lootAnchors, gen.map);
    b.populate(gen.lootAnchors, gen.map);

    assert.equal(a.containers.length, b.containers.length);
    for (let i = 0; i < a.containers.length; i++) {
      const itemsA = a.containers[i].grid.items().map((s) => `${s.defId}:${s.count}`);
      const itemsB = b.containers[i].grid.items().map((s) => `${s.defId}:${s.count}`);
      assert.deepEqual(itemsA, itemsB);
    }
  });

  test('spawned weapons come with a magazine', () => {
    const loot = new LootSystem(31337);
    const rifle = ItemDB.get('wp_ar556');
    for (let i = 0; i < 20; i++) {
      const stack = loot.instantiate(rifle, 1, 0.6);
      assert.ok(stack.magazine, 'a found weapon should be a complete kit');
      assert.ok((stack.durability ?? 0) > 0 && (stack.durability ?? 0) <= 100);
    }
  });

  test('dangerous zones yield better loot on average', () => {
    const gen = generateMap(MAP_BLUEPRINTS[0], 2024);
    const safe = new LootSystem(1);
    const hot = new LootSystem(1);
    let safeValue = 0;
    let hotValue = 0;
    for (let i = 0; i < 120; i++) {
      const a = safe.createContainer(
        { ...LOOT_SAMPLE, id: 'supply_crate' }, 4, 4, 0.05,
      );
      const b = hot.createContainer({ ...LOOT_SAMPLE, id: 'supply_crate' }, 4, 4, 0.95);
      for (const s of a.grid.items()) safeValue += stackValue(s);
      for (const s of b.grid.items()) hotValue += stackValue(s);
    }
    assert.ok(hotValue > safeValue, `hot zones should pay more (${hotValue} vs ${safeValue})`);
    void gen;
  });
});

// A minimal table reused by the danger-weighting test above.
const LOOT_SAMPLE = {
  id: 'supply_crate',
  name: 'Testkiste',
  gridWidth: 4,
  gridHeight: 4,
  searchSeconds: 1,
  sprite: 'supply_crate',
  minRolls: 3,
  maxRolls: 3,
  emptyChance: 0,
  entries: [{ tag: 'valuable', weight: 1 }],
};

describe('Progression', () => {
  test('levels advance with experience', () => {
    const p = new Progression(bus);
    assert.equal(p.level, 1);
    p.addXp(50000, 'test');
    assert.ok(p.level > 3, `expected several levels, got ${p.level}`);
  });

  test('skills cap out and produce bounded effects', () => {
    const p = new Progression(bus);
    for (let i = 0; i < 400; i++) p.addSkillXp('strength', 500);
    assert.equal(p.skills.strength.level, 20);
    assert.equal(p.factor('strength'), 1);
    assert.ok(p.carryBonusKg > 10 && p.carryBonusKg < 20);
  });

  test('search time improves but never reaches zero', () => {
    const p = new Progression(bus);
    for (let i = 0; i < 400; i++) p.addSkillXp('scavenging', 500);
    assert.ok(p.searchTimeMultiplier > 0.4 && p.searchTimeMultiplier < 1);
  });
});

describe('Hideout', () => {
  test('upgrades are gated behind the generator', () => {
    const h = new Hideout(bus);
    const blocked = h.upgradeBlocker('workshop', 10_000_000, () => true);
    assert.match(blocked ?? '', /Generator/);

    h.modules.generator.level = 1;
    assert.equal(h.upgradeBlocker('workshop', 10_000_000, () => true), null);
  });

  test('missing materials block an upgrade', () => {
    const h = new Hideout(bus);
    assert.equal(h.upgradeBlocker('stash', 10_000_000, () => false), 'Material fehlt');
  });

  test('stash grows with the Lager level', () => {
    const h = new Hideout(bus);
    const base = h.stashSize.height;
    h.modules.stash.level = 2;
    assert.ok(h.stashSize.height > base);
  });

  test('construction completes on the clock', () => {
    const h = new Hideout(bus);
    h.modules.generator.level = 1;
    h.startUpgrade('stash');
    assert.equal(h.modules.stash.level, 0);
    h.update(100000);
    assert.equal(h.modules.stash.level, 1);
  });
});

describe('QuestSystem', () => {
  test('prerequisites gate availability', () => {
    const q = new QuestSystem(bus);
    q.refreshAvailability(1);
    assert.equal(q.states.get('q_first_blood')!.status, 'available');
    assert.equal(q.states.get('q_valuables')!.status, 'locked');
  });

  test('objectives advance and complete', () => {
    const q = new QuestSystem(bus);
    q.refreshAvailability(1);
    q.accept('q_first_blood');
    q.advance('killTier', 4, 'scavenger');
    assert.equal(q.isComplete('q_first_blood'), false, 'extraction is still outstanding');
    q.advance('extract', 1);
    assert.equal(q.isComplete('q_first_blood'), true);
    assert.ok(q.turnIn('q_first_blood'));
    assert.equal(q.states.get('q_first_blood')!.status, 'complete');
  });

  test('the wrong tier does not count', () => {
    const q = new QuestSystem(bus);
    q.refreshAvailability(1);
    q.accept('q_first_blood');
    q.advance('killTier', 4, 'contractor');
    const state = q.states.get('q_first_blood')!;
    assert.equal(state.progress.o1 ?? 0, 0);
  });

  test('death resets raid-scoped objectives but keeps banked progress', () => {
    const q = new QuestSystem(bus);
    q.refreshAvailability(1);
    q.accept('q_first_blood');
    q.advance('killTier', 3, 'scavenger');
    q.advance('extract', 1);
    q.onPlayerDeath();
    const state = q.states.get('q_first_blood')!;
    assert.equal(state.progress.o1, 3, 'kills already made are kept');
    assert.equal(state.progress.o2, 0, 'the extraction requirement resets');
  });
});

describe('TraderSystem', () => {
  test('traders only buy what they deal in', () => {
    const t = new TraderSystem(5);
    const rifle = createStack('wp_sg545');
    const bandage = createStack('med_bandage');
    assert.ok(t.sellPrice('kessler', rifle) > 0, 'the armourer buys weapons');
    assert.equal(t.sellPrice('marek', rifle), 0, 'the medic does not');
    assert.ok(t.sellPrice('marek', bandage) > 0);
  });

  test('they always buy below reference value', () => {
    const t = new TraderSystem(5);
    const rifle = createStack('wp_sg545');
    assert.ok(t.sellPrice('kessler', rifle) < stackValue(rifle));
  });

  test('bestBuyer picks the highest offer', () => {
    const t = new TraderSystem(5);
    const valuable = createStack('val_chain');
    const best = t.bestBuyer(valuable);
    assert.equal(best?.id, 'zoellner', 'the fence pays most for valuables');
  });

  test('restocking produces affordable, sorted stock', () => {
    const t = new TraderSystem(5);
    t.restock('kessler', 1);
    const offers = t.states.kessler.offers;
    assert.ok(offers.length > 0);
    for (let i = 1; i < offers.length; i++) {
      assert.ok(offers[i].price >= offers[i - 1].price, 'stock should be price-sorted');
    }
  });

  test('buying consumes stock and builds reputation', () => {
    const t = new TraderSystem(5);
    t.restock('kessler', 1);
    const before = t.states.kessler.reputation;
    const quantity = t.states.kessler.offers[0].quantity;
    const bought = t.buy('kessler', 0);
    assert.ok(bought);
    assert.ok(t.states.kessler.reputation >= before);
    const remaining = t.states.kessler.offers[0]?.quantity ?? 0;
    assert.ok(remaining === quantity - 1 || quantity === 1);
  });
});

// ===========================================================================
// Raid conditions
// ===========================================================================

describe('Conditions', () => {
  test('time and weather multipliers compose', () => {
    const day = makeConditions('day', 'clear');
    const night = makeConditions('night', 'storm');

    assert.ok(night.ambientScale < day.ambientScale * 0.3, 'a stormy night is far darker');
    assert.ok(night.sightScale < day.sightScale, 'and much harder to see in');
    assert.ok(night.soundScale < day.soundScale, 'heavy rain shortens how far sound carries');
    assert.ok(night.rewardScale > day.rewardScale * 1.3, 'and pays for the difficulty');
    assert.ok(night.fogDensity > day.fogDensity);
    assert.equal(day.darkEnoughForLight, false);
    assert.equal(night.darkEnoughForLight, true);
  });

  test('the label names both halves, and omits clear weather', () => {
    assert.equal(makeConditions('night', 'clear').label, 'Nacht');
    assert.ok(makeConditions('night', 'rain').label.includes('Nacht'));
    assert.ok(makeConditions('night', 'rain').label.includes('Regen'));
  });

  test('rollWeather is deterministic and covers the whole table', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(rollWeather(i));
    for (const profile of WEATHER_PROFILES) {
      assert.ok(seen.has(profile.id), `weather ${profile.id} should be reachable`);
    }
    // Same roll, same weather - a deployment stays reproducible from its seed.
    assert.equal(rollWeather(123456), rollWeather(123456));
    // Negative rolls must not fall through to the default.
    assert.ok(WEATHER_PROFILES.some((w) => w.id === rollWeather(-7)));
  });

  test('night darkens the sky without switching the lamps off', () => {
    const map = new TileMap(16, 16);
    map.tiles.fill(Tile.Floor);
    const outdoor = map.index(2, 2);
    const lamp = map.index(9, 9);
    map.lampLight[lamp] = 200;

    applyConditions(map, 0.66, makeConditions('day', 'clear'));
    const dayOutdoor = map.lightmap[outdoor];
    const dayLamp = map.lightmap[lamp];

    applyConditions(map, 0.66, makeConditions('night', 'clear'));
    const nightOutdoor = map.lightmap[outdoor];
    const nightLamp = map.lightmap[lamp];

    assert.ok(nightOutdoor < dayOutdoor * 0.3, 'open ground goes dark');
    assert.ok(nightLamp > nightOutdoor * 3, 'a lit yard stays the brightest ground on the map');
    assert.ok(nightLamp >= dayLamp * 0.9, 'street lighting is not dimmed by nightfall');
  });

  test('nothing is ever pure black', () => {
    const map = new TileMap(8, 8);
    map.tiles.fill(Tile.Floor);
    map.ceiling.fill(1);
    const night = makeConditions('night', 'storm');
    applyConditions(map, 0.38, night);
    for (let i = 0; i < map.lightmap.length; i++) {
      assert.ok(map.lightmap[i] >= night.minLight, 'indoor tiles keep a readable floor');
    }
  });

  test('conditions do not touch map layout', () => {
    const blueprint = MAP_BLUEPRINTS[0];
    const a = generateMap(blueprint, 4242);
    const b = generateMap(blueprint, 4242);
    applyConditions(b.map, b.ambient, makeConditions('night', 'fog'));
    assert.deepEqual(Array.from(a.map.tiles), Array.from(b.map.tiles), 'same seed, same ground');
    assert.deepEqual(a.extracts.map((e) => e.id), b.extracts.map((e) => e.id));
  });
});

// ===========================================================================
// Perception under light and weather
// ===========================================================================

describe('Perception', () => {
  const openMap = (): TileMap => {
    const map = new TileMap(64, 64);
    map.tiles.fill(Tile.Floor);
    map.lightmap.fill(20); // night
    return map;
  };

  const target = (x: number, y: number): Combatant => ({
    id: 99,
    x,
    y,
    radius: 0.3,
    height: 1.8,
    eyeHeight: 1.6,
    angle: 0,
    health: null as never,
    inventory: null as never,
    isPlayer: true,
    name: 'Ziel',
    alive: true,
  });

  const observer = (sightScale: number): PerceptionInput => ({
    observerX: 4,
    observerY: 32,
    observerAngle: 0,
    hearingMultiplier: 1,
    suppressed: false,
    sightScale,
  });

  test('darkness shortens the range at which anything is spotted', () => {
    const map = openMap();
    const profile = AI_PROFILES.guard;
    // Just inside daylight spotting range, well outside night range.
    const spot = target(4 + profile.sightRange * 0.8, 32);

    const byDay = createAwareness();
    updateVision(byDay, profile, observer(1), spot, map, 1, 0, 2);
    const byNight = createAwareness();
    updateVision(byNight, profile, observer(0.5), spot, map, 1, 0, 2);

    assert.ok(byDay.visible, 'visible in daylight');
    assert.ok(!byNight.visible, 'the same target is not seen at night');
  });

  test('a switched-on torch is seen from beyond normal spotting range', () => {
    const map = openMap();
    const profile = AI_PROFILES.guard;
    const spot = target(4 + profile.sightRange * 0.7, 32);

    const dark = createAwareness();
    updateVision(dark, profile, observer(0.5), spot, map, 1, 0, 2, 0);
    const lit = createAwareness();
    updateVision(lit, profile, observer(0.5), spot, map, 1, 0, 2, 0.85);

    assert.ok(!dark.visible, 'unlit, the target stays inside the darkness');
    assert.ok(lit.visible, 'a torch carries far past the range a body does');
    assert.ok(lit.level > 0, 'and starts building awareness immediately');
  });

  test('a torch also destroys the benefit of standing in shadow', () => {
    const map = openMap();
    const profile = AI_PROFILES.guard;
    const spot = target(12, 32);

    const shadowed = createAwareness();
    updateVision(shadowed, profile, observer(1), spot, map, 0.5, 0, 0);
    const lit = createAwareness();
    updateVision(lit, profile, observer(1), spot, map, 0.5, 0, 0, 1);

    assert.ok(lit.level > shadowed.level * 1.5, 'the same crouched target is far more conspicuous');
  });
});

describe('WorldMesh', () => {
  /** A patch of open floor with one solid block in the middle. */
  const blockMap = (): TileMap => {
    const map = new TileMap(12, 12);
    map.tiles.fill(Tile.Floor);
    map.tiles[6 * 12 + 6] = Tile.Concrete;
    return map;
  };

  /** Read one vertex's attributes out of the interleaved buffer. */
  const vertexAt = (data: Float32Array, i: number) => ({
    x: data[i * FLOATS_PER_VERTEX],
    y: data[i * FLOATS_PER_VERTEX + 1],
    z: data[i * FLOATS_PER_VERTEX + 2],
    axis: data[i * FLOATS_PER_VERTEX + 7],
    ao: data[i * FLOATS_PER_VERTEX + 8],
  });

  test('every vertex carries a face orientation the shader knows', () => {
    const mesh = buildWorldMesh(blockMap());
    assert.ok(mesh.opaqueCount > 0, 'the mesh should not be empty');
    for (let i = 0; i < mesh.opaqueCount; i++) {
      const axis = vertexAt(mesh.opaque, i).axis;
      assert.ok(
        Number.isInteger(axis) && axis >= 0 && axis <= 5,
        `vertex ${i} has axis ${axis}, which is not one of the six orientations`,
      );
    }
  });

  test('floor corners touching a wall are occluded, open floor is not', () => {
    const mesh = buildWorldMesh(blockMap());

    // Every floor vertex, grouped by the grid point it sits on.
    const aoAt = new Map<string, number>();
    for (let i = 0; i < mesh.opaqueCount; i++) {
      const v = vertexAt(mesh.opaque, i);
      if (v.axis !== AXIS_UP || v.z !== 0) continue;
      const key = `${v.x},${v.y}`;
      // A grid point is shared by up to four floor tiles; keep the darkest,
      // which is the one facing the obstruction.
      aoAt.set(key, Math.min(aoAt.get(key) ?? 1, v.ao));
    }

    // The four grid points on the block's own footprint are the ones its
    // neighbours' floors share with it.
    assert.ok(aoAt.get('6,6')! < 0.95, 'the floor corner against the block should be darkened');
    assert.ok(aoAt.get('7,7')! < 0.95, 'and so should the opposite one');
    // Well clear of it, nothing occludes anything.
    assert.equal(aoAt.get('2,2'), 1, 'open floor should be fully lit');
    assert.equal(aoAt.get('10,3'), 1, 'and so should floor on the other side');
  });

  test('a wall is darkest where it meets the ground', () => {
    const mesh = buildWorldMesh(blockMap());

    let lowest = 1;
    let highest = 0;
    for (let i = 0; i < mesh.opaqueCount; i++) {
      const v = vertexAt(mesh.opaque, i);
      // The four side faces of the block.
      if (v.axis < AXIS_WEST) continue;
      if (v.z === 0) lowest = Math.min(lowest, v.ao);
      else highest = Math.max(highest, v.ao);
    }

    assert.ok(lowest < 0.8, `the base of a wall should be occluded, got ${lowest}`);
    assert.ok(highest > 0.95, `the top should not be, got ${highest}`);
    assert.ok(highest > lowest, 'and the contact shadow has to run the right way up');
  });

  test('ambient occlusion never goes negative or above unity', () => {
    const map = generateMap(MAP_BLUEPRINTS[0], 4242).map;
    const mesh = buildWorldMesh(map);
    for (const data of [mesh.opaque, mesh.transparent]) {
      for (let i = 0; i < data.length / FLOATS_PER_VERTEX; i++) {
        const ao = vertexAt(data, i).ao;
        assert.ok(ao > 0 && ao <= 1, `vertex ${i} has an out-of-range occlusion of ${ao}`);
      }
    }
  });
});

describe('Locations feel different', () => {
  /**
   * Mean unobstructed outdoor sightline, in tiles.
   *
   * This is the number a player feels without being able to name it: how far
   * they can see before something blocks it, which decides whether a scope is
   * worth carrying and whether crossing open ground is a decision or a stroll.
   * Sampled on a coarse grid along the four axes, outdoors only - indoor
   * sightlines are short everywhere and would wash the signal out.
   */
  const outdoorSightline = (bp: (typeof MAP_BLUEPRINTS)[number], seed: number): number => {
    const map = generateMap(bp, seed).map;
    let total = 0;
    let samples = 0;
    for (let y = 2; y < map.height - 2; y += 3) {
      for (let x = 2; x < map.width - 2; x += 3) {
        const i = y * map.width + x;
        if (map.tiles[i] !== Tile.Floor || map.ceiling[i]) continue;
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
          let d = 0;
          while (d < 80) {
            const nx = x + dx * (d + 1);
            const ny = y + dy * (d + 1);
            if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) break;
            if (map.tiles[ny * map.width + nx] !== Tile.Floor) break;
            d++;
          }
          total += d;
          samples++;
        }
      }
    }
    return total / Math.max(1, samples);
  };

  const range = (id: string) => {
    const bp = MAP_BLUEPRINTS.find((b) => b.id === id)!;
    const values = [1, 2, 3, 4, 5].map((seed) => outdoorSightline(bp, seed));
    return { min: Math.min(...values), max: Math.max(...values) };
  };

  test('each location has its own character, and the seed does not erase it', () => {
    // The bug this pins down: three "different locations" used to measure
    // 8.3, 8.7 and 10.8 tiles, while five seeds of a single one spanned
    // 8.9 to 10.8. The spread within a location was as large as the gap
    // between locations, so nothing was recognisable - a fourth entry in the
    // table would only have produced a fourth interchangeable map.
    //
    // What separates them is `clutter`. Measured across its usable range it
    // moves this number from 11.1 down to 4.6; structure spacing, which I
    // added first on the assumption it would dominate, moved it from 7.3 to
    // 8.3 and was removed again.
    const harbour = range('harbour');
    const depot = range('depot');
    const works = range('works');

    // Ordered: an open dock, a mixed depot, a packed boiler house.
    assert.ok(
      works.max < depot.min,
      `the works should be tighter than the depot on every seed ` +
        `(works up to ${works.max.toFixed(1)}, depot from ${depot.min.toFixed(1)})`,
    );
    assert.ok(
      depot.max < harbour.min,
      `the depot should be tighter than the harbour on every seed ` +
        `(depot up to ${depot.max.toFixed(1)}, harbour from ${harbour.min.toFixed(1)})`,
    );

    // And the difference has to be worth feeling, not a rounding error.
    assert.ok(
      harbour.min > works.max * 2,
      `the open location should see at least twice as far as the tight one ` +
        `(harbour from ${harbour.min.toFixed(1)}, works up to ${works.max.toFixed(1)})`,
    );
  });

  test('the new locations own an axis of their own', () => {
    // The harbour, depot and works are separated by sightline. The other two
    // deliberately are not - they would sit on top of the depot and the works
    // on that measure - so they have to earn their place on a different axis,
    // or they are reskins.
    const indoorShare = (id: string): number => {
      const bp = MAP_BLUEPRINTS.find((b) => b.id === id)!;
      let floor = 0;
      let roofed = 0;
      for (let seed = 1; seed <= 4; seed++) {
        const map = generateMap(bp, seed).map;
        for (let i = 0; i < map.width * map.height; i++) {
          if (map.tiles[i] !== Tile.Floor) continue;
          floor++;
          if (map.ceiling[i]) roofed++;
        }
      }
      return roofed / Math.max(1, floor);
    };

    // The Klaerwerk is the one fought indoors, and it has to lead *every*
    // other location on that measure - not merely beat one of them.
    //
    // This was written as "1.8x the harbour" when the harbour was 14 % roofed.
    // Then every map grew and gained interiors, the harbour reached 23 %, and
    // the ratio stopped holding while the Klaerwerk was still clearly the most
    // interior place in the game. A threshold pinned to another map's absolute
    // value ages badly; "strictly ahead of all of them, by a margin worth
    // feeling" says the intended thing and cannot be satisfied by accident.
    //
    // The generator's ceiling here is about 36 %: past roughly two dozen
    // buildings the placer runs out of room and further ones simply fail, so
    // squeezing the plot smaller buys interior share by losing districts. 30 %
    // at fifteen districts is the better trade.
    const filter = indoorShare('filter');
    const others = MAP_BLUEPRINTS
      .filter((b) => b.id !== 'filter')
      .map((b) => ({ id: b.id, share: indoorShare(b.id) }));
    const runnerUp = others.reduce((a, b) => (b.share > a.share ? b : a));
    assert.ok(
      filter > runnerUp.share * 1.15,
      `the Klaerwerk should be the most interior location by a clear margin - ` +
        `it is ${(filter * 100).toFixed(0)} % roofed against ${runnerUp.id} at ` +
        `${(runnerUp.share * 100).toFixed(0)} %`,
    );
    // And dark enough that the torch stops being optional.
    const filterBp = MAP_BLUEPRINTS.find((b) => b.id === 'filter')!;
    const harbourBp = MAP_BLUEPRINTS.find((b) => b.id === 'harbour')!;
    assert.ok(
      filterBp.ambient < harbourBp.ambient * 0.6,
      `the Klaerwerk should be markedly darker (${filterBp.ambient} vs ${harbourBp.ambient})`,
    );

    // The Verladehof is the risk/reward extreme rather than a geometric one:
    // hostiles per tile, and a clock short enough that clearing is not on the
    // table.
    const density = (id: string): number => {
      const bp = MAP_BLUEPRINTS.find((b) => b.id === id)!;
      return bp.aiCount / (bp.width * bp.height);
    };
    assert.ok(
      density('yard') > density('harbour') * 2.5,
      `the Verladehof should be far denser than the harbour ` +
        `(${(density('yard') * 1000).toFixed(1)} vs ${(density('harbour') * 1000).toFixed(1)} per 1000 tiles)`,
    );
    // The clock is half the pressure, so it has to stay the shortest by a
    // wide margin rather than merely be short. Pinned relatively, because an
    // absolute bound broke the moment every location's clock grew with its
    // area - the Verladehof went from 8 to 10 minutes and the assertion
    // failed while the map had become *more* distinct, not less.
    const yardBp = MAP_BLUEPRINTS.find((b) => b.id === 'yard')!;
    const shortestOther = Math.min(
      ...MAP_BLUEPRINTS.filter((b) => b.id !== 'yard').map((b) => b.raidSeconds),
    );
    assert.ok(
      yardBp.raidSeconds <= shortestOther * 0.6,
      `the Verladehof's clock has to be the pressure - ${yardBp.raidSeconds / 60} min ` +
        `against ${shortestOther / 60} min for the next shortest`,
    );
  });

  test('every location still has room to fight in', () => {
    // The counterweight. Driving clutter up to make a place feel tight is easy
    // and would eventually produce a map that is impassable rather than
    // claustrophobic, so this holds the floor.
    for (const bp of MAP_BLUEPRINTS) {
      const generated = generateMap(bp, 3);
      const map = generated.map;
      let floor = 0;
      for (let i = 0; i < map.width * map.height; i++) {
        if (map.tiles[i] === Tile.Floor) floor++;
      }
      const walkable = floor / (map.width * map.height);
      assert.ok(
        walkable > 0.55,
        `${bp.id} is only ${(walkable * 100).toFixed(0)} % walkable - too solid to move through`,
      );
      assert.ok(
        generated.lootAnchors.length >= 20,
        `${bp.id} has only ${generated.lootAnchors.length} loot anchors - not worth the trip`,
      );
      assert.ok(
        generated.extracts.length >= 2,
        `${bp.id} must offer a choice of exit, has ${generated.extracts.length}`,
      );
    }
  });
});

describe('Ammunition choice', () => {
  // The gun used to pick the highest-penetration round in the bag, always, and
  // the player had no way to say otherwise. That auto-pick is frequently the
  // worst available choice - against an unarmoured target, armour-piercing
  // throws away a third of the damage - so this checks two things: that the
  // trade-off in the data is real enough to be worth a decision, and that the
  // decision actually reaches the magazine.

  const NEUTRAL = { gearErgoPenalty: 0, handlingSkill: 0, recoilSkill: 0 };
  /** Standing still, not aiming - none of it matters for a reload. */
  const FIRE_CTX = {
    x: 5, y: 5, z: 1.5, angle: 0, pitch: 0, speed: 0, stance: 2 as const,
    swayMultiplier: 1, resolve: NEUTRAL,
  };

  const inventoryWith = (entries: [string, number][]): Inventory => {
    const inv = new Inventory();
    for (const [id, count] of entries) {
      const stack = createStack(id);
      stack.count = count;
      assert.ok(inv.store(stack), `could not store ${id}`);
    }
    return inv;
  };

  const controllerFor = (weaponId: string, magId: string, inv: Inventory) => {
    const bus = new EventBus<Record<string, never>>() as never;
    const effects = new EffectSystem(64, 64);
    const ballistics = new BallisticsSystem(bus, effects, 7);
    const controller = new WeaponController(bus, ballistics, 1, true, 7);
    const weapon = createStack(weaponId);
    weapon.magazine = createStack(magId);
    controller.setWeapon(weapon, NEUTRAL, true);
    return { controller, weapon, inv };
  };

  /**
   * Reloading is staged over time, so drive the clock until it settles.
   *
   * The budget is generous because loading loose rounds is genuinely slow -
   * roughly a third of a second per cartridge, so filling a thirty-round
   * magazine from a pocket of loose ammunition takes about thirteen seconds.
   * My first version allowed ten and reported "the reload never finished",
   * which was true and told me nothing about the feature under test.
   */
  const reloadFully = (controller: WeaponController, inv: Inventory): void => {
    assert.ok(controller.reload(inv), 'the reload should have been accepted');
    for (let i = 0; i < 3600 && controller.isBusy; i++) {
      controller.update(1 / 60, FIRE_CTX);
    }
    assert.ok(!controller.isBusy, 'the reload never finished');
  };

  test('penetration is paid for in damage, so the choice is a real one', () => {
    // If this ever stops holding, the feature above is pointless - there is no
    // decision when one round is simply better.
    const soft = ItemDB.get('ammo_545_hp').ammo!;
    const hard = ItemDB.get('ammo_545_bp').ammo!;
    assert.ok(
      hard.penetration > soft.penetration,
      `the armour round should out-penetrate (${hard.penetration} vs ${soft.penetration})`,
    );
    assert.ok(
      soft.damage > hard.damage * 1.2,
      `the soft round should hit flesh materially harder (${soft.damage} vs ${hard.damage})`,
    );
  });

  test('with no preference it loads the hardest-hitting penetrator', () => {
    const inv = inventoryWith([['ammo_545_hp', 60], ['ammo_545_bp', 60]]);
    const { controller, weapon } = controllerFor('wp_sg545', 'mag_545_30', inv);
    reloadFully(controller, inv);
    assert.equal(
      peekNextRound(weapon), 'ammo_545_bp',
      'the automatic pick is highest penetration',
    );
  });

  test('a preference overrides it', () => {
    const inv = inventoryWith([['ammo_545_hp', 60], ['ammo_545_bp', 60]]);
    const { controller, weapon } = controllerFor('wp_sg545', 'mag_545_30', inv);
    controller.preferredAmmo = 'ammo_545_hp';
    reloadFully(controller, inv);
    assert.equal(
      peekNextRound(weapon), 'ammo_545_hp',
      'the player asked for the soft round and should get it',
    );
  });

  test('the choice survives the raid it was made in', () => {
    // The controller is rebuilt on every deployment, so a preference stored
    // only there died at extraction and had to be re-entered before every
    // fight. Nobody re-enters a setting before every fight; they stop using
    // it. This models the round trip: choose, save, reload, deploy again.
    // Take the key from the data rather than typing it. My first version
    // guessed "5.45x39" and the real string is "5.45x39mm" - a wrong key does
    // not error, it silently misses and hands the player the auto-pick.
    const rifleCaliber = ItemDB.get('wp_sg545').weapon!.caliber;

    const profile = new Profile(new EventBus<Record<string, never>>() as never, 99);
    profile.ammoPreferences[rifleCaliber] = 'ammo_545_hp';

    const restored = new Profile(new EventBus<Record<string, never>>() as never, 99);
    const saved = JSON.parse(JSON.stringify(profile.serialize()));
    restored.ammoPreferences = saved.ammoPreferences ?? {};

    assert.equal(
      restored.ammoPreferences[rifleCaliber], 'ammo_545_hp',
      'the cartridge choice has to survive a save and load',
    );

    // The stored round must actually be loadable in that weapon, or the
    // preference is unreachable however faithfully it round-trips.
    assert.equal(
      ItemDB.get('ammo_545_hp').ammo!.caliber, rifleCaliber,
      'the preferred round has to match the calibre it is filed under',
    );
  });

  test('preferences are per calibre, so a sidearm keeps its own', () => {
    // A loadout is a rifle and a pistol. "Soft point in the pistol,
    // armour-piercing in the rifle" is an ordinary thing to want, and a single
    // global preference could not express it.
    const rifleCal = ItemDB.get('ammo_545_bp').ammo!.caliber;
    const pistolCal = ItemDB.get('ammo_9_hp').ammo!.caliber;
    assert.notEqual(rifleCal, pistolCal, 'the two should be different calibres');

    const profile = new Profile(new EventBus<Record<string, never>>() as never, 5);
    profile.ammoPreferences[rifleCal] = 'ammo_545_bp';
    profile.ammoPreferences[pistolCal] = 'ammo_9_hp';

    assert.equal(profile.ammoPreferences[rifleCal], 'ammo_545_bp');
    assert.equal(profile.ammoPreferences[pistolCal], 'ammo_9_hp',
      'setting the rifle preference must not disturb the sidearm');
  });

  test('a preference it cannot honour falls back rather than failing', () => {
    // Asked for a cartridge that is either the wrong calibre or not carried.
    // Refusing to reload would be the worst possible reading of "preference".
    const inv = inventoryWith([['ammo_545_bp', 60]]);
    const { controller, weapon } = controllerFor('wp_sg545', 'mag_545_30', inv);
    controller.preferredAmmo = 'ammo_9_hp'; // wrong calibre entirely
    reloadFully(controller, inv);
    assert.equal(
      peekNextRound(weapon), 'ammo_545_bp',
      'an unusable preference must fall back to the automatic pick, not jam the gun',
    );
  });
});

describe('Tone mapping', () => {
  // The two renderers have to agree about exposure, and for a long time they
  // did not: the shader used a filmic curve, the software path used a Reinhard
  // variant, and the measured result was a software frame 44 % darker than the
  // GPU frame of the same scene. On a night raid that decides what the player
  // can see, so it is not a cosmetic difference.
  //
  // The curves cannot literally be shared - one of them is GLSL - so this
  // pins the TypeScript copy against the constants parsed out of the shader
  // source. If either moves, this fails without needing a browser.
  const shaderConstants = (): Record<string, number> => {
    const body = COMPOSITE_FS.slice(COMPOSITE_FS.indexOf('vec3 tonemap('));
    const out: Record<string, number> = {};
    for (const m of body.slice(0, 400).matchAll(/const float ([a-e]) = ([0-9.]+);/g)) {
      out[m[1]] = Number(m[2]);
    }
    return out;
  };

  test('the shader and the software path use the same curve', () => {
    const k = shaderConstants();
    assert.deepEqual(
      Object.keys(k).sort(),
      ['a', 'b', 'c', 'd', 'e'],
      `could not read the tone curve out of the shader, got ${JSON.stringify(k)}`,
    );

    for (let i = 0; i <= 40; i++) {
      const x = (i / 40) * 2.5;
      const shader = Math.min(1, Math.max(0,
        (x * (k.a * x + k.b)) / (x * (k.c * x + k.d) + k.e)));
      const software = filmicToneMap(x);
      assert.ok(
        Math.abs(shader - software) < 1e-9,
        `the two tone curves disagree at x=${x.toFixed(2)}: ` +
          `shader ${shader.toFixed(6)}, software ${software.toFixed(6)}`,
      );
    }
  });

  test('it is monotonic, bounded, and lifts the mid-tones', () => {
    let previous = -1;
    for (let i = 0; i <= 200; i++) {
      const v = filmicToneMap((i / 200) * 4);
      assert.ok(v >= previous, `the curve must never go backwards (at ${i})`);
      assert.ok(v >= 0 && v <= 1, `the curve must stay in range, got ${v}`);
      previous = v;
    }
    assert.equal(filmicToneMap(0), 0, 'black has to stay black');
    // The Reinhard curve this replaced returned 0.375 here, which is what made
    // the fallback look like a different, darker game.
    const mid = filmicToneMap(0.5);
    assert.ok(
      mid > 0.55 && mid < 0.68,
      `mid grey should land near 0.62, got ${mid.toFixed(3)}`,
    );
  });
});

describe('Style', () => {
  test('every style is complete and internally consistent', () => {
    for (const id of STYLE_ORDER) {
      const style = STYLES[id];
      assert.equal(style.id, id, `${id} is filed under the wrong key`);
      assert.ok(style.name.length > 0, `${id} needs a name for the settings list`);
      assert.ok(style.tagline.length > 0, `${id} needs a tagline`);

      const g = style.grade;
      assert.ok(g.saturation >= 0, `${id} cannot have negative saturation`);
      assert.ok(g.contrast > 0, `${id} needs positive contrast`);
      for (const [label, v] of [
        ['grain', g.grain], ['vignette', g.vignette],
        ['aberration', g.aberration], ['scanlines', g.scanlines],
        ['bloom', g.bloomStrength], ['outline', g.outline],
        ['halftone', g.halftone],
      ] as const) {
        assert.ok(v >= 0 && v <= 2, `${id} has an implausible ${label} of ${v}`);
      }
      assert.equal(g.shadowTint.length, 3);
      assert.equal(g.highlightTint.length, 3);
      assert.equal(g.outlineColor.length, 3);
      assert.ok(g.celBands >= 0 && g.celBands <= 16, `${id} has ${g.celBands} cel bands`);
      assert.ok(g.outlineWidth > 0, `${id} needs a positive outline width`);
    }
  });

  test('every style defines the same set of custom properties', () => {
    // A style missing a property inherits whichever one the previous style
    // left on the document root, which is the sort of bug that only shows up
    // after switching twice.
    const reference = Object.keys(STYLES[STYLE_ORDER[0]].css).sort();
    for (const id of STYLE_ORDER) {
      assert.deepEqual(
        Object.keys(STYLES[id].css).sort(),
        reference,
        `${id} does not declare the same properties as the others`,
      );
    }
  });

  test('every colour is a parseable hex value', () => {
    const hex = /^#[0-9a-f]{6}$/i;
    for (const id of STYLE_ORDER) {
      const style = STYLES[id];
      for (const [name, value] of Object.entries(style.css)) {
        // Sizes and shadows are not colours; only check the ones that are.
        if (!value.startsWith('#')) continue;
        assert.ok(hex.test(value), `${id} ${name} is not a hex colour: ${value}`);
      }
      const w = style.weapon;
      for (const [name, value] of Object.entries(w)) {
        if (typeof value !== 'string' || value === '') continue;
        assert.ok(hex.test(value), `${id} weapon.${name} is not a hex colour: ${value}`);
      }
    }
  });

  test('the three are actually different from each other', () => {
    // The point of offering a choice is that it is one. This catches a style
    // added by copying another and half-edited.
    const seen = new Set<string>();
    for (const id of STYLE_ORDER) {
      const g = STYLES[id].grade;
      const fingerprint = [
        g.saturation, g.contrast, g.grain, g.aberration, g.scanlines,
        g.celBands, g.outline, g.halftone, g.posterize,
        ...g.shadowTint, ...g.highlightTint,
      ].join(',');
      assert.ok(!seen.has(fingerprint), `${id} has the same grade as another style`);
      seen.add(fingerprint);
      assert.notEqual(STYLES[id].css['--accent'], undefined);
    }
    const accents = STYLE_ORDER.map((id) => STYLES[id].css['--accent']);
    assert.equal(new Set(accents).size, accents.length, 'two styles share an accent colour');
  });

  test('the default style exists', () => {
    assert.ok(STYLES[DEFAULT_STYLE], 'the default has to name a real style');
    assert.ok(STYLE_ORDER.includes(DEFAULT_STYLE), 'and has to be offered in the list');
  });

  test('an unknown id falls back rather than throwing', () => {
    // Settings come out of localStorage, which can hold a style from a build
    // that no longer exists.
    assert.equal(styleById('does-not-exist').id, DEFAULT_STYLE);
    assert.equal(styleById('').id, DEFAULT_STYLE);
    assert.equal(styleById('comic').id, 'comic');
  });
});

describe('RecoilPattern', () => {
  test('the same weapon draws the same shape every time', () => {
    // The whole point: a pattern nobody can rely on is noise with extra steps.
    const a = patternFor('wp_sg545', PATTERN_BY_CLASS.rifle);
    const b = patternFor('wp_sg545', PATTERN_BY_CLASS.rifle);
    assert.deepEqual(a, b, 'a pattern must be reproducible to be learnable');

    const fresh = buildPattern('wp_sg545', PATTERN_BY_CLASS.rifle);
    assert.deepEqual(fresh, a, 'and must not depend on the cache being warm');
  });

  test('different weapons draw different shapes', () => {
    const rifle = patternFor('wp_sg545', PATTERN_BY_CLASS.rifle);
    const smg = patternFor('wp_mpn9', PATTERN_BY_CLASS.smg);
    const different = rifle.some(
      (step, i) => Math.abs(step.horizontal - smg[i].horizontal) > 0.01,
    );
    assert.ok(different, 'two weapons should not share a spray pattern');
  });

  test('the first shot kicks hardest and the climb settles', () => {
    const p = patternFor('wp_sk762', PATTERN_BY_CLASS.battle);
    const early = p[0].vertical;
    const late = p.slice(20).reduce((sum, s) => sum + s.vertical, 0) / (p.length - 20);
    assert.ok(early > late, `first shot ${early} should exceed sustained ${late}`);
    assert.ok(late > 0.2, 'sustained recoil should not vanish entirely');
  });

  test('every step is finite and bounded', () => {
    for (const [cls, spec] of Object.entries(PATTERN_BY_CLASS)) {
      for (const step of patternFor(`probe_${cls}`, spec)) {
        assert.ok(Number.isFinite(step.vertical), `${cls} vertical is not finite`);
        assert.ok(Number.isFinite(step.horizontal), `${cls} horizontal is not finite`);
        assert.ok(step.vertical > 0, `${cls} should never push the muzzle down`);
        assert.ok(Math.abs(step.horizontal) < 3, `${cls} horizontal ${step.horizontal} is wild`);
      }
    }
  });

  test('the pattern wraps rather than running off the end', () => {
    const p = patternFor('wp_lm556', PATTERN_BY_CLASS.lmg);
    // An LMG belt is longer than the pattern; it has to keep moving.
    assert.deepEqual(stepAt(p, p.length), p[0]);
    assert.deepEqual(stepAt(p, p.length * 3 + 5), p[5]);
    assert.deepEqual(stepAt(p, -1), p[p.length - 1], 'and cope with a negative index');
  });

  test('horizontal drift actually reverses, so the shape is a shape', () => {
    const p = patternFor('wp_ar556', PATTERN_BY_CLASS.rifle);
    const signs = new Set(p.slice(0, 20).map((s) => Math.sign(s.horizontal)));
    assert.ok(signs.size > 1, 'a pattern that only ever pulls one way is a line, not a pattern');
  });
});

describe('Attachment recoil axes', () => {
  const fitted = (weaponId: string, attachmentId: string | null) => {
    const stack = createStack(weaponId);
    if (attachmentId) {
      // Attachments are stacks, not ids, and the slot comes from the part's
      // own definition - so this cannot quietly fit a grip to the muzzle and
      // prove nothing.
      const slot = ItemDB.get(attachmentId).attachment!.slot;
      stack.attachments = { [slot]: createStack(attachmentId) };
    }
    return resolveWeapon(stack);
  };

  test('a grip fights lateral wander, a stock fights climb', () => {
    // The point of splitting the axes: two parts that remove a similar total
    // amount of recoil should not feel like the same part.
    const bare = fitted('wp_sg545', null);
    const grip = fitted('wp_sg545', 'att_grip_vert');
    const stock = fitted('wp_sg545', 'att_stock_heavy');

    assert.ok(
      grip.recoilHorizontal / bare.recoilHorizontal < grip.recoilVertical / bare.recoilVertical,
      'a vertical grip should help lateral control more than climb',
    );
    assert.ok(
      stock.recoilVertical / bare.recoilVertical < stock.recoilHorizontal / bare.recoilHorizontal,
      'a heavy stock should help climb more than lateral control',
    );
  });

  test('specialising does not make a part stronger overall', () => {
    // The bias redistributes the benefit; it must not manufacture extra.
    const bare = fitted('wp_ar556', null);
    const braked = fitted('wp_ar556', 'att_brake_std');
    const bareTotal = bare.recoilVertical + bare.recoilHorizontal;
    const brakedTotal = braked.recoilVertical + braked.recoilHorizontal;
    assert.ok(brakedTotal < bareTotal, 'a muzzle brake should still reduce recoil overall');
    assert.ok(
      brakedTotal > bareTotal * 0.4,
      `and not become an eighty percent reduction by the back door (${brakedTotal} vs ${bareTotal})`,
    );
  });

  test('every recoil figure stays positive', () => {
    for (const id of ['att_brake_std', 'att_grip_vert', 'att_stock_heavy', 'att_suppressor']) {
      const r = fitted('wp_sk762', id);
      assert.ok(r.recoilVertical > 0, `${id} drove vertical recoil to ${r.recoilVertical}`);
      assert.ok(r.recoilHorizontal > 0, `${id} drove horizontal recoil to ${r.recoilHorizontal}`);
    }
  });
});

describe('Arsenal', () => {
  const weapons = ItemDB.ofCategory('weapon').filter((d) => d.weapon);

  test('every weapon declares a handling class the pattern system knows', () => {
    // A weapon whose class is not in the table silently falls back to the
    // default pattern, which is the kind of miss that only shows up as "this
    // gun feels like that other gun".
    for (const def of weapons) {
      const cls = def.weapon!.weaponClass;
      assert.ok(cls, `${def.id} has no handling class`);
      assert.ok(
        PATTERN_BY_CLASS[cls],
        `${def.id} has class "${cls}", which has no recoil pattern`,
      );
    }
  });

  test('the arsenal covers every role the game asks the player to choose between', () => {
    const classes = new Set(weapons.map((d) => d.weapon!.weaponClass));
    for (const required of ['pistol', 'smg', 'carbine', 'rifle', 'dmr', 'sniper', 'shotgun', 'lmg']) {
      assert.ok(classes.has(required), `nothing in the arsenal fills the ${required} role`);
    }
  });

  test('weapons of the same class are still distinguishable', () => {
    // Two rifles that differ only in price are two entries, not two choices.
    const byClass = new Map<string, typeof weapons>();
    for (const def of weapons) {
      const cls = def.weapon!.weaponClass;
      byClass.set(cls, [...(byClass.get(cls) ?? []), def]);
    }
    for (const [cls, group] of byClass) {
      if (group.length < 2) continue;
      const fingerprints = new Set(
        group.map((d) => {
          const w = d.weapon!;
          return [w.rpm, w.recoilVertical, w.accuracyMoa, w.ergonomics].join('|');
        }),
      );
      assert.equal(
        fingerprints.size, group.length,
        `two ${cls} entries share the same handling numbers`,
      );
    }
  });

  test('the bolt action is genuinely slow to cycle', () => {
    const bolt = ItemDB.get('wp_zr762').weapon!;
    const dmr = ItemDB.get('wp_dm762').weapon!;
    assert.ok(bolt.rpm < dmr.rpm * 0.4, 'a repeater must be far slower than a self-loader');
    assert.ok(bolt.accuracyMoa < dmr.accuracyMoa, 'and buy something real with that time');
  });

  test('carbines sit between submachine guns and rifles', () => {
    const carbine = ItemDB.get('wp_kb556').weapon!;
    const smg = ItemDB.get('wp_mpn9').weapon!;
    const rifle = ItemDB.get('wp_ar556').weapon!;
    assert.ok(
      carbine.ergonomics < rifle.ergonomics && carbine.ergonomics > smg.ergonomics,
      'a carbine should handle between an SMG and a rifle',
    );
    assert.ok(
      carbine.loudness > rifle.loudness,
      'a short barrel on a rifle cartridge should be louder, not quieter',
    );
  });
});

describe('Handling ladder', () => {
  /**
   * Each weapon class should occupy its own band of handling speed.
   *
   * This is the property that makes a class a *choice*. When submachine guns
   * and rifles overlap - which they did, at 0.42-0.48 against 0.44-0.50 -
   * picking the SMG buys nothing it is supposed to buy, and the whole category
   * collapses into "the rifle, but worse at range".
   */
  const worstOf = (cls: string): number => {
    const group = ItemDB.ofCategory('weapon')
      .filter((d) => d.weapon?.weaponClass === cls)
      .map((d) => d.weapon!.ergonomics);
    assert.ok(group.length > 0, `no weapons in class ${cls}`);
    return Math.max(...group);
  };
  const bestOf = (cls: string): number => {
    const group = ItemDB.ofCategory('weapon')
      .filter((d) => d.weapon?.weaponClass === cls)
      .map((d) => d.weapon!.ergonomics);
    return Math.min(...group);
  };

  test('the classes form a ladder rather than a pile', () => {
    // Lower is faster to bring up. Each rung must clear the one below it.
    const ladder = ['pistol', 'smg', 'carbine', 'rifle'];
    for (let i = 1; i < ladder.length; i++) {
      const faster = ladder[i - 1];
      const slower = ladder[i];
      assert.ok(
        worstOf(faster) < bestOf(slower),
        `the slowest ${faster} (${worstOf(faster)}) should still beat the fastest ` +
          `${slower} (${bestOf(slower)}) - otherwise the classes are not a choice`,
      );
    }
  });

  test('the heavy classes are genuinely heavy', () => {
    assert.ok(bestOf('lmg') > worstOf('rifle'), 'an LMG must handle worse than any rifle');
    assert.ok(bestOf('sniper') > worstOf('carbine'), 'a repeater must handle worse than a carbine');
  });
});

describe('Vaulting', () => {
  /** Open ground with a single crate directly east of the player. */
  const crateMap = (): TileMap => {
    const map = new TileMap(16, 16);
    map.tiles.fill(Tile.Floor);
    map.tiles[8 * 16 + 9] = Tile.Crate;
    return map;
  };

  const makePlayer = (): Player => {
    const player = new Player(bus);
    player.reset(8.5, 8.5, 0); // facing +x, at the crate
    return player;
  };

  test('a crate can be crossed, and the player ends up beyond it', () => {
    const map = crateMap();
    const player = makePlayer();
    assert.ok(player.tryVault(map), 'chest-high cover should be climbable');
    assert.ok(player.isVaulting);

    // Run the move to completion.
    for (let i = 0; i < 120 && player.isVaulting; i++) {
      player.update(1 / 60, map, 0, 0, false);
    }
    assert.ok(!player.isVaulting, 'the vault should finish on its own');
    assert.ok(player.x > 9.5, `should have landed past the crate, ended at x=${player.x}`);
    assert.ok(Math.abs(player.y - 8.5) < 0.6, 'and not drifted sideways');
  });

  test('a full-height wall is not climbable', () => {
    const map = crateMap();
    map.tiles[8 * 16 + 9] = Tile.Concrete;
    const player = makePlayer();
    assert.equal(player.tryVault(map), false, 'a three-metre wall is not chest-high');
  });

  test('open ground offers nothing to climb', () => {
    const map = crateMap();
    const player = makePlayer();
    player.angle = Math.PI; // facing away from the crate
    assert.equal(player.tryVault(map), false);
  });

  test('a crate with a wall behind it cannot be crossed', () => {
    // Otherwise the landing either wedges the player inside geometry or hands
    // them a free two-tile teleport, depending on how collision resolves it.
    const map = crateMap();
    map.tiles[8 * 16 + 10] = Tile.Concrete;
    const player = makePlayer();
    assert.equal(player.tryVault(map), false, 'there must be somewhere to land');
  });

  test('climbing costs stamina and is refused when exhausted', () => {
    const map = crateMap();
    const player = makePlayer();
    const before = player.stamina;
    assert.ok(player.tryVault(map));
    assert.ok(player.stamina < before, 'a vault should cost stamina');

    const tired = makePlayer();
    tired.stamina = 4;
    assert.equal(tired.tryVault(map), false, 'an exhausted operator cannot climb');
  });

  test('a crouched operator has nothing to push off', () => {
    const map = crateMap();
    const player = makePlayer();
    player.setStance(1);
    assert.equal(player.tryVault(map), false);
  });

  test('the eye rises over the obstacle and comes back down', () => {
    const map = crateMap();
    const player = makePlayer();
    const ground = player.eyeHeight;
    player.tryVault(map);

    let peak = 0;
    for (let i = 0; i < 120 && player.isVaulting; i++) {
      player.update(1 / 60, map, 0, 0, false);
      peak = Math.max(peak, player.eyeHeight);
    }
    assert.ok(peak > ground + 0.2, `the eye should lift over the crate (peak ${peak}, ground ${ground})`);
    assert.ok(
      Math.abs(player.eyeHeight - ground) < 0.05,
      `and settle back afterwards (ended at ${player.eyeHeight})`,
    );
  });

  test('input is ignored while committed to the climb', () => {
    const map = crateMap();
    const player = makePlayer();
    player.tryVault(map);
    const firstX = player.x;
    // Full reverse on the stick, which would normally back the player off.
    player.update(1 / 60, map, 0, -1, false);
    assert.ok(player.x > firstX, 'the climb should carry through a reversed stick');
  });
});

describe('Spatial audio', () => {
  const listener = (angle = 0): ListenerState =>
    ({ x: 0, y: 0, angle, hearingFactor: 1, deafness: 0 });

  /** A shot at a bearing relative to a listener facing +x. */
  const at = (bearing: number, dist = 12) =>
    spatialise(listener(), Math.cos(bearing) * dist, Math.sin(bearing) * dist, 40, 0);

  test('front and back are distinguishable, which panning alone cannot do', () => {
    // The bug this whole module exists to fix: pan is the sine of the bearing,
    // so a source dead ahead and one dead behind pan identically. Without a
    // second cue the player cannot tell an approach from an ambush.
    const ahead = at(0)!;
    const behind = at(Math.PI)!;
    assert.ok(ahead && behind, 'both should be audible at this range');

    assert.ok(Math.abs(ahead.pan - behind.pan) < 0.01, 'pan genuinely cannot separate them');
    assert.ok(
      behind.cutoff < ahead.cutoff * 0.65,
      `so timbre must: behind ${Math.round(behind.cutoff)} Hz vs ahead ${Math.round(ahead.cutoff)} Hz`,
    );
    assert.ok(behind.gain < ahead.gain, 'and the head shadows it slightly');
  });

  test('pan follows the bearing and picks the correct side', () => {
    assert.ok(Math.abs(at(0)!.pan) < 0.01, 'dead ahead is centred');
    assert.ok(at(Math.PI / 2)!.pan > 0.95, 'ninety degrees clockwise is hard right');
    assert.ok(at(-Math.PI / 2)!.pan < -0.95, 'and anticlockwise is hard left');
  });

  test('facing reports the front-back axis for the HUD', () => {
    assert.ok(at(0)!.facing > 0.99, 'ahead');
    assert.ok(at(Math.PI)!.facing < -0.99, 'behind');
    assert.ok(Math.abs(at(Math.PI / 2)!.facing) < 0.01, 'abeam');
  });

  test('the listener turning moves the sound, not the world', () => {
    // A shot to the player's right must move to the left ear when they turn to
    // face it - the bearing is relative, and getting that backwards would make
    // turning towards a threat feel like turning away.
    const source = { x: 0, y: 12 };
    const facingAhead = spatialise(listener(0), source.x, source.y, 40, 0)!;
    const facingIt = spatialise(listener(Math.PI / 2), source.x, source.y, 40, 0)!;
    assert.ok(facingAhead.pan > 0.9, 'to the right while facing +x');
    assert.ok(Math.abs(facingIt.pan) < 0.05, 'and centred once the player faces it');
    assert.ok(facingIt.facing > 0.95, 'and reported as ahead');
  });

  test('distance costs level and brightness', () => {
    const near = at(0, 4)!;
    const far = at(0, 30)!;
    assert.ok(far.gain < near.gain, 'further is quieter');
    assert.ok(far.cutoff < near.cutoff, 'and duller - air eats the high end');
  });

  test('walls muffle without silencing', () => {
    const clear = spatialise(listener(), 12, 0, 40, 0)!;
    const walled = spatialise(listener(), 12, 0, 40, 0.9)!;
    assert.ok(walled.gain < clear.gain * 0.5, 'a wall should cost most of the level');
    assert.ok(walled.cutoff < clear.cutoff * 0.5, 'and most of the high end');
    assert.ok(walled.gain > 0, 'but a muffled shot is still information');
  });

  test('sound beyond its range is dropped rather than played silently', () => {
    assert.equal(spatialise(listener(), 500, 0, 40, 0), null);
  });

  test('deafness attenuates everything without breaking placement', () => {
    const deaf: ListenerState = { x: 0, y: 0, angle: 0, hearingFactor: 1, deafness: 0.8 };
    const normal = spatialise(listener(), 0, 12, 40, 0)!;
    const stunned = spatialise(deaf, 0, 12, 40, 0)!;
    assert.ok(stunned.gain < normal.gain * 0.4, 'a blast should cost hearing');
    assert.ok(Math.abs(stunned.pan - normal.pan) < 0.01, 'but not which way it came from');
  });

  test('every field stays inside its range at any bearing and distance', () => {
    for (let b = -Math.PI; b <= Math.PI; b += 0.21) {
      for (const d of [0.5, 3, 12, 40]) {
        const r = at(b, d);
        if (!r) continue;
        assert.ok(r.gain > 0 && r.gain <= 1.5, `gain ${r.gain} at bearing ${b}`);
        assert.ok(r.pan >= -1 && r.pan <= 1, `pan ${r.pan} at bearing ${b}`);
        assert.ok(r.cutoff >= 200 && r.cutoff <= 16000, `cutoff ${r.cutoff}`);
        assert.ok(r.facing >= -1.001 && r.facing <= 1.001, `facing ${r.facing}`);
      }
    }
  });
});

describe('Risk and reward', () => {
  /**
   * The loop the whole game is built on: deeper means richer means more
   * dangerous. Every part of that runs off `zone.danger`, so these check the
   * chain actually holds on generated maps rather than only in principle.
   */
  const maps = MAP_BLUEPRINTS.map((bp) => generateMap(bp, 20250805));

  test('every map offers a real spread of danger, not one flat rating', () => {
    for (const gen of maps) {
      const dangers = gen.map.zones.map((z) => z.danger);
      assert.ok(dangers.length >= 3, `${gen.blueprintId} has too few zones to choose between`);
      const spread = Math.max(...dangers) - Math.min(...dangers);
      assert.ok(
        spread > 0.3,
        `${gen.blueprintId} zones run ${Math.min(...dangers)}..${Math.max(...dangers)} - ` +
          `too flat for the player to be choosing anything`,
      );
    }
  });

  test('there is somewhere safe to start and somewhere worth the risk', () => {
    for (const gen of maps) {
      const dangers = gen.map.zones.map((z) => z.danger);
      assert.ok(Math.min(...dangers) <= 0.3, `${gen.blueprintId} has no low-risk band to get bearings in`);
      assert.ok(Math.max(...dangers) >= 0.7, `${gen.blueprintId} has no high-value core to push for`);
    }
  });

  test('danger buys better loot', () => {
    // Sampled rather than asserted per-container: the roll is random, so the
    // claim is about the distribution, and a single draw proves nothing.
    //
    // A table the game actually ships, not one invented here. A fabricated
    // table tests the sampler against itself; this tests the loot the player
    // will really open.
    const table = LOOT_TABLES.weapon_crate ?? Object.values(LOOT_TABLES)[0];
    const loot = new LootSystem(4242);

    const valueAt = (danger: number): number => {
      let total = 0;
      for (let i = 0; i < 220; i++) {
        const container = loot.createContainer(table, 5, 5, danger);
        for (const slot of container.grid.slots) total += stackValue(slot.stack);
      }
      return total;
    };

    const quiet = valueAt(0.15);
    const hot = valueAt(0.95);
    assert.ok(
      hot > quiet * 1.25,
      `high-danger zones must pay measurably better (quiet ${quiet}, hot ${hot})`,
    );
  });

  test('danger also buys trouble', () => {
    // The valuable ground has to be the crowded ground. That is the sentence
    // the whole loop rests on, and it took three attempts to state in a way
    // that measures it rather than something adjacent.
    //
    // Not a hot-versus-calm bucket split: the zones overlap by design - the
    // outer ring covers the entire map and every building sits inside it - so
    // thresholding dropped mid-danger buildings into the "calm" pile, and the
    // buckets moved as soon as a blueprint asked for more buildings. It was
    // measuring the zone table's shape, not the spawner.
    //
    // Not mean danger under all spawns either. Three quarters of any location
    // is low-danger open ground, so that average is dominated by ground nobody
    // is arguing about and moves by five per cent when the effect is real.
    //
    // The top-value zone's share of hostiles against its share of walkable
    // ground is the question as a player would put it: is the good stuff
    // guarded? Pooled over eight seeds, because a single raid has fourteen to
    // twenty-two hostiles across five to nine zones and per-zone counts run
    // 0, 2, 0, 6 - real bias, useless sample.
    for (const bp of MAP_BLUEPRINTS) {
      let topGround = 0;
      let ground = 0;
      let topSpawns = 0;
      let spawns = 0;

      for (let seed = 1; seed <= 8; seed++) {
        const gen = generateMap(bp, seed);
        const map = gen.map;
        const top = Math.max(...map.zones.map((z) => z.danger));
        const isTop = (x: number, y: number): boolean =>
          (map.zoneAt(Math.floor(x), Math.floor(y))?.danger ?? 0) >= top - 1e-6;

        for (let y = 1; y < map.height - 1; y++) {
          for (let x = 1; x < map.width - 1; x++) {
            if (map.isSolid(x, y)) continue;
            ground++;
            if (isTop(x, y)) topGround++;
          }
        }
        for (const spawn of gen.aiSpawns) {
          spawns++;
          if (isTop(spawn.x, spawn.y)) topSpawns++;
        }
      }

      const groundShare = topGround / Math.max(1, ground);
      const spawnShare = topSpawns / Math.max(1, spawns);
      const concentration = spawnShare / Math.max(1e-9, groundShare);

      assert.ok(
        concentration > 1.4,
        `${bp.id}: the most valuable zone should be guarded - it holds ` +
          `${(groundShare * 100).toFixed(1)} % of the walkable ground but only ` +
          `${(spawnShare * 100).toFixed(1)} % of ${spawns} hostiles ` +
          `(${concentration.toFixed(2)}x, wanted > 1.4x)`,
      );
    }
  });
});

describe('The extraction loop', () => {
  /**
   * The one thing this genre is named after, and the one path nothing tested.
   *
   * Extraction points were checked for existing and for being reachable, and
   * the browser walkthrough *abandons* the raid rather than leaving through
   * one. So the sequence the whole game is built around - pick something up,
   * carry it to an exit, hold the exit, keep what you carried - had never been
   * run end to end. Every part of it existed; nothing asserted they were
   * joined.
   */

  const stubAudio = () => ({
    listener: { x: 0, y: 0, angle: 0, hearingFactor: 1, deafness: 0 },
    setAmbience: () => {},
    stopAmbience: () => {},
    playThunder: () => {},
    play: () => {},
    applyMuzzleDeafness: () => {},
    update: () => {},
  });

  /**
   * A raid on the smallest, densest map.
   *
   * `invulnerable` defaults on, and the first run of these tests is the reason:
   * standing still in an exit for the hold duration on the Verladehof, with
   * twenty hostiles and no return fire, got the player killed - "Gefallen:
   * Brustdurchschuss". That is the map working exactly as designed, and it is
   * not what these tests are asking about. They ask whether holding an exit
   * extracts you and whether what you carried survives the trip; whether you
   * can survive the Verladehof standing still is a different question with a
   * known answer.
   *
   * The death test below turns it off and kills the player outright, so the
   * losing branch is still covered.
   */
  const deploy = (seed = 11, invulnerable = true) => {
    const bus = new EventBus<Record<string, never>>() as never;
    const profile = new Profile(bus, seed);
    const blueprint = MAP_BLUEPRINTS.find((b) => b.id === 'yard')!;
    const session = new RaidSession(
      bus, profile, stubAudio() as never, blueprint, seed,
    );
    if (invulnerable) {
      (session.player.health as unknown as { applyDamage: () => void }).applyDamage = () => {};
    }
    return { bus, profile, session };
  };

  /**
   * Stand in an exit until it lets you out.
   *
   * Teleporting rather than pathing: this is a test of the extraction rule,
   * not of navigation, and walking there would make it a test of both.
   */
  const holdExtract = (session: RaidSession, extract: { x: number; y: number }): void => {
    for (let i = 0; i < 60 * 40 && session.phase !== 'ended'; i++) {
      session.player.x = extract.x;
      session.player.y = extract.y;
      session.update(1 / 60);
    }
  };

  const freeExtract = (session: RaidSession) =>
    session.generated.extracts.find((e) => !e.condition || e.condition.kind === 'always')!;

  test('standing in an exit long enough ends the raid alive', () => {
    const { session } = deploy();
    const exit = freeExtract(session);
    assert.ok(exit, 'the map has to offer at least one unconditional exit');

    holdExtract(session, exit);

    const result = session.raidResult;
    assert.ok(result, 'holding an extraction should have produced a result');
    assert.equal(result.survived, true, `expected to survive, got: ${result.reason}`);
    assert.equal(result.extractName, exit.name);
    // Specific enough to be about *extraction*. `> 0` was not: hostiles kill
    // each other during the hold, and a single kill satisfied it, so the
    // assertion survived deleting the extraction bonus entirely. The bonus is
    // 600 x the conditions multiplier; the cheapest kill is 120.
    assert.ok(
      result.xpEarned >= 500,
      `extracting should pay its own bonus, not just whatever happened during ` +
        `the hold (earned ${result.xpEarned})`,
    );
  });

  test('leaving the zone cancels the hold - no partial credit', () => {
    const { session } = deploy();
    const exit = freeExtract(session);
    const spawn = session.generated.playerSpawns[0];

    const frames = (n: number, x: number, y: number) => {
      for (let i = 0; i < n && session.phase !== 'ended'; i++) {
        session.player.x = x;
        session.player.y = y;
        session.update(1 / 60);
      }
    };

    // Almost all the way through the hold.
    const almost = Math.max(1, Math.round(exit.holdSeconds * 60) - 20);
    frames(almost, exit.x, exit.y);
    assert.equal(session.phase, 'extracting', 'should be mid-hold at this point');

    // Step out, then come back.
    frames(120, spawn.x, spawn.y);
    assert.notEqual(session.phase, 'ended', 'walking away must not extract you');

    // The discriminating part. If progress had merely paused, those last few
    // frames would finish it; the rule is that it resets, so they must not.
    //
    // My first version of this test only asserted that stepping away did not
    // end the raid - which is true whether progress resets or freezes, because
    // completing requires standing inside either way. It passed against a
    // deliberately broken reset, and measured nothing.
    frames(25, exit.x, exit.y);
    assert.notEqual(
      session.phase, 'ended',
      'returning to the exit must start the hold again, not resume it',
    );

    // And a full hold from that point does work, so this is a reset rather
    // than the exit having become unusable.
    frames(Math.round(exit.holdSeconds * 60) + 30, exit.x, exit.y);
    assert.equal(session.phase, 'ended', 'a complete hold should still extract');
    assert.equal(session.raidResult?.survived, true);
  });

  test('what you carry out reaches the stash', () => {
    // The end of the chain, and the part with the most places to go wrong:
    // raid inventory -> profile loadout -> stash, across two systems and a
    // screen transition.
    const { profile, session } = deploy();
    const before = profile.stash.items().length;

    const prize = createStack('ammo_545_bp', 30);
    assert.ok(session.player.inventory.store(prize), 'the player should have room for it');

    holdExtract(session, freeExtract(session));
    assert.equal(session.raidResult?.survived, true);
    assert.ok(session.raidResult.lootValue > 0, 'carried goods should be valued');

    // The two steps the game shell performs after a raid.
    session.commitToProfile();
    const { overflow } = profile.depositLoadout();
    assert.equal(overflow, 0, 'a nearly empty stash should have room');

    // Ammunition deliberately stays on the rig rather than going to the stash,
    // so the round trip is checked on the loadout for this one.
    const inLoadout = profile.loadout
      .allGrids()
      .some(({ grid }) => grid.items().some((s) => s.defId === 'ammo_545_bp'));
    assert.ok(inLoadout, 'the ammunition carried out should still be on the rig');
    assert.ok(
      profile.stash.items().length >= before,
      'extracting must never shrink the stash',
    );
  });

  test('dying leaves everything behind except the secure container', () => {
    // The other half of risk and reward. If death does not cost the loadout,
    // nothing about extracting is a decision.
    const { profile, session } = deploy(11, false);

    const loose = createStack('ammo_545_bp', 30);
    session.player.inventory.store(loose);
    const carriedBefore = session.player.inventory
      .allGrids()
      .reduce((n, { grid }) => n + grid.items().length, 0);
    assert.ok(carriedBefore > 0, 'the player should be carrying something to lose');

    session.player.health.kill('Test');
    for (let i = 0; i < 240 && session.phase !== 'ended'; i++) session.update(1 / 60);

    const result = session.raidResult;
    assert.ok(result, 'dying should produce a result');
    assert.equal(result.survived, false);
    assert.ok(result.lostValue > 0, 'dying should be recorded as a loss');

    session.commitToProfile();
    const carriedAfter = profile.loadout
      .allGrids()
      .reduce((n, { grid }) => n + grid.items().length, 0);
    assert.ok(
      carriedAfter < carriedBefore,
      `death should strip the loadout (${carriedBefore} -> ${carriedAfter})`,
    );
  });
});

describe('AI behaviour', () => {
  /**
   * Does the AI actually fight, or does it walk at you in a straight line?
   *
   * The state machine has seven states and the code references cover thirty
   * times, but none of that proves anything about behaviour - a machine can
   * have a `reposition` state it never usefully enters. These drive a real
   * enemy against a real map and measure what it does.
   *
   * A corridor with pillars down both sides: a straight charge is available
   * and so is a covered approach, so the choice is the AI's to get wrong.
   */
  const arena = (): TileMap => {
    const map = new TileMap(40, 24);
    map.tiles.fill(Tile.Floor);
    // Walls around the outside.
    for (let x = 0; x < 40; x++) {
      map.tiles[x] = Tile.Concrete;
      map.tiles[23 * 40 + x] = Tile.Concrete;
    }
    for (let y = 0; y < 24; y++) {
      map.tiles[y * 40] = Tile.Concrete;
      map.tiles[y * 40 + 39] = Tile.Concrete;
    }
    // Pillars off the centre line, leaving a clear straight run down the middle.
    for (let x = 8; x < 34; x += 5) {
      for (const y of [8, 15]) {
        map.tiles[y * 40 + x] = Tile.Concrete;
        map.tiles[y * 40 + x + 1] = Tile.Concrete;
      }
    }
    map.lightmap.fill(210); // broad daylight, so nothing is hidden
    return map;
  };

  const runFight = (seconds: number, tier: 'scavenger' | 'guard' | 'contractor') => {
    const map = arena();
    const nav = new NavGrid(map);
    const cover = new CoverMap(map);
    const effects = new EffectSystem(64, 64);
    const ballistics = new BallisticsSystem(bus, effects, 99);

    // Only the fields the AI reads. Cast through `unknown` because a real
    // `Combatant` also carries health and inventory, and neither is consulted
    // on the perception path being measured here.
    const target = {
      id: 1, isPlayer: true, name: 'Ziel',
      x: 4.5, y: 11.5, angle: 0, pitch: 0,
      radius: 0.28, height: 1.8, eyeHeight: 1.62,
      alive: true,
    } as unknown as Combatant;

    const enemy = new Enemy(bus, ballistics, tier, 7);
    // 22 tiles apart. This has to sit inside the tier's sight range or the
    // test measures an enemy that never noticed anything - which is exactly
    // the false negative that cost me an afternoon at 31 tiles.
    enemy.spawn(26.5, 11.5, Math.PI); // dead ahead of the target, facing it

    const path: { x: number; y: number }[] = [];

    const ctx = {
      map, nav, cover, target,
      targetSpeed: 0, targetStance: 2, targetGlow: 0, sightScale: 1,
      requestPath: (sx: number, sy: number, tx: number, ty: number) =>
        nav.findPath(sx, sy, tx, ty).points ?? null,
      squadEngaged: false,
      alertSquad: () => {},
      elapsed: 0,
    };

    const dt = 1 / 30;
    for (let i = 0; i < seconds * 30; i++) {
      ctx.elapsed = i * dt;
      enemy.update(dt, ctx as never);
      path.push({ x: enemy.x, y: enemy.y });
    }
    return { enemy, path, cover, map };
  };

  test('an alerted enemy does not simply walk down the middle at you', () => {
    // The specific failure the brief names: "NPC sieht Spieler, rennt geradeaus
    // auf Spieler zu". The straight line here is y = 11.5, and taking it means
    // crossing the whole arena in the open.
    const { path } = runFight(14, 'guard');
    const deviation = Math.max(...path.map((p) => Math.abs(p.y - 11.5)));
    assert.ok(
      deviation > 0.9,
      `the enemy stayed within ${deviation.toFixed(2)} tiles of the straight ` +
        `line to the target - that is a charge, not a fight`,
    );
  });

  test('it closes the distance rather than milling about', () => {
    const { path } = runFight(14, 'guard');
    const start = path[0].x;
    const end = path[path.length - 1].x;
    assert.ok(end < start - 2, `should have advanced (from x=${start} to x=${end})`);
  });

  test('it ends up somewhere sheltered rather than in the open', () => {
    const { path, cover, map } = runFight(14, 'contractor');
    // Average shelter over the second half of the fight, against the arena's
    // own average - a fair comparison, since this map is mostly open by design.
    const half = path.slice(Math.floor(path.length / 2));
    const shelterAt = (x: number, y: number): number =>
      cover.score[Math.floor(y) * map.width + Math.floor(x)] ?? 0;
    const taken = half.reduce((sum, p) => sum + shelterAt(p.x, p.y), 0) / half.length;

    let total = 0;
    let count = 0;
    for (let y = 1; y < 23; y++) {
      for (let x = 1; x < 39; x++) {
        if (map.isSolid(x, y)) continue;
        total += cover.score[y * map.width + x];
        count++;
      }
    }
    const average = total / count;
    assert.ok(
      taken > average,
      `the enemy should prefer sheltered ground (took ${taken.toFixed(1)}, arena average ${average.toFixed(1)})`,
    );
  });

  test('it engages rather than staring', () => {
    const { enemy } = runFight(14, 'guard');
    assert.notEqual(enemy.state, 'idle', 'a guard with a clear view should not still be idle');
    assert.notEqual(enemy.state, 'patrol', 'nor still be patrolling');
  });

  test('a scavenger breaks off when badly hurt', () => {
    const map = arena();
    const nav = new NavGrid(map);
    const cover = new CoverMap(map);
    const effects = new EffectSystem(64, 64);
    const ballistics = new BallisticsSystem(bus, effects, 99);
    const target = {
      id: 1, isPlayer: true, name: 'Ziel', x: 4.5, y: 11.5, angle: 0, pitch: 0,
      radius: 0.28, height: 1.8, eyeHeight: 1.62, alive: true,
    } as unknown as Combatant;

    const enemy = new Enemy(bus, ballistics, 'scavenger', 3);
    enemy.spawn(20.5, 11.5, Math.PI);
    const ctx = {
      map, nav, cover, target, targetSpeed: 0, targetStance: 2, targetGlow: 0,
      sightScale: 1,
      requestPath: (sx: number, sy: number, tx: number, ty: number) =>
        nav.findPath(sx, sy, tx, ty).points ?? null,
      squadEngaged: false, alertSquad: () => {}, elapsed: 0,
    };

    // Let it notice the target, then wound it badly.
    for (let i = 0; i < 90; i++) enemy.update(1 / 30, ctx as never);
    for (const part of Object.values(enemy.health.parts)) part.hp = part.max * 0.12;
    for (let i = 0; i < 120; i++) {
      ctx.elapsed = (90 + i) / 30;
      enemy.update(1 / 30, ctx as never);
    }

    assert.equal(enemy.state, 'flee', `a badly wounded scavenger should break off, was ${enemy.state}`);
  });
});
