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
import {
  chamberFromMagazine,
  cycleRound,
  loadMagazine,
  resolveWeapon,
  totalRounds,
} from '../src/weapons/WeaponRuntime';
import { LootSystem } from '../src/loot/LootSystem';
import { Progression } from '../src/meta/Progression';
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
