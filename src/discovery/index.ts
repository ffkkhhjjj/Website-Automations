/**
 * Discovery module — public surface (brief 8A core).
 *
 * Deterministic TS only; no network calls. The real data source is a swappable
 * provider selected by `integrations.discovery.provider` in Settings; until one
 * is configured the registry serves NoneProvider, whose search() THROWS
 * (requires-configuration, never fake data).
 */
export * from './types';
export * from './normalize';
export * from './dedup';
export * from './providers';
export * from './registry';
export * from './ingest';
export * from './runner';
export * from './scheduler';