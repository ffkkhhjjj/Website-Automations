/**
 * Owner dashboard payload types.
 *
 * Every metric in the overview is computed from real tables (see service.ts).
 * Metrics with no data source yet (revenue, MRR, demo views) are returned as
 * honest zeros with an explicit `countsMeta` note — never fabricated numbers.
 */

export interface HotLead {
  businessId: string;
  businessName: string;
  city: string | null;
  state: string | null;
  websiteUrl: string | null;
  leadPriorityScore: number | null;
  websiteQualityScore: number | null;
  lifecycleState: 'HOT' | 'INTERESTED';
  latestReplySnippet: string | null;
  intent: string | null; // reply_classification e.g. 'INTERESTED'
  confidence: number | null; // 0..1
  suggestedAction: string;
  demoUrl: string | null;
}

export interface OverviewCounts {
  leadsFound: number; // businesses ever discovered
  leadsQualified: number; // lifecycle QUALIFIED or beyond
  demosCreated: number; // demos rows
  emailsSent: number; // outreach_messages status SENT
  replies: number; // inbound conversation_messages
  interested: number; // lifecycle INTERESTED or HOT
  sales: number; // WON/CUSTOMER businesses or customers without a business link
  revenue: number; // 0 until the connected finance account is wired (platform not live)
  mrr: number; // 0 until billing/subscriptions are wired (platform not live)
  demoViews: number; // 0 until demo hosting analytics are wired
  emailBounces: number; // outreach_messages status BOUNCED
  unsubscribes: number; // outreach_messages status OPTED_OUT
  systemErrors: number; // open exceptions with priority CRITICAL or HIGH
}

/** Honest provenance for metrics that have no data source yet. */
export interface MetricMeta {
  value: number;
  wired: boolean;
  source: string;
}

export interface CountsMeta {
  revenue: MetricMeta;
  mrr: MetricMeta;
  demoViews: MetricMeta;
}

export interface TodayActivityItem {
  type: string; // action (audit) or task type
  entityType: string;
  entity: string; // human-readable entity reference
  time: string; // ISO timestamp
}

export interface DashboardException {
  id: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  category: string;
  message: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
}

export interface Health {
  serverUp: boolean;
  dbReachable: boolean;
  tasksByStatus: Record<string, number>;
  taskIssues: string[];
  lastAuditAt: string | null;
}

export interface OverviewPayload {
  generatedAt: string;
  hotLeads: HotLead[];
  counts: OverviewCounts;
  countsMeta: CountsMeta;
  todayActivity: TodayActivityItem[];
  exceptions: DashboardException[];
  health: Health;
}