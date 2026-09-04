/**
 * Test-only registration hooks for the integrations module.
 *
 * NOT exported from the module index — production code can never use these;
 * tests import them directly (vite resolves them at test time). They let a
 * suite register a concrete stub provider through a temp registry and read
 * that registry's honest `configured`/`requiresConfiguration` state.
 */
import type { IntegrationModuleId, ProviderFor } from './types';
import { IntegrationRegistry } from './registry';

/** Build a registry with concrete (stub) providers under test. */
export function createTestRegistry(
  providers: Partial<{
    enrichment: ProviderFor<'enrichment'>;
    email: ProviderFor<'email'>;
    demo_hosting: ProviderFor<'demo_hosting'>;
    deployment: ProviderFor<'deployment'>;
  }>,
): IntegrationRegistry {
  return new IntegrationRegistry(providers);
}

export { IntegrationRegistry };
export type { IntegrationModuleId, ProviderFor };