/**
 * Lead lifecycle module — the deterministic state machine that routes every
 * lead through the platform's pipeline.
 *
 * Public surface (import from this index or the individual files):
 *  - transitions: LEAD_TRANSITIONS (single source of truth), canTransition,
 *    legalTargets, TERMINAL_STATES, isTerminal
 *  - transition(): atomic state change (state + history + audit, one tx)
 *  - reject(): atomic rejection with recorded reasons (REJECTED / DO_NOT_CONTACT)
 *  - evaluateRejectionRules(): pure deterministic rule evaluator (inputs +
 *    config thresholds, no DB)
 *  - helpers: VALID_STATES, isActiveForOutreach, canShowDemo, getCurrentState, ...
 *  - config: threshold readers backed by system_settings with spec defaults
 *  - types: LeadState, RejectionReason, LeadLifecycleError, InvalidTransitionError
 */
export * from './types.js';
export * from './transitions.js';
export * from './helpers.js';
export * from './config.js';
export * from './rejection-rules.js';
export * from './transition-service.js';
export * from './rejection-service.js';