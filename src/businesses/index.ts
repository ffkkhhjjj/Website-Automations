/**
 * Businesses module public surface.
 * - service: listBusinesses(), getBusinessDetail() — real-table reads
 * - routes: registerBusinessesRoutes(app) — list/detail/lifecycle API
 * - types: payload shapes
 */
export * from './types';
export * from './service';
export * from './routes';
