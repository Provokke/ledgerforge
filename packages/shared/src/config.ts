// Tiny env helpers. Fail loudly on a bad value instead of limping along.
export function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing env var ${name}`);
}

export function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`env var ${name} must be an integer, got "${v}"`);
  return n;
}

export interface BaseConfig {
  service: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  amqpUrl: string;
}

export function baseConfig(service: string, defaultPort: number): BaseConfig {
  return {
    service,
    port: int("PORT", defaultPort),
    logLevel: str("LOG_LEVEL", "info"),
    databaseUrl: str("DATABASE_URL", "postgres://ledgerforge:ledgerforge@127.0.0.1:5432/ledgerforge"),
    redisUrl: str("REDIS_URL", "redis://127.0.0.1:6379"),
    amqpUrl: str("AMQP_URL", "amqp://ledgerforge:ledgerforge@127.0.0.1:5672"),
  };
}
