/**
 * Ids - monotonic integer handles for actors, containers and items.
 *
 * Integer handles (rather than object references) let systems store references
 * in typed arrays, serialize cheaply, and detect stale references after an
 * entity is destroyed.
 */
let actorSeq = 1;
let itemSeq = 1;
let containerSeq = 1;

export function nextActorId(): number {
  return actorSeq++;
}

export function nextItemId(): number {
  return itemSeq++;
}

export function nextContainerId(): number {
  return containerSeq++;
}

/** Restored after loading a save so new ids never collide with persisted ones. */
export function primeIdCounters(actor: number, item: number, container: number): void {
  actorSeq = Math.max(actorSeq, actor);
  itemSeq = Math.max(itemSeq, item);
  containerSeq = Math.max(containerSeq, container);
}

export function snapshotIdCounters(): { actor: number; item: number; container: number } {
  return { actor: actorSeq, item: itemSeq, container: containerSeq };
}

/** Reserved id meaning "world / environment / no actor". */
export const WORLD_ACTOR_ID = 0;
