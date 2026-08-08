/**
 * EventBus - typed publish/subscribe used to decouple systems.
 *
 * Rule of thumb in this codebase: simulation systems never call UI directly.
 * They emit events; the UI/audio layers subscribe. That keeps the gameplay
 * layer engine-agnostic, which is exactly what the Unity port needs.
 *
 * Emission is allocation-free for the common case and safe against listeners
 * that subscribe/unsubscribe during dispatch.
 */
export type Listener<T> = (payload: T) => void;

export class EventBus<Events extends object> {
  private handlers = new Map<keyof Events, Set<Listener<never>>>();
  /** Snapshot buffer reused during dispatch so mutation mid-emit is safe. */
  private dispatchBuffer: Listener<never>[] = [];

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(fn as Listener<never>);
    return () => this.off(event, fn);
  }

  /** Subscribe for exactly one emission. */
  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
    this.handlers.get(event)?.delete(fn as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    // Copy into a reusable buffer: a listener may unsubscribe itself or others.
    const buf = this.dispatchBuffer;
    buf.length = 0;
    for (const fn of set) buf.push(fn);
    for (let i = 0; i < buf.length; i++) {
      try {
        (buf[i] as Listener<Events[K]>)(payload);
      } catch (err) {
        console.error(`[EventBus] listener for "${String(event)}" threw:`, err);
      }
    }
    buf.length = 0;
  }

  clear(): void {
    this.handlers.clear();
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
