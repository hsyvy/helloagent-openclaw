/**
 * TTL + LRU dedup for inbound messages.
 *
 * The relay re-delivers undelivered messages on WebSocket reconnect, so a
 * brief disconnect can produce duplicates. Without dedup, the agent would
 * dispatch the same inbound twice, sending the user two replies.
 *
 *   - `tryRecord(messageId, accountId)` returns false if the (id, account)
 *     pair was seen recently. Returns true (and records) on first sight.
 *   - Entries expire after `ttlMs` (default 5 min) or when the cache passes
 *     `maxEntries` (default 5000) — whichever happens first.
 *
 * The class is intentionally simple — no clock injection, no async — because
 * the hot path runs once per inbound message and must be cheap.
 */
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;

export type DedupOptions = {
  ttlMs?: number;
  maxEntries?: number;
};

type Entry = { expiresAt: number };

export class MessageDedup {
  readonly ttlMs: number;
  readonly maxEntries: number;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: DedupOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Returns true on first sight of (messageId, accountId). Subsequent calls
   * within `ttlMs` return false.
   */
  tryRecord(messageId: string, accountId: string): boolean {
    const key = `${accountId}:${messageId}`;
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      // Refresh by re-inserting so the LRU eviction still tracks recency.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return false;
    }

    this.entries.set(key, { expiresAt: now + this.ttlMs });
    this.maybeEvict(now);
    return true;
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private maybeEvict(now: number): void {
    if (this.entries.size <= this.maxEntries) return;
    // Remove expired first.
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    // If still over capacity, drop oldest insertion-order entries (Map keeps order).
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Coarse expiry check on the inbound message timestamp itself. The relay
 * shouldn't re-deliver messages older than this; if it does, treat them as
 * stale (e.g. server clock skew, retention bug).
 */
const MAX_INBOUND_AGE_MS = 10 * 60 * 1000;

export function isMessageExpired(timestampMs: number | undefined): boolean {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return false;
  return Date.now() - timestampMs > MAX_INBOUND_AGE_MS;
}
