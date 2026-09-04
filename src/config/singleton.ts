/**
 * App-wide shared SettingsService + typed accessors singleton.
 *
 * Kept in its own module so lifecycle/scoring config readers can import the
 * singleton without pulling the config index (which re-exports the Fastify
 * routes) into non-server code paths.
 */
import { SettingsService } from './service';
import { createSettingsAccessors, type SettingsAccessors } from './accessors';

export const settingsService = new SettingsService();
export const settings: SettingsAccessors = createSettingsAccessors(settingsService);