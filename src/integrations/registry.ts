/**
 * Integrations registry — the single seam between platform code and external
 * services.
 *
 *   - Maps each module (enrichment, email, demo_hosting, deployment) to the
 *     ACTIVE provider instance used by the rest of the codebase.
 *   - Provider selection comes from system_settings (`integrations.<module>.
 *     provider`), seeded to "none" — see src/db/seed-settings.ts and
 *     src/config/defaults.ts.
 *   - With "none" (or any unselected/unknown value) the module serves
 *     NotConfiguredProvider, whose methods THROW. Configured state is derived
 *     ONLY from a real provider being registered AND its env credentials being
 *     present — never from a stub (no fake integrations).
 *
 * Tests can register a concrete stub provider through the in-test hook
 * `registerIntegrationProviderForTesting` (not exported from the module index,
 * so production code can't accidentally use it).
 */
import { settingsService } from '../config/singleton';
import { DEFAULT_INTEGRATION_PROVIDERS } from '../config/defaults';
import {
  INTEGRATION_PROVIDER_NONE,
  INTEGRATION_SETTING_KEYS,
  MODULE_ENV_VARS,
  type IntegrationModuleId,
  type IntegrationProviderId,
  type ModuleStatus,
  type ProviderFor,
} from './types';
import { notConfiguredProviderFor, NotConfiguredError } from './not-configured';

/** Concrete provider implementations by module. Real vendors land here later. */
export interface ProviderRegistry {
  enrichment: ProviderFor<'enrichment'>;
  email: ProviderFor<'email'>;
  demo_hosting: ProviderFor<'demo_hosting'>;
  deployment: ProviderFor<'deployment'>;
}

/** One registry instance per app. Tests construct their own via the factory. */
export class IntegrationRegistry {
  private readonly providers: ProviderRegistry;

  constructor(providers?: Partial<ProviderRegistry>) {
    this.providers = {
      enrichment: providers?.enrichment ?? notConfiguredProviderFor('enrichment', MODULE_ENV_VARS.enrichment),
      email: providers?.email ?? notConfiguredProviderFor('email', MODULE_ENV_VARS.email),
      demo_hosting:
        providers?.demo_hosting ?? notConfiguredProviderFor('demo_hosting', MODULE_ENV_VARS.demo_hosting),
      deployment:
        providers?.deployment ?? notConfiguredProviderFor('deployment', MODULE_ENV_VARS.deployment),
    };
  }

  /** The ACTIVE provider for a module (throws NotConfigured on use if unset). */
  get<M extends IntegrationModuleId>(module: M): ProviderFor<M> {
    return this.providers[module] as ProviderFor<M>;
  }

  /**
   * Honest per-module state for the status endpoint, derived from:
   *  - the settings value (provider selection), and
   *  - env presence for that module's documented credential names.
   * A module is `configured: true` ONLY when a real provider is registered
   * (registry unit tests / future vendor wiring) AND its env vars are present.
   * NotConfiguredProvider can never be configured.
   */
  async status(module: IntegrationModuleId): Promise<ModuleStatus> {
    const envVars = MODULE_ENV_VARS[module] as readonly string[];
    const hasEnv = envVars.every((k) => {
      const v = process.env[k];
      return typeof v === 'string' && v.trim().length > 0;
    });
    const provider = await this.selectedProvider(module);
    const isRealProvider = provider !== INTEGRATION_PROVIDER_NONE;
    const needsConfig = !(isRealProvider && hasEnv);

    return {
      module,
      provider,
      configured: isRealProvider && hasEnv,
      requiresConfiguration: needsConfig,
      missingEnvVars: needsConfig ? [...envVars] : [],
    };
  }

  /** All modules' status, ordered by the canonical module order. */
  async statusAll(): Promise<ModuleStatus[]> {
    return Promise.all(
      (['enrichment', 'email', 'demo_hosting', 'deployment'] as const).map((m) => this.status(m)),
    );
  }

  /** Settings value for a module; falls back to "none" (never throws). */
  private async selectedProvider(module: IntegrationModuleId): Promise<IntegrationProviderId> {
    const fallback = DEFAULT_INTEGRATION_PROVIDERS[module];
    return settingsService.getParsed<IntegrationProviderId>(
      INTEGRATION_SETTING_KEYS[module],
      (v): v is IntegrationProviderId => typeof v === 'string',
      fallback,
    );
  }
}

export { NotConfiguredError, INTEGRATION_PROVIDER_NONE, MODULE_ENV_VARS };