using System;

namespace Greyzone.Simulation.Core
{
    /// <summary>
    /// Fixed-capacity object pool.
    /// </summary>
    /// <remarks>
    /// Garbage-collector pauses are the single biggest cause of frame spikes on
    /// mobile. Bullets, particles, casings, decals and sound events all come
    /// from pools with a hard ceiling, so steady-state gameplay allocates
    /// nothing at all.
    ///
    /// Live objects occupy indices <c>0 .. Active-1</c>. Release swaps with the
    /// last live element, so callers iterating to release must walk
    /// <b>backwards</b> or the swap will skip an entry.
    /// </remarks>
    public sealed class Pool<T> where T : class
    {
        private readonly T[] _items;
        private readonly Action<T> _reset;
        private int _cursor;

        public Pool(Func<T> factory, Action<T> reset, int capacity)
        {
            if (factory == null) throw new ArgumentNullException(nameof(factory));
            _reset = reset ?? throw new ArgumentNullException(nameof(reset));
            _items = new T[capacity];
            for (int i = 0; i < capacity; i++) _items[i] = factory();
        }

        /// <summary>Takes an object, or null when the pool is exhausted.</summary>
        public T Acquire() => _cursor >= _items.Length ? null : _items[_cursor++];

        /// <summary>
        /// Takes an object, recycling the oldest live one when exhausted.
        /// </summary>
        /// <remarks>
        /// Correct for purely cosmetic effects, where replacing the oldest
        /// particle looks better than dropping the newest.
        /// </remarks>
        public T AcquireForced()
        {
            T item = Acquire();
            if (item != null) return item;
            T recycled = _items[0];
            _reset(recycled);
            return recycled;
        }

        public void ReleaseAt(int index)
        {
            int last = _cursor - 1;
            if (index < 0 || index > last) return;
            T tmp = _items[index];
            _items[index] = _items[last];
            _items[last] = tmp;
            _reset(tmp);
            _cursor--;
        }

        public void ReleaseAll()
        {
            for (int i = 0; i < _cursor; i++) _reset(_items[i]);
            _cursor = 0;
        }

        /// <summary>Number of live objects; iterate <c>0 .. Active-1</c> via <see cref="Get"/>.</summary>
        public int Active => _cursor;

        public int Capacity => _items.Length;

        public T Get(int index) => _items[index];
    }
}
