/**
 * Integration module types — the contracts every external provider must satisfy.
 *
 * No vendor is fixed anywhere: the platform talks to these interfaces only, and
 * later briefs implement them behind a real credential. Until then the registry
 * serves NotConfiguredProvider for every module (see not-configured.ts) whose
 * methods THROW — nothing in this module ever returns fake success.
 *
 * Payload types are deliberately transport-agnostic (plain data) so an SMTP
 * driver, a REST client, or a grpc stub can sit behind the same interface.
 */

/* ----------------------------------------------------------------------------
 * Module taxonomy
 * ------------------------------------------------------------------------- */

/** The module kinds the registry manages. */
export type IntegrationModuleId =
  | 'enrichment'
  | 'email'
  | 'demo_hosting'
  | 'deployment';

// (WebsiteQaProvider is intentionally NOT a registry module: QA is a
// deterministic in-repo pipeline and remains so — see README "Scope decisions".)

/** Label used on the wire (status endpoint) for a module. */
export interface IntegrationModuleMeta {
  id: IntegrationModuleId;
  /** Stable wire label, e.g. 'email'. */
  label: string;
}

/* ----------------------------------------------------------------------------
 * Enrichment
 * ------------------------------------------------------------------------- */

/** Identifying keys the enrichment provider may look a business up by. */
export interface EnrichmentInput {
  businessName: string;
  websiteUrl?: string | null;
  city?: string | null;
  state?: string | null;
}

/**
 * Fields an enrichment provider MAY return. Only fields actually found are
 * populated — providers never fabricate, and callers must treat absent fields
 * as "not found" (not "no value").
 */
export interface EnrichmentOutput {
  /** Primary public phone number (E.164 preferred). */
  phone?: string | null;
  /** Email published by the business (or clearly referenced publicly). */
  email?: string | null;
  /** Star rating from a public review source (0–5). */
  rating?: number | null;
  /** Review count from a public review source. */
  reviewCount?: number | null;
  /** Decision-maker name if publicly identifiable. */
  decisionMakerName?: string | null;
  /** Decision-maker title if publicly identifiable. */
  decisionMakerTitle?: string | null;
  /** Which public source produced each field (e.g. 'google_maps'). */
  source?: string | null;
}

/* ----------------------------------------------------------------------------
 * Email
 * ------------------------------------------------------------------------- */

/** A tracked outbound message. */
export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  /** Opaque reference the platform attaches (e.g. outreach message uuid). */
  reference?: string | null;
  /** Per-recipient opt-out token so providers can render an unsubscribe link. */
  unsubscribeToken?: string | null;
}

/** Delivery statuses aligned with the platform's message_status enum. */
export type EmailDeliveryStatus =
  | 'SENT'
  | 'BOUNCED'
  | 'COMPLAINED'
  | 'OPTED_OUT'
  | 'FAILED';

export interface EmailSendResult {
  ok: boolean;
  /** Real service-side message id — REQUIRED on success (never fabricated). */
  messageId?: string;
  /** Current delivery status (webhooks update it later via the pipeline). */
  status: EmailDeliveryStatus;
  /** Human-readable failure reason (invalid recipient, quota, provider 4xx…). */
  error?: string | null;
}

/* ----------------------------------------------------------------------------
 * Demo hosting
 * ------------------------------------------------------------------------- */

export interface DemoPublishInput {
  /** Slug to derive the unique subdomain/path from (stable per business). */
  slug: string;
  /** Files to publish (relative path → content). HTML entry: `index.html`. */
  files: Record<string, string>;
}

export interface DemoPublishResult {
  ok: boolean;
  /** Unique public demo URL (per publish; never reused/rewritten). */
  url?: string;
  error?: string | null;
}

export interface DemoViewRecord {
  ok: boolean;
  error?: string | null;
}

/* ----------------------------------------------------------------------------
 * Deployment
 * ------------------------------------------------------------------------- */

export interface DeploymentInput {
  /** Unique site key (e.g. customer/business uuid) for the public host path. */
  siteKey: string;
  /** Files to deploy (relative path → content). HTML entry: `index.html`. */
  files: Record<string, string>;
}

export interface DeploymentResult {
  ok: boolean;
  /** Canonical public URL of the deployed production site. */
  url?: string;
  error?: string | null;
}

/* ----------------------------------------------------------------------------
 * Provider interfaces
 * ------------------------------------------------------------------------- */

/**
 * EnrichmentProvider — merges public-source data into a business record.
 *
 * Contract: return only fields actually found in legitimate public sources;
 * never invent contact info, ratings, or names. Absent field = not found.
 */
export interface EnrichmentProvider {
  readonly name: string;
  enrich(input: EnrichmentInput): Promise<EnrichmentOutput>;
}

/**
 * EmailProvider — sends ONE tracked outbound message.
 *
 * Contract: async; on success returns a real service-side messageId (a fake
 * id is a fake integration) and status SENT; on failure returns ok:false with
 * a reason — it must never silently "succeed".
 */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * DemoHostingProvider — publishes a demo site to a UNIQUE url (one publish =
 * one distinct URL, so links never collide or silently reuse an old site).
 */
export interface DemoHostingProvider {
  readonly name: string;
  publishDemo(input: DemoPublishInput): Promise<DemoPublishResult>;
  /** Optional: record a view on a previously published demo url. */
  recordView(demoUrl: string): Promise<DemoViewRecord>;
}

/**
 * DeploymentProvider — deploys a production website and returns the public URL.
 */
export interface DeploymentProvider {
  readonly name: string;
  deploy(input: DeploymentInput): Promise<DeploymentResult>;
}

/**
 * Every provider the registry can hold implements at least one of these.
 * A provider for module `M` must implement `ProviderFor<M>`.
 */
export type ProviderFor<M extends IntegrationModuleId> =
  M extends 'enrichment' ? EnrichmentProvider :
  M extends 'email' ? EmailProvider :
  M extends 'demo_hosting' ? DemoHostingProvider :
  M extends 'deployment' ? DeploymentProvider :
  never;

/* ----------------------------------------------------------------------------
 * Selection / configuration state (source of truth: system_settings + env)
 * ------------------------------------------------------------------------- */

/**
 * Value of the `integrations.<module>.provider` setting. "none" (the seeded
 * default) means the module is unselected and uses NotConfiguredProvider.
 * Future vendor ids land here as real providers are implemented.
 */
export const INTEGRATION_PROVIDER_NONE = 'none';
export type IntegrationProviderId = typeof INTEGRATION_PROVIDER_NONE | string;

/** Settings keys per module (seeded in src/db/seed-settings.ts). */
export const INTEGRATION_SETTING_KEYS: Record<IntegrationModuleId, string> = {
  enrichment: 'integrations.enrichment.provider',
  email: 'integrations.email.provider',
  demo_hosting: 'integrations.demo_hosting.provider',
  deployment: 'integrations.deployment.provider',
};

// Provider selection defaults live in src/config/defaults.ts
// (DEFAULT_INTEGRATION_PROVIDERS) — single source of truth for config-shaped rules.

/** The env vars a real provider for this module needs (documented, README table). */
export const MODULE_ENV_VARS: Record<IntegrationModuleId, readonly string[]> = {
  enrichment: ['ENRICHMENT_API_KEY'],
  email: ['EMAIL_API_KEY'],
  demo_hosting: ['DEMO_HOSTING_API_KEY'],
  deployment: ['DEPLOYMENT_API_KEY'],
};

/** Selection state the registry computes (and the status endpoint exposes). */
export interface ModuleStatus {
  module: IntegrationModuleId;
  /** Settings value: "none" or a future vendor id. */
  provider: IntegrationProviderId;
  /**
   * true only when a REAL provider is selected AND its credentials exist in
   * env. Never true for a stub, a partially configured provider, or "none".
   */
  configured: boolean;
  /** true until a real provider for this module is wired. */
  requiresConfiguration: boolean;
  /** Env vars the (future) provider would need, in order. */
  missingEnvVars: string[];
}