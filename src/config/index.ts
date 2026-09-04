/**
 * Configuration module — typed SettingsService + typed accessors + the
 * authenticated config API and shared defaults.
 *
 * Public surface:
 *   - SettingsService / SettingsError / SettingRow / UpdateSettingInput
 *   - createSettingsAccessors() + `settings` (app-wide singleton accessors)
 *   - registerConfigRoutes() — Fastify plugin for GET/PUT /api/settings
 *   - defaults / validation helpers (re-exported for tooling)
 */
export * from './service';
export * from './accessors';
export * from './defaults';
export * from './validation';
export * from './routes';
export * from './singleton';