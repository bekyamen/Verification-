/**
 * verifyCache.ts
 *
 * Lightweight in-process cache for bank verification results and registered
 * accounts.  Two goals:
 *
 *  1. Avoid hitting the bank API twice for the same receipt reference.
 *  2. Coalesce simultaneous requests for the same reference into one upstream
 *     call (the second caller awaits the same Promise the first caller created).
 *
 * Design decisions
 * ─────────────────
 * • Only successful results are cached.  Failures are never stored so a retry
 *   always goes upstream.
 * • The DB duplicate-check in processVerification still runs on every request —
 *   a cache hit only skips the HTTP call to the bank.
 * • Single-process only.  If you run PM2 cluster mode you need Redis instead.
 */

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class VerifyCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private inflight = new Map<string, Promise<T | null>>();
  private readonly ttlMs: number;

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1_000;
  }

  /** Return a cached value or null if absent / expired. */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  /** Store a successful result. */
  set(key: string, value: T): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Remove a key (e.g. after an invalidation event). */
  delete(key: string): void {
    this.cache.delete(key);
    this.inflight.delete(key);
  }

  /**
   * Coalescing wrapper.
   *
   * If a result is already cached → return it immediately.
   * If a request for this key is already in-flight → await that same Promise.
   * Otherwise → call `fn`, cache the result on success, then return it.
   *
   * `fn` must return `null` on failure (do NOT throw from inside it).
   */
  async getOrFetch(key: string, fn: () => Promise<T | null>): Promise<T | null> {
    // Cache hit
    const cached = this.get(key);
    if (cached !== null) return cached;

    // In-flight coalescing
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = fn().then((result) => {
      this.inflight.delete(key);
      if (result !== null) this.set(key, result);
      return result;
    }).catch((err) => {
      this.inflight.delete(key);
      throw err;
    });

    this.inflight.set(key, promise);
    return promise;
  }
}

// ── Singleton caches ──────────────────────────────────────────────────────────

import type { VerifyResult } from '../services/verifyCBE';
import type { TelebirrReceipt } from '../services/verifyTelebirr';
import type { BankSettlementAccount } from '@prisma/client';

/** CBE results — keyed by canonical reference string, TTL 10 min */
export const cbeCache = new VerifyCache<VerifyResult>(10 * 60);

/** Telebirr results — keyed by receipt ref, TTL 10 min */
export const telebirrCache = new VerifyCache<TelebirrReceipt>(10 * 60);

/** Registered accounts per branchId — TTL 60 s */
export const accountsCache = new VerifyCache<BankSettlementAccount[]>(60);
