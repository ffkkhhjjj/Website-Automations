/**
 * NotConfiguredProvider — the ONLY provider served for a module until a real
 * provider is implemented, selected in settings, and has credentials in env.
 *
 * Every method THROWS a clear "requires configuration: <env vars>" error —
 * by design there is no "local stub that answers" anywhere in this module:
 * a pipeline that calls an unconfigured integration FAILS LOUDLY instead of
 * silently pretending the work happened (master spec: no fake integrations).
 */
import type {
  EnrichmentProvider,
  EmailProvider,
  DemoHostingProvider,
  DeploymentProvider,
  IntegrationModuleId,
} from './types';

/** The one runtime error an unconfigured module produces. */
export class NotConfiguredError extends Error {
  constructor(module: IntegrationModuleId, envVars: readonly string[]) {
    super(
      `integration "${module}" requires configuration: ${envVars.join(', ')} ` +
      `are not set and no provider is implemented/selected yet`,
    );
    this.name = 'NotConfiguredError';
  }
}

/** Factory for the module-specific not-configured provider. */
export function notConfiguredProviderFor(
  module: IntegrationModuleId,
  envVars: readonly string[],
): EnrichmentProvider & EmailProvider & DemoHostingProvider & DeploymentProvider {
  const throwNotConfigured = (): Promise<never> =>
    Promise.reject(new NotConfiguredError(module, envVars));

  return {
    name: `not-configured:${module}`,

    // EnrichmentProvider
    enrich: throwNotConfigured,

    // EmailProvider
    send: throwNotConfigured,

    // DemoHostingProvider
    publishDemo: throwNotConfigured,
    recordView: throwNotConfigured,

    // DeploymentProvider
    deploy: throwNotConfigured,
  };
}