/* ===========================================================================
   The shape of GET /api/console/summary, written down.

   `lib/api.ts` returns `Record<string, unknown>` for the summary because it
   refuses to assert a shape it cannot check. This file is where that assertion
   is made ONCE, next to the endpoint's field names, so that every panel reads
   typed data and a rename in api/console/summary.js breaks in one place.

   Every field below exists in api/console/summary.js, api/_lib/events.js or
   api/_lib/callview.js. Nothing is aspirational — if it is not returned, it is
   not here, and the UI does not render it.
   =========================================================================== */

/* --------------------------------------------------------------- wiring */

/** api/_lib/integrations/meta.js › metaStatus(). Booleans, never values. */
export interface MetaWiring {
  appSecret: boolean;
  verifyToken: boolean;
  pageAccessToken: boolean;
  graphVersion: string;
}

/** api/_lib/integrations/crm.js › crmStatus(). */
export interface CrmWiring {
  provider: string;
  configured: boolean;
}

/** api/_lib/compliance.js › complianceStatus(). */
export interface ComplianceWiring {
  mode: 'strict' | 'dev';
  dndScrub: boolean;
  suppressionList: boolean;
  /** 'firestore' | 'http' | 'none' — 'none' means opt-outs are NOT durable. */
  suppressionBackend: string;
  consentWindowDays: number;
  callingWindowIST: string;
}

/** api/_lib/queue.js › queueStatus(). */
export interface QueueWiring {
  configured: boolean;
  signed: boolean;
}

export interface Wiring {
  meta: MetaWiring;
  crm: CrmWiring;
  compliance: ComplianceWiring;
  dialQueue: QueueWiring;
  /** Machine codes. See BLOCKERS below for the env var each one names. */
  blockers: string[];
  canDial: boolean;
}

/* --------------------------------------------------------------- funnel */

export interface FunnelCounts {
  received: number;
  blocked: number;
  queued: number;
  completed: number;
  booked: number;
  callback: number;
  optOut: number;
  notInterested: number;
}

/** api/_lib/events.js › rollup(). Rates are null, never a fake 0%. */
export interface Funnel {
  counts: FunnelCounts;
  blockReasons: Record<string, number>;
  bySource: Record<string, number>;
  avgScore: number | null;
  dialRate: number | null;
  bookRate: number | null;
}

/* --------------------------------------------------------------- events */

/**
 * One pipeline event. The union of every payload recorded in
 * api/_lib/pipeline.js, api/calls/outcome.js and api/calls/transcript.js —
 * every field optional because which ones are present depends on `type`.
 *
 * `phone` is ALREADY MASKED at the record site. It is never unmasked here.
 */
export interface PipelineEvent {
  at: string;
  type: string;
  source?: string | null;
  phone?: string | null;
  name?: string | null;
  campaign?: string | null;
  reason?: string | null;
  queued?: boolean;
  callId?: string | null;
  disposition?: string | null;
  score?: number | null;
  band?: string | null;
  coverage?: number | null;
  durationSec?: number | null;
  nextAction?: string | null;
  reviewedBy?: string | null;
  transcriptStored?: boolean;
  recordingRef?: string | null;
  /** recording.erased only. */
  ref?: string;
  ok?: boolean;
  error?: string | null;
}

/* ---------------------------------------------------------------- calls */

export interface ScoringField {
  id: string;
  label: string;
  bucket: string;
  worth: number;
  weight: number;
  points: number;
  answered: boolean;
}

/**
 * api/calls/outcome.js › applyScore(). Note there is no `score` INSIDE this —
 * the score lives on the call itself; this is the arithmetic behind it.
 */
export interface Scoring {
  band: string;
  coverage: number;
  answered: number;
  of: number;
  cappedBy: string | null;
  fields: ScoringField[];
  explain: string;
}

export interface TranscriptTurn {
  role: 'agent' | 'user';
  text: string;
}

/** api/_lib/callview.js › callView(). */
export interface CallView {
  callId: string | null;
  at: string | null;
  startedAt: string | null;
  durationSec: number | null;
  disposition: string | null;
  /** Terminal. Overrides whatever the agent reported. */
  optOut: boolean;
  score: number | null;
  band: string | null;
  scoring: Scoring | null;
  qualification: Record<string, string> | null;
  summary: string | null;
  nextAction: string | null;
  comment: string | null;
  reviewedBy: string | null;
  turns: number | null;
  /** Opaque s3:// reference. NOT playable, and never rendered as a link. */
  recordingRef: string | null;
  lead: {
    phoneMasked: string | null;
    name: string | null;
    source: string | null;
    sourceId: string | null;
    crmRecordId: string | null;
  };
  /** Present only on the single-call read (/api/calls/transcript?callId=…). */
  transcript?: TranscriptTurn[];
}

/* ----------------------------------------------------------- provenance */

/**
 * WHERE THE NUMBERS CAME FROM. The discriminant is `durable`.
 *
 * `durable:false` is the in-process ring buffer in api/_lib/events.js: partial
 * by construction, emptied on cold start, and NOT shared with a second
 * concurrent instance. The console must say so — see ProvenanceBanner.
 */
export type StoreProvenance =
  | {
      durable: true;
      backend: string;
      projectId: string | null;
      reachable: boolean;
      held: number;
    }
  | {
      durable: false;
      store: string;
      capacity: number;
      held: number;
      instanceStartedAt: string;
      backend: string;
      reachable: boolean;
      storeError: string | null;
    };

export interface ConsoleSummary {
  ok: true;
  generatedAt: string;
  wiring: Wiring;
  funnel: Funnel;
  events: PipelineEvent[];
  calls: CallView[];
  store: StoreProvenance;
}

/* ===========================================================================
   TRANSLATION TABLES

   A machine code is a fine thing to put on the wire and a poor thing to put in
   front of a person at 9pm. Each entry names the NEXT ACTION, and for a
   blocker, the exact environment variable that clears it.
   =========================================================================== */

export interface BlockerInfo {
  title: string;
  /** What an operator does about it. */
  fix: string;
  /** The env var(s) that clear it. Rendered verbatim, in mono. */
  env: string[];
  /** 'compliance' blockers are the ones that make a dial unlawful, not just impossible. */
  kind: 'compliance' | 'wiring';
}

const BLOCKERS: Record<string, BlockerInfo> = {
  dnd_scrub_not_configured: {
    title: 'DND registry scrub is not configured',
    fix: 'No number can be scrubbed against the TRAI/DLT register, so the gate refuses every dial. Point these at your scrub provider.',
    env: ['DND_SCRUB_URL', 'DND_SCRUB_API_KEY'],
    kind: 'compliance',
  },
  suppression_list_not_configured: {
    title: 'No durable do-not-call register',
    fix: 'Opt-outs would live only in this instance’s memory and vanish on cold start — a number that asked never to be called again could be dialled again. Wire Firestore, or an external register.',
    env: ['FIREBASE_SERVICE_ACCOUNT', 'SUPPRESSION_LIST_URL'],
    kind: 'compliance',
  },
  compliance_mode_dev: {
    title: 'Compliance mode is set to dev',
    fix: 'Unverifiable scrub and suppression results are being waved through instead of blocking. This must never be set on a deployment that dials real numbers.',
    env: ['COMPLIANCE_MODE=strict'],
    kind: 'compliance',
  },
  outbound_caller_id_missing: {
    title: 'No outbound caller ID',
    fix: 'Set the 160-series number registered for outbound telemarketing. Without it there is nothing lawful to dial from.',
    env: ['OUTBOUND_CALLER_ID'],
    kind: 'compliance',
  },
  dial_queue_not_configured: {
    title: 'No dial queue consumer',
    fix: 'Leads that pass the gate have nowhere to go, so nothing dials. Point this at the orchestrator, and set the secret so it can trust us.',
    env: ['DIAL_QUEUE_URL', 'DIAL_QUEUE_SECRET'],
    kind: 'wiring',
  },
  meta_lead_ads_not_wired: {
    title: 'Meta Lead Ads is not wired',
    fix: 'Webhook signatures cannot be verified and lead records cannot be pulled from the Graph API, so no lead arrives from an ad.',
    env: ['META_APP_SECRET', 'META_PAGE_ACCESS_TOKEN'],
    kind: 'wiring',
  },
};

export function blockerInfo(code: string): BlockerInfo {
  return (
    BLOCKERS[code] ?? {
      title: code,
      fix: 'This deployment reported a blocker this console does not have wording for. Check /api/integrations/health.',
      env: [],
      kind: 'wiring',
    }
  );
}

/** Compliance-gate deny reasons, from api/_lib/compliance.js › checkDialable(). */
const REASONS: Record<string, string> = {
  invalid_phone: 'Not a dialable number',
  no_consent: 'No consent recorded',
  no_consent_basis: 'Consent has no basis',
  consent_timestamp_missing: 'Consent has no timestamp',
  consent_timestamp_invalid: 'Consent timestamp is unreadable',
  consent_expired: 'Consent older than the window',
  consent_in_future: 'Consent dated in the future',
  suppressed: 'On our do-not-call list',
  suppression_unverified: 'Do-not-call list unreachable',
  dnd_registered: 'Registered on DND',
  dnd_unverified: 'DND scrub unreachable',
  outside_calling_window: 'Outside the legal calling window',
  duplicate_lead: 'Duplicate lead',
  dial_queue_not_configured: 'No dial queue configured',
};

export function humanReason(reason: string | null | undefined): string {
  if (!reason) return 'Unknown';
  return REASONS[reason] ?? reason;
}

/**
 * Which block reasons are a person exercising a right, versus a wiring fault.
 * The first kind is the system working; the second is the system failing shut.
 */
export function reasonIsTerminal(reason: string): boolean {
  return reason === 'suppressed' || reason === 'dnd_registered' || reason === 'consent_expired' || reason === 'no_consent';
}

/* ------------------------------------------------------------ formatting */

export type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'bad';

export function bandTone(band: string | null | undefined): Tone {
  switch (band) {
    case 'hot': return 'ok';
    case 'warm': return 'warn';
    case 'cool':
    case 'cold': return 'neutral';
    default: return 'neutral';
  }
}

export function dispositionTone(disposition: string | null | undefined): Tone {
  switch (disposition) {
    case 'booked': return 'ok';
    case 'callback': return 'warn';
    case 'opt-out': return 'bad';
    default: return 'neutral';
  }
}

/** An opt-out is terminal however the agent labelled the call. */
export function isOptOut(call: Pick<CallView, 'optOut' | 'disposition'>): boolean {
  return call.optOut === true || call.disposition === 'opt-out';
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString();
}

export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
