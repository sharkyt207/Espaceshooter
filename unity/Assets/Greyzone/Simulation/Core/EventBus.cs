using System;
using System.Collections.Generic;

namespace Greyzone.Simulation.Core
{
    /// <summary>
    /// Typed publish/subscribe used to decouple simulation from presentation.
    /// </summary>
    /// <remarks>
    /// The rule this class exists to enforce: simulation code never calls the
    /// renderer, the UI or the audio mixer. It publishes a message; those layers
    /// subscribe. That is what keeps the simulation assembly free of
    /// UnityEngine references and testable without the Editor.
    ///
    /// Messages are structs carrying primitives and ids, never live object
    /// references, so a subscriber cannot reach back into simulation state and
    /// mutate it, and every message stays trivially serialisable for telemetry
    /// or replay.
    ///
    /// Dispatch copies the handler list first, so a subscriber may unsubscribe
    /// itself - or anyone else - from inside its own callback.
    /// </remarks>
    public sealed class EventBus
    {
        private readonly Dictionary<Type, object> _handlers = new Dictionary<Type, object>();

        private sealed class HandlerList<T>
        {
            public readonly List<Action<T>> Handlers = new List<Action<T>>();
            // Reused during dispatch so a publish allocates nothing.
            public readonly List<Action<T>> Dispatch = new List<Action<T>>();
        }

        /// <summary>Subscribes and returns a disposer that unsubscribes.</summary>
        public Action Subscribe<T>(Action<T> handler)
        {
            if (handler == null) throw new ArgumentNullException(nameof(handler));
            var list = GetOrCreate<T>();
            list.Handlers.Add(handler);
            return () => Unsubscribe(handler);
        }

        /// <summary>Subscribes for exactly one message.</summary>
        public Action SubscribeOnce<T>(Action<T> handler)
        {
            Action off = null;
            Action<T> wrapper = payload =>
            {
                off?.Invoke();
                handler(payload);
            };
            off = Subscribe(wrapper);
            return off;
        }

        public void Unsubscribe<T>(Action<T> handler)
        {
            if (_handlers.TryGetValue(typeof(T), out object boxed))
            {
                ((HandlerList<T>)boxed).Handlers.Remove(handler);
            }
        }

        public void Publish<T>(T payload)
        {
            if (!_handlers.TryGetValue(typeof(T), out object boxed)) return;
            var list = (HandlerList<T>)boxed;
            if (list.Handlers.Count == 0) return;

            var buffer = list.Dispatch;
            buffer.Clear();
            buffer.AddRange(list.Handlers);

            for (int i = 0; i < buffer.Count; i++)
            {
                try
                {
                    buffer[i](payload);
                }
                catch (Exception e)
                {
                    // One broken listener must not stop the rest of the frame.
                    // Reported rather than swallowed, and never rethrown into
                    // the simulation that published it.
                    OnHandlerError?.Invoke(typeof(T), e);
                }
            }
            buffer.Clear();
        }

        /// <summary>
        /// Raised when a subscriber throws. Wire this to the log in a
        /// presentation layer; the simulation deliberately has no logger.
        /// </summary>
        public event Action<Type, Exception> OnHandlerError;

        public int HandlerCount<T>()
            => _handlers.TryGetValue(typeof(T), out object boxed) ? ((HandlerList<T>)boxed).Handlers.Count : 0;

        public void Clear() => _handlers.Clear();

        private HandlerList<T> GetOrCreate<T>()
        {
            if (!_handlers.TryGetValue(typeof(T), out object boxed))
            {
                boxed = new HandlerList<T>();
                _handlers[typeof(T)] = boxed;
            }
            return (HandlerList<T>)boxed;
        }
    }
}
