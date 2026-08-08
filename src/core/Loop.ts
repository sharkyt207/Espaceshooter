/**
 * Loop - fixed-timestep simulation with decoupled rendering.
 *
 * Why fixed timestep: ballistics, recoil and AI reaction timers must behave
 * identically on a 60Hz phone and a 120Hz tablet. We tick simulation at a
 * constant rate and render as fast as the device allows, interpolating with
 * the leftover `alpha`.
 *
 * The loop also owns the adaptive performance governor: if we consistently
 * miss frame budget, it lowers the render scale (see PerfGovernor) rather than
 * dropping simulation accuracy.
 */

export interface LoopStats {
  /** Smoothed frames per second. */
  fps: number;
  /** Smoothed milliseconds spent inside update(). */
  simMs: number;
  /** Smoothed milliseconds spent inside render(). */
  renderMs: number;
  /** Simulation ticks executed on the last frame (>1 means we were behind). */
  ticks: number;
}

export interface LoopOptions {
  /** Simulation rate in Hz. 60 keeps parity with Unity's default FixedUpdate feel. */
  tickRate?: number;
  /** Hard cap on catch-up ticks per frame so a stall cannot spiral. */
  maxTicksPerFrame?: number;
  update: (dt: number) => void;
  render: (alpha: number, dt: number) => void;
}

export class Loop {
  readonly tickRate: number;
  readonly fixedDt: number;
  private readonly maxTicks: number;
  private readonly updateFn: (dt: number) => void;
  private readonly renderFn: (alpha: number, dt: number) => void;

  private running = false;
  private rafId = 0;
  private lastTime = 0;
  private accumulator = 0;

  readonly stats: LoopStats = { fps: 0, simMs: 0, renderMs: 0, ticks: 0 };

  /** Wall-clock seconds of simulated time since start (pauses excluded). */
  elapsed = 0;

  // There was a `timeScale` here, documented as "0 = paused, used by menus and
  // the death screen". Nothing ever assigned it, and nothing should have: the
  // world deliberately keeps running while a menu is open, because looting
  // under a running raid clock is the tension the whole loop is built on. A
  // knob that cannot be turned, described as being turned by two screens that
  // do not turn it, is worse than no knob - it is the kind of comment that
  // makes a reader stop looking for the bug.

  constructor(opts: LoopOptions) {
    this.tickRate = opts.tickRate ?? 60;
    this.fixedDt = 1 / this.tickRate;
    this.maxTicks = opts.maxTicksPerFrame ?? 5;
    this.updateFn = opts.update;
    this.renderFn = opts.render;
    this.frame = this.frame.bind(this);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** Call when the app is backgrounded/foregrounded so we do not fast-forward. */
  resetTiming(): void {
    this.lastTime = performance.now();
    this.accumulator = 0;
  }

  private frame(now: number): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    // Clamp the real delta: a backgrounded tab can hand us multi-second gaps.
    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (frameTime > 0.25) frameTime = 0.25;

    const fpsSample = frameTime > 0 ? 1 / frameTime : 0;
    this.stats.fps += (fpsSample - this.stats.fps) * 0.05;

    this.accumulator += frameTime;

    let ticks = 0;
    const simStart = performance.now();
    while (this.accumulator >= this.fixedDt && ticks < this.maxTicks) {
      this.updateFn(this.fixedDt);
      this.elapsed += this.fixedDt;
      this.accumulator -= this.fixedDt;
      ticks++;
    }
    // We ran out of catch-up budget: drop the backlog instead of death-spiralling.
    if (ticks >= this.maxTicks) this.accumulator = 0;
    const simMs = performance.now() - simStart;
    this.stats.simMs += (simMs - this.stats.simMs) * 0.1;
    this.stats.ticks = ticks;

    const alpha = this.accumulator / this.fixedDt;
    const renderStart = performance.now();
    this.renderFn(alpha, frameTime);
    const renderMs = performance.now() - renderStart;
    this.stats.renderMs += (renderMs - this.stats.renderMs) * 0.1;
  }
}

/**
 * PerfGovernor - keeps the frame budget by scaling internal render resolution.
 *
 * Mobile GPUs vary wildly. Rather than shipping a fixed resolution, we measure
 * actual frame cost and walk the render scale up/down between bounds. Changes
 * are hysteretic and rate-limited so the image never visibly pulses.
 */
export class PerfGovernor {
  private readonly targetMs: number;
  private readonly minScale: number;
  private readonly maxScale: number;
  private cooldown = 0;
  private overBudgetStreak = 0;
  private underBudgetStreak = 0;

  scale: number;

  constructor(targetFps = 60, startScale = 0.85, minScale = 0.45, maxScale = 1) {
    this.targetMs = 1000 / targetFps;
    this.scale = startScale;
    this.minScale = minScale;
    this.maxScale = maxScale;
  }

  /**
   * Feed the measured cost of the last frame. Returns true when the scale
   * changed and buffers need resizing.
   */
  sample(frameMs: number, dt: number): boolean {
    this.cooldown -= dt;
    if (this.cooldown > 0) return false;

    // 15% headroom before we react; avoids fighting normal frame jitter.
    if (frameMs > this.targetMs * 1.15) {
      this.overBudgetStreak++;
      this.underBudgetStreak = 0;
    } else if (frameMs < this.targetMs * 0.7) {
      this.underBudgetStreak++;
      this.overBudgetStreak = 0;
    } else {
      this.overBudgetStreak = 0;
      this.underBudgetStreak = 0;
      return false;
    }

    // Asymmetric on purpose: drop resolution quickly when we are missing
    // frames (the player feels that immediately), and creep back up slowly
    // (a resolution that oscillates is more distracting than one that is
    // slightly too low). The step down is also larger than the step up.
    if (this.overBudgetStreak >= 8 && this.scale > this.minScale) {
      // Fall harder the further over budget we are, so a device that is
      // badly overcommitted reaches a playable scale in a second or two
      // instead of walking down in eight small steps.
      const severity = frameMs > this.targetMs * 1.8 ? 0.16 : 0.08;
      this.scale = Math.max(this.minScale, this.scale - severity);
      this.overBudgetStreak = 0;
      this.cooldown = 0.6;
      return true;
    }
    if (this.underBudgetStreak >= 110 && this.scale < this.maxScale) {
      this.scale = Math.min(this.maxScale, this.scale + 0.05);
      this.underBudgetStreak = 0;
      this.cooldown = 3.0;
      return true;
    }
    return false;
  }
}
