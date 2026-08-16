import { Redis } from "ioredis";

export type { Redis };

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 3, enableReadyCheck: true, lazyConnect: false });
}

// Fixed-window limiter in one round trip. INCR plus EXPIRE only on the first
// hit, done in a Lua script so a crash between the two can't leave a key
// that never expires.
const LIMIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}
`;

export interface RateResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export async function rateLimit(r: Redis, key: string, limit: number, windowMs: number): Promise<RateResult> {
  const [n, ttl] = (await r.eval(LIMIT_SCRIPT, 1, `rl:${key}`, windowMs)) as [number, number];
  return { allowed: n <= limit, remaining: Math.max(0, limit - n), resetMs: ttl < 0 ? windowMs : ttl };
}
