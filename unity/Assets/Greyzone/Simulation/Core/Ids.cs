namespace Greyzone.Simulation.Core
{
    /// <summary>
    /// Monotonic integer handles for actors, items and containers.
    /// </summary>
    /// <remarks>
    /// Integer handles rather than object references let systems store
    /// references in flat arrays, serialise cheaply, and detect a stale
    /// reference after an entity is destroyed.
    ///
    /// The counters must be primed after loading a save, or freshly created
    /// items collide with persisted ones and inventory operations silently
    /// target the wrong stack.
    /// </remarks>
    public static class Ids
    {
        /// <summary>Reserved id meaning "world / environment / no actor".</summary>
        public const int WorldActorId = 0;

        private static int _actorSeq = 1;
        private static int _itemSeq = 1;
        private static int _containerSeq = 1;

        private static readonly object Gate = new object();

        public static int NextActorId()
        {
            lock (Gate) return _actorSeq++;
        }

        public static int NextItemId()
        {
            lock (Gate) return _itemSeq++;
        }

        public static int NextContainerId()
        {
            lock (Gate) return _containerSeq++;
        }

        /// <summary>Raises the counters so new ids never collide with loaded ones.</summary>
        public static void Prime(int actor, int item, int container)
        {
            lock (Gate)
            {
                if (actor > _actorSeq) _actorSeq = actor;
                if (item > _itemSeq) _itemSeq = item;
                if (container > _containerSeq) _containerSeq = container;
            }
        }

        public static void Snapshot(out int actor, out int item, out int container)
        {
            lock (Gate)
            {
                actor = _actorSeq;
                item = _itemSeq;
                container = _containerSeq;
            }
        }

        /// <summary>Resets the counters. For tests and for starting a new profile.</summary>
        public static void Reset()
        {
            lock (Gate)
            {
                _actorSeq = 1;
                _itemSeq = 1;
                _containerSeq = 1;
            }
        }
    }
}
