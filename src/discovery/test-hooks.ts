/**
 * Test-only registration hooks for the discovery module.
 *
 * NOT exported from the module index — production code can never use these;
 * tests import them directly. They let a suite register a concrete stub
 * provider for runner/scheduler tests and read honest registry state.
 * Mirrors src/integrations/test-hooks.ts.
 */
import { buildDiscoveryRegistry } from './registry';
import type { DiscoveryProvider } from './providers';

/** Register a concrete (stub) provider for a registry under test. */
export async function createTestDiscoveryRegistry(provider: DiscoveryProvider) {
  return buildDiscoveryRegistry({ providerInstance: provider });
}

export { buildDiscoveryRegistry };
export type { DiscoveryProvider };