import { Pool } from '../core/Pool';
import { fxRng } from '../core/Random';
import type { SpriteRenderer } from './SpriteRenderer';
import type { TileMap } from '../world/TileMap';

/**
 * Effects - pooled 3D particles, tracers and impact decals.
 *
 * Everything here is cosmetic and driven by the cosmetic RNG stream, so dialling
 * particle counts down for performance can never change simulation outcomes.
 *
 * Particles carry a real 3D position and velocity (x, y on the ground plane,
 * z upward in tile units) and integrate against gravity and drag. Sparks
 * bounce, casings tumble to the floor, smoke rises and expands - the physical
 * behaviour is what makes placeholder art read as grounded.
 */

export const enum ParticleKind {
  Blood = 0,
  Spark = 1,
  Smoke = 2,
  Dust = 3,
  Casing = 4,
  Tracer = 5,
  Ember = 6,
}

interface Particle {
  alive: boolean;
  kind: ParticleKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  color: number;
  gravity: number;
  drag: number;
  /** Sparks and casings bounce; smoke does not. */
  bounce: number;
  additive: boolean;
}

function newParticle(): Particle {
  return {
    alive: false, kind: ParticleKind.Dust, x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 0.05,
    color: 0xffffff, gravity: 0, drag: 0, bounce: 0, additive: false,
  };
}

function resetParticle(p: Particle): void {
  p.alive = false;
}

export interface Decal {
  x: number;
  y: number;
  /** Height on the wall in tile units, or 0 for floor decals. */
  z: number;
  size: number;
  color: number;
  life: number;
  maxLife: number;
}

export class EffectSystem {
  private particles: Pool<Particle>;
  private decals: Decal[] = [];
  private readonly maxDecals: number;

  /** Additive flash intensity at the camera, consumed by the raycaster. */
  flash = 0;
  /** Screen shake state, consumed by the camera each frame. */
  shakeAmount = 0;
  private shakeTime = 0;

  /** Scales all particle counts. Lowered by the performance governor. */
  quality = 1;

  constructor(maxParticles = 420, maxDecals = 96) {
    this.particles = new Pool(newParticle, resetParticle, maxParticles);
    this.maxDecals = maxDecals;
  }

  clear(): void {
    this.particles.releaseAll();
    this.decals.length = 0;
    this.flash = 0;
    this.shakeAmount = 0;
  }

  update(dt: number, map: TileMap): void {
    // Flash decays fast: a muzzle flash is a few milliseconds of real light.
    this.flash = Math.max(0, this.flash - dt * 9);
    if (this.shakeTime > 0) {
      this.shakeTime -= dt;
      if (this.shakeTime <= 0) this.shakeAmount = 0;
    }

    for (let i = this.particles.active - 1; i >= 0; i--) {
      const p = this.particles.get(i);
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.releaseAt(i);
        continue;
      }

      p.vz -= p.gravity * dt;
      if (p.drag > 0) {
        const k = Math.max(0, 1 - p.drag * dt);
        p.vx *= k;
        p.vy *= k;
        p.vz *= k;
      }

      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;
      p.z += p.vz * dt;

      // Wall collision: reflect or stop. Keeps debris inside the level.
      if (map.isSolidAt(nx, p.y)) {
        p.vx = -p.vx * p.bounce;
      } else {
        p.x = nx;
      }
      if (map.isSolidAt(p.x, ny)) {
        p.vy = -p.vy * p.bounce;
      } else {
        p.y = ny;
      }

      if (p.z <= 0.01) {
        p.z = 0.01;
        if (p.bounce > 0 && Math.abs(p.vz) > 0.3) {
          p.vz = -p.vz * p.bounce;
          p.vx *= 0.6;
          p.vy *= 0.6;
        } else {
          p.vz = 0;
          p.vx *= 0.82;
          p.vy *= 0.82;
        }
      }

      if (p.kind === ParticleKind.Smoke) {
        // Smoke expands and slows as it dissipates.
        p.size += dt * 0.35;
      }
    }

    for (let i = this.decals.length - 1; i >= 0; i--) {
      this.decals[i].life -= dt;
      if (this.decals[i].life <= 0) this.decals.splice(i, 1);
    }
  }

  /** Push every live particle and decal into the sprite queue. */
  submit(sprites: SpriteRenderer): void {
    for (let i = 0; i < this.particles.active; i++) {
      const p = this.particles.get(i);
      const t = p.life / p.maxLife;
      let alpha = t;
      if (p.kind === ParticleKind.Smoke) alpha = t * 0.42;
      else if (p.kind === ParticleKind.Spark || p.kind === ParticleKind.Ember) alpha = t * t;
      else if (p.kind === ParticleKind.Tracer) alpha = Math.min(1, t * 2.2);
      sprites.submitParticle(p.x, p.y, p.z, p.size, p.color, alpha, p.additive);
    }
    for (let i = 0; i < this.decals.length; i++) {
      const d = this.decals[i];
      const t = Math.min(1, d.life / Math.min(d.maxLife, 3));
      sprites.submitParticle(d.x, d.y, d.z, d.size, d.color, t * 0.7, false);
    }
  }

  private spawn(kind: ParticleKind, x: number, y: number, z: number): Particle | null {
    const p = this.particles.acquire();
    if (!p) return null;
    p.alive = true;
    p.kind = kind;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.additive = false;
    p.bounce = 0;
    p.drag = 0;
    p.gravity = 0;
    return p;
  }

  private scaled(n: number): number {
    return Math.max(1, Math.round(n * this.quality));
  }

  // --- authored effects ----------------------------------------------------

  /** Blood spray from a hit, thrown along the bullet's direction of travel. */
  bloodSpray(x: number, y: number, z: number, dirX: number, dirY: number, severity: number): void {
    const n = this.scaled(4 + severity * 8);
    for (let i = 0; i < n; i++) {
      const p = this.spawn(ParticleKind.Blood, x, y, z);
      if (!p) return;
      const spread = 0.7;
      p.vx = dirX * fxRng.range(1.5, 4.5) + fxRng.gaussian(0, spread);
      p.vy = dirY * fxRng.range(1.5, 4.5) + fxRng.gaussian(0, spread);
      p.vz = fxRng.range(0.4, 2.2);
      p.gravity = 6.5;
      p.drag = 1.2;
      p.bounce = 0.1;
      p.size = fxRng.range(0.018, 0.05);
      p.maxLife = p.life = fxRng.range(0.4, 0.95);
      // Arterial red, darkening slightly per particle.
      const v = fxRng.range(0.7, 1);
      p.color = ((14 * v) << 16) | ((16 * v) << 8) | (150 * v);
    }
    this.addDecal(x + dirX * 0.1, y + dirY * 0.1, 0.02, fxRng.range(0.12, 0.3), 0x000c0e78, 26);
  }

  /** Sparks and dust when a round strikes a hard surface. */
  bulletImpact(x: number, y: number, z: number, nx: number, ny: number, hard: boolean): void {
    const sparkCount = hard ? this.scaled(5) : this.scaled(2);
    for (let i = 0; i < sparkCount; i++) {
      const p = this.spawn(ParticleKind.Spark, x, y, z);
      if (!p) break;
      p.vx = nx * fxRng.range(0.5, 3) + fxRng.gaussian(0, 1.4);
      p.vy = ny * fxRng.range(0.5, 3) + fxRng.gaussian(0, 1.4);
      p.vz = fxRng.range(0.5, 3);
      p.gravity = 7;
      p.drag = 2.2;
      p.bounce = 0.35;
      p.size = fxRng.range(0.012, 0.03);
      p.maxLife = p.life = fxRng.range(0.16, 0.42);
      p.color = 0x40b0ff; // ABGR: hot orange-white
      p.additive = true;
    }
    const dustCount = this.scaled(3);
    for (let i = 0; i < dustCount; i++) {
      const p = this.spawn(ParticleKind.Dust, x, y, z);
      if (!p) break;
      p.vx = nx * fxRng.range(0.2, 1) + fxRng.gaussian(0, 0.5);
      p.vy = ny * fxRng.range(0.2, 1) + fxRng.gaussian(0, 0.5);
      p.vz = fxRng.range(0.2, 1);
      p.gravity = 1.2;
      p.drag = 2.8;
      p.size = fxRng.range(0.05, 0.12);
      p.maxLife = p.life = fxRng.range(0.35, 0.8);
      p.color = 0x9aa5b0;
    }
    this.addDecal(x, y, z, fxRng.range(0.05, 0.1), 0x00202020, 30);
  }

  /** Muzzle smoke and the light contribution of a shot. */
  muzzleBlast(x: number, y: number, z: number, dirX: number, dirY: number, suppressed: boolean): void {
    this.flash = Math.min(1.4, this.flash + (suppressed ? 0.18 : 0.75));
    const n = this.scaled(suppressed ? 2 : 4);
    for (let i = 0; i < n; i++) {
      const p = this.spawn(ParticleKind.Smoke, x + dirX * 0.25, y + dirY * 0.25, z);
      if (!p) break;
      p.vx = dirX * fxRng.range(0.8, 2.4) + fxRng.gaussian(0, 0.35);
      p.vy = dirY * fxRng.range(0.8, 2.4) + fxRng.gaussian(0, 0.35);
      p.vz = fxRng.range(0.15, 0.6);
      p.gravity = -0.25; // smoke rises
      p.drag = 2.6;
      p.size = fxRng.range(0.06, 0.14);
      p.maxLife = p.life = fxRng.range(0.5, 1.3);
      p.color = 0xa8a8a0;
    }
    if (!suppressed) {
      const flashP = this.spawn(ParticleKind.Ember, x + dirX * 0.3, y + dirY * 0.3, z);
      if (flashP) {
        p_configureFlash(flashP);
      }
    }
  }

  /** Ejected brass, thrown to the shooter's right and tumbling to the floor. */
  ejectCasing(x: number, y: number, z: number, dirX: number, dirY: number): void {
    const p = this.spawn(ParticleKind.Casing, x, y, z);
    if (!p) return;
    // Right vector relative to the firing direction.
    const rx = -dirY;
    const ry = dirX;
    p.vx = rx * fxRng.range(1.4, 2.8) + dirX * 0.3;
    p.vy = ry * fxRng.range(1.4, 2.8) + dirY * 0.3;
    p.vz = fxRng.range(1.0, 2.0);
    p.gravity = 8.5;
    p.drag = 0.6;
    p.bounce = 0.42;
    p.size = 0.022;
    p.maxLife = p.life = fxRng.range(2.2, 3.4);
    p.color = 0x2f9fd8; // brass, ABGR
  }

  /**
   * Tracer: a short bright streak advancing along the bullet path.
   * Only a fraction of rounds are tracers, matching real belt loading.
   */
  tracer(x: number, y: number, z: number, dirX: number, dirY: number, speed: number): void {
    const p = this.spawn(ParticleKind.Tracer, x, y, z);
    if (!p) return;
    p.vx = dirX * speed;
    p.vy = dirY * speed;
    p.vz = 0;
    p.gravity = 0.4;
    p.drag = 0;
    p.size = 0.035;
    p.maxLife = p.life = 0.35;
    p.color = 0x50c8ff;
    p.additive = true;
  }

  explosion(x: number, y: number, z: number, power: number): void {
    this.flash = Math.min(2, this.flash + power);
    this.shake(power * 0.9, 0.5);
    const n = this.scaled(14 * power);
    for (let i = 0; i < n; i++) {
      const p = this.spawn(ParticleKind.Ember, x, y, z);
      if (!p) break;
      const a = fxRng.range(0, Math.PI * 2);
      const s = fxRng.range(1, 7) * power;
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s;
      p.vz = fxRng.range(0.5, 4) * power;
      p.gravity = 6;
      p.drag = 1.6;
      p.bounce = 0.2;
      p.size = fxRng.range(0.04, 0.12);
      p.maxLife = p.life = fxRng.range(0.3, 0.9);
      p.color = 0x30a0ff;
      p.additive = true;
    }
    for (let i = 0; i < this.scaled(10 * power); i++) {
      const p = this.spawn(ParticleKind.Smoke, x, y, z);
      if (!p) break;
      const a = fxRng.range(0, Math.PI * 2);
      p.vx = Math.cos(a) * fxRng.range(0.4, 2.4);
      p.vy = Math.sin(a) * fxRng.range(0.4, 2.4);
      p.vz = fxRng.range(0.6, 2.2);
      p.gravity = -0.4;
      p.drag = 1.4;
      p.size = fxRng.range(0.12, 0.28);
      p.maxLife = p.life = fxRng.range(1.2, 2.6);
      p.color = 0x64686c;
    }
  }

  shake(amount: number, duration: number): void {
    // Take the stronger of the current and requested shake so a big hit is not
    // softened by a small one that is already running.
    this.shakeAmount = Math.max(this.shakeAmount, amount);
    this.shakeTime = Math.max(this.shakeTime, duration);
  }

  private addDecal(x: number, y: number, z: number, size: number, color: number, life: number): void {
    if (this.decals.length >= this.maxDecals) this.decals.shift();
    this.decals.push({ x, y, z, size, color: color & 0xffffff, life, maxLife: life });
  }
}

/** Configures the short-lived bright core of a muzzle flash. */
function p_configureFlash(p: Particle): void {
  p.vx = 0;
  p.vy = 0;
  p.vz = 0;
  p.size = 0.16;
  p.maxLife = p.life = 0.05;
  p.color = 0x90e0ff;
  p.additive = true;
}
