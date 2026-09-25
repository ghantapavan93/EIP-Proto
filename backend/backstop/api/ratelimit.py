"""In-process token buckets, per user.

Enough for one prototype process behind a tunnel: it stops a pasted-text loop
from flooding the audit log or queueing a laptop GPU. Several workers or hosts
would need a shared store (Redis) instead; that is deliberately not built.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable


class TokenBucket:
    def __init__(self, capacity: int, per_seconds: float, clock: Callable[[], float] = time.monotonic):
        self.capacity = float(capacity)
        self.rate = capacity / per_seconds  # tokens per second
        self._clock = clock
        self._state: dict[str, tuple[float, float]] = {}  # key -> (tokens, last refill)
        self._lock = threading.Lock()

    def take(self, key: str) -> float:
        """Spend one token for `key`. Returns 0.0 when allowed, else seconds until one is available."""
        now = self._clock()
        with self._lock:
            if len(self._state) > 10_000:
                self._state.clear()
            tokens, last = self._state.get(key, (self.capacity, now))
            tokens = min(self.capacity, tokens + (now - last) * self.rate)
            if tokens >= 1.0:
                self._state[key] = (tokens - 1.0, now)
                return 0.0
            self._state[key] = (tokens, now)
            return (1.0 - tokens) / self.rate

    def reset(self) -> None:
        with self._lock:
            self._state.clear()
