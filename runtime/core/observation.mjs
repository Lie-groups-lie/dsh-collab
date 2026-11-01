// Observation-only batching. Never use this cache to admit tools, budgets or writes.
export function createReadBatcher({ ttlMs = 750, maxEntries = 8, now = Date.now } = {}) {
  const cache = new Map(), flights = new Map();
  let epoch = 0;
  return {
    clear() { epoch++; cache.clear(); flights.clear(); },
    async read(key, load) {
      const cached = cache.get(key);
      if (cached && cached.until > now()) return cached.value;
      if (flights.has(key)) return flights.get(key);
      const generation = epoch;
      const flight = Promise.resolve().then(load).then((value) => {
        if (generation === epoch) {
          cache.delete(key); cache.set(key, { value, until: now() + ttlMs });
          while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        }
        return value;
      }).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
      flights.set(key, flight);
      return flight;
    },
  };
}
