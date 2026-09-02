/**
 * Scoring engines module.
 *
 * Public surface (import from this index or the individual files):
 *  - scoreBusiness(): orchestrator — runs the full chain (WSQ → BOS → Lead
 *    Priority), persists website_analyses + ONE lead_scores row + audit, and
 *    never touches lifecycle state
 *  - analyzeWebsite() / scoreNoWebsite(): pure website quality engine
 *  - runTechnicalChecks(): deterministic technical checks with evidence
 *  - AiSubjectiveEvaluator interface + DeterministicFallbackEvaluator:
 *    AI-ready subjective evaluation; the deterministic fallback keeps the
 *    pipeline functional with zero AI (no fake integrations)
 *  - scoreOpportunity(): deterministic business opportunity engine
 *  - scoreLeadPriority() / classifyLeadPriority(): weighted priority + bands
 *  - config: weight/threshold readers (system_settings + scoring_versions)
 */
export * from './types.js';
export * from './config.js';
export * from './website-input.js';
export * from './website-checks.js';
export * from './subjective.js';
export * from './website-quality.js';
export * from './business-opportunity.js';
export * from './lead-priority.js';
export * from './orchestrator.js';