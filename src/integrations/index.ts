/**
 * Integrations module public surface.
 *
 * - types: provider contracts + payload types (EnrichmentProvider,
 *   EmailProvider, DemoHostingProvider, DeploymentProvider, ModuleStatus, …)
 * - not-configured: NotConfiguredError + the throwing provider factory
 * - registry: IntegrationRegistry — module → active provider, honest status
 * - routes: registerIntegrationsRoutes(app) — GET /api/integrations/status
 *
 * Design rules (brief 7, master spec "no fake integrations"):
 *  - No network calls anywhere in this module — it is pure interface +
 *    registry + honest status.
 *  - An external service with no credentials exists only as an interface plus
 *    an explicit requires-configuration marker.
 *  - Module boundary: this module never touches the lead lifecycle and never
 *    mutates businesses.
 */
export * from './types';
export * from './not-configured';
export * from './registry';
export * from './routes';