/**
 * Discovery registry — settings-driven provider selection, mirroring
 * src/integrations/registry.ts but kept self-contained for this brief.
 *
 *   - provider selection comes from system_settings `integrations.discovery.provider`
 *     (seeded default "none");
 *   - with "none" (or any vendor id that has no registered implementation) the
 *     registry serves NoneProvider, whose search() THROWS NotConfiguredError;
 *   - `configured` is derived ONLY from an explicitly selected non-"none"
 *     provider (settings value or test-seam override) AND its env credential
 *     (DISCOVERY_API_KEY) being present — a stub instance alone, with the
 *     settings still on "none", is never configured (no fake integrations).
 *
 * Tests can register a concrete stub provider through the in-test hook
 * `registerDiscoveryProviderForTesting` (src/discovery/test-hooks.ts, not
 * exported from the module index).
 */
import { settingsService } from '../config/singleton';
import { DEFAULT_DISCOVERY_PROVIDER } from '../config/defaults';
import { NoneProvider, DISCOVERY_ENV_VARS, DISCOVERY_PROVIDER_NONE } from './providers';
import type { DiscoveryProvider } from './providers';

/** Settings key for discovery provider selection. */
export const DISCOVERY_SETTING_KEY = 'integrations.discovery.provider';

/** Env credential presence check (same semantics as integrations registry). */
export function hasDiscoveryEnv(): boolean {
  const v = process.env.DISCOVERY_API_KEY;
  return typeof v === 'string' && v.trim().length > 0;
}

/** Honest discovery-module state (mirrors integrations ModuleStatus). */
export interface DiscoveryRegistry {
  /** Settings value: "none" or a future vendor id. */
  provider: string;
  /** The active provider instance used by the pipeline. */
  providerInstance: DiscoveryProvider;
  /** true ONLY when a real provider is registered AND DISCOVERY_API_KEY exists. */
  configured: boolean;
  /** true until a real provider for discovery is wired. */
  requiresConfiguration: boolean;
  /** Env vars the (future) provider would need. */
  missingEnvVars: string[];
}

interface Options {
  /** Test seam: a concrete (stub) provider registered under test. */
  providerInstance?: DiscoveryProvider;
  /** Test seam: override the settings value (defaults to the DB setting). */
  providerId?: string;
}

/**
 * Build the registry for the current settings value.
 *
 * configured semantics: a registry is configured ONLY when a non-"none"
 * provider is selected (explicit providerId override or the settings value)
 * AND a non-NoneProvider instance is registered AND its env credential is
 * present. With "none" selected, it serves NoneProvider — search() throws.
 * This keeps the "no fake integrations" rule: an env key alone, or an
 * instance alone with selection still on "none", is never enough.
 */
export async function buildDiscoveryRegistry(opts: Options = {}): Promise<DiscoveryRegistry> {
  const providerId =
    opts.providerId ??
    (await settingsService.getParsed<string>(
      DISCOVERY_SETTING_KEY,
      (v): v is string => typeof v === 'string',
      DEFAULT_DISCOVERY_PROVIDER,
    ));
  const instance = opts.providerInstance ?? new NoneProvider();
  // Both halves required: a non-"none" provider must be SELECTED (explicit
  // override wins over settings) and its env credential must be present. A
  // stub instance alone, with selection still on "none", stays unconfigured.
  const configured =
    providerId !== DISCOVERY_PROVIDER_NONE &&
    instance.id !== DISCOVERY_PROVIDER_NONE &&
    hasDiscoveryEnv();

  return {
    provider: providerId,
    providerInstance: instance,
    configured,
    requiresConfiguration: !configured,
    missingEnvVars: configured ? [] : [...DISCOVERY_ENV_VARS],
  };
}

export { DISCOVERY_ENV_VARS, DISCOVERY_PROVIDER_NONE } from './providers';
export type { DiscoveryProvider } from './providers';
export { NotConfiguredError } from './providers';