/**
 * Team mode (团队模式): the shapes the host, the Runner and the Web share.
 *
 * A group mount with team mode on answers through its workspace's main
 * session (the router) and runs each piece of authorized work as a work item
 * in a Runtime Session of its own (the worker). Messages on a thread a work
 * item subscribes to go straight to its worker; everything else passes the
 * admission table first. Only the router speaks in the group, through
 * `work_reply`; a worker confirms a request once with `work_ack` and reports
 * to the router with `work_report`.
 *
 * Canonical file: shared/work-items.ts, copied by `make sync-types`.
 */

// ── Mount settings ─────────────────────────────────────────────────────

/** What one admission cell turns a message into. */
export type AdmissionOutcome = 'explicit' | 'inferred' | 'ignore';

/**
 * How a message that reaches no work item is admitted, by whether its sender
 * is listed (the workspace owner or the group allowlist) and whether it
 * addresses the bot (a structural @ or a direct reply to the bot). A listed
 * sender who addresses the bot always makes an explicit request.
 */
export interface AdmissionTable {
  listedUnaddressed: 'inferred' | 'ignore';
  unlistedAddressed: AdmissionOutcome;
  unlistedUnaddressed: 'inferred' | 'ignore';
}

/**
 * `off`: nothing inferred reaches the router. `observe`: inferred candidates
 * are judged and a positive judgement is only recorded. `auto`: a positive
 * judgement opens a read-only work item.
 */
export type TeamAcceptMode = 'off' | 'observe' | 'auto';

/** Proactive work the team allows, in the team's own words. */
export interface TeamRule {
  id: string;
  name: string;
  instruction: string;
  enabled: boolean;
}

export interface TeamSettings {
  enabled: boolean;
  admission: AdmissionTable;
  acceptMode: TeamAcceptMode;
  rules: TeamRule[];
  /** Bumped on every save; recorded on each work item's mandate. */
  version: number;
}

export const DEFAULT_ADMISSION: AdmissionTable = {
  listedUnaddressed: 'ignore',
  unlistedAddressed: 'ignore',
  unlistedUnaddressed: 'ignore',
};

export const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  enabled: false,
  admission: DEFAULT_ADMISSION,
  acceptMode: 'observe',
  rules: [],
  version: 0,
};

export const TEAM_RULE_LIMIT = 20;
export const TEAM_RULE_TEXT_LIMIT = 2000;

const OUTCOMES = new Set<AdmissionOutcome>(['explicit', 'inferred', 'ignore']);

function unaddressed(value: unknown): 'inferred' | 'ignore' {
  return value === 'inferred' ? 'inferred' : 'ignore';
}

/** Stored JSON → settings; anything malformed reads as team mode off. */
export function parseTeamSettings(
  raw: string | null | undefined,
): TeamSettings {
  if (!raw) return DEFAULT_TEAM_SETTINGS;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return DEFAULT_TEAM_SETTINGS;
  }
  if (!value || typeof value !== 'object') return DEFAULT_TEAM_SETTINGS;
  const admission = (value.admission ?? {}) as Record<string, unknown>;
  const unlistedAddressed = OUTCOMES.has(
    admission.unlistedAddressed as AdmissionOutcome,
  )
    ? (admission.unlistedAddressed as AdmissionOutcome)
    : 'ignore';
  const acceptMode: TeamAcceptMode =
    value.acceptMode === 'off' || value.acceptMode === 'auto'
      ? value.acceptMode
      : 'observe';
  const rules = Array.isArray(value.rules)
    ? (value.rules as unknown[])
        .filter(
          (rule): rule is TeamRule =>
            !!rule &&
            typeof (rule as TeamRule).id === 'string' &&
            typeof (rule as TeamRule).name === 'string' &&
            typeof (rule as TeamRule).instruction === 'string',
        )
        .slice(0, TEAM_RULE_LIMIT)
        .map((rule) => ({
          id: rule.id,
          name: rule.name,
          instruction: rule.instruction,
          enabled: rule.enabled !== false,
        }))
    : [];
  return {
    enabled: value.enabled === true,
    admission: {
      listedUnaddressed: unaddressed(admission.listedUnaddressed),
      unlistedAddressed,
      unlistedUnaddressed: unaddressed(admission.unlistedUnaddressed),
    },
    acceptMode,
    rules,
    version: Number.isInteger(value.version) ? (value.version as number) : 0,
  };
}

/** Whether inferred candidates can exist at all under these settings. */
export function acceptsInferred(settings: TeamSettings): boolean {
  return (
    settings.acceptMode !== 'off' && settings.rules.some((rule) => rule.enabled)
  );
}

/**
 * The gate (program layer): a message that reached no work item becomes an
 * explicit request, an inferred candidate, or nothing. Bots never make
 * explicit requests and are not admitted at all in this version.
 */
export function admitMessage(
  settings: TeamSettings,
  message: { listed: boolean; addressed: boolean; fromBot: boolean },
): AdmissionOutcome {
  if (message.fromBot) return 'ignore';
  let outcome: AdmissionOutcome;
  if (message.listed) {
    outcome = message.addressed
      ? 'explicit'
      : settings.admission.listedUnaddressed;
  } else {
    outcome = message.addressed
      ? settings.admission.unlistedAddressed
      : settings.admission.unlistedUnaddressed;
  }
  if (outcome === 'inferred' && !acceptsInferred(settings)) return 'ignore';
  return outcome;
}

// ── Work items ─────────────────────────────────────────────────────────

export type WorkStrength = 'explicit' | 'inferred';

/**
 * Why a work item may be done: who asked, where, how strongly, under which
 * rules and settings version. Immutable once the item exists. `writable` is
 * false for inferred items and for requests from unlisted senders: their
 * worker may investigate and reproduce, but not edit, commit or push, until
 * the owner approves the item.
 */
export interface WorkMandate {
  strength: WorkStrength;
  requesterImId: string | null;
  requesterName: string | null;
  requesterListed: boolean;
  requesterIsOwner: boolean;
  matchedRules: { id: string; name: string; instruction: string }[];
  settingsVersion: number;
  writable: boolean;
}

export type WorkReportState =
  | 'progress'
  | 'waiting'
  | 'ready'
  | 'blocked'
  | 'failed'
  | 'dropped';

export type WorkItemStatus = 'open' | 'ended';

/** How an ended item ended. */
export type WorkItemOutcome =
  | 'completed'
  | 'dropped'
  | 'failed'
  | 'stopped'
  | null;

export interface WorkItem {
  id: string;
  /** `#<seq>` per workspace, for people. */
  seq: number;
  workspaceJid: string;
  workspaceFolder: string;
  /** The Feishu group (route jid without suffixes) the item came from. */
  channelJid: string;
  /** The Runtime Session (agents.id) that does the work. */
  agentId: string;
  title: string;
  /** The message that started the item, as the provider identifies it. */
  sourceMessageId: string;
  /** The route its replies go to (the group's IM jid). */
  sourceRouteJid: string;
  mandate: WorkMandate;
  status: WorkItemStatus;
  outcome: WorkItemOutcome;
  lastReport: WorkReportState | null;
  lastSummary: string | null;
  /** A question waiting for a person, set by `work_report.human_action`. */
  attention: string | null;
  /** The message that raised the question, when one did. */
  attentionMessageId: string | null;
  /** The owner approved edits on an item that started read-only. */
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

/**
 * The stage a person reads, derived and never stored. First match wins:
 * a question waits for an answer; a blocked or failed report waits for a
 * person; an item that cannot edit yet waits for approval; otherwise it is
 * working, or idle once its worker reported `waiting`.
 */
export type WorkStage =
  | 'answer'
  | 'blocked'
  | 'failed'
  | 'approval'
  | 'working'
  | 'idle'
  | 'ended';

export function deriveWorkStage(
  item: Pick<
    WorkItem,
    'status' | 'attention' | 'lastReport' | 'mandate' | 'approvedAt'
  >,
): WorkStage {
  if (item.status === 'ended') return 'ended';
  if (item.attention) return 'answer';
  if (item.lastReport === 'blocked') return 'blocked';
  if (item.lastReport === 'failed') return 'failed';
  if (!item.mandate.writable && !item.approvedAt && item.lastReport === 'ready')
    return 'approval';
  if (item.lastReport === 'waiting') return 'idle';
  return 'working';
}

/** Stages that wait for a person; the Web lists these first. */
export function stageNeedsPerson(stage: WorkStage): boolean {
  return (
    stage === 'answer' ||
    stage === 'blocked' ||
    stage === 'failed' ||
    stage === 'approval'
  );
}

/**
 * A subscription key: one provider message id or native thread id within a
 * chat. A message reaches the work items subscribed to its own id's parent,
 * root or thread. Keys are `msg:<id>` or `thread:<id>`.
 */
export function subscriptionKey(kind: 'msg' | 'thread', id: string): string {
  return `${kind}:${id}`;
}

export type WorkDecisionKind =
  | 'accept'
  | 'attach'
  | 'stop'
  | 'ignore'
  | 'would_accept';

/** One routing decision, kept for the Web's decision log. */
export interface WorkDecision {
  id: string;
  workspaceJid: string;
  channelJid: string;
  triggerMessageId: string;
  strength: WorkStrength;
  kind: WorkDecisionKind;
  workItemId: string | null;
  reason: string;
  matchedRuleIds: string[];
  createdAt: string;
}

// ── Messages to people ─────────────────────────────────────────────────

/** Hard ceiling for any team-mode message to an IM chat. */
export const TEAM_IM_WORD_LIMIT = 100;

/**
 * Words as a reader counts them: each CJK character is a word, a run of
 * Latin letters or digits is one, Markdown link targets count too.
 */
export function countImWords(text: string): number {
  const segmenter =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? new Intl.Segmenter('zh', { granularity: 'word' })
      : null;
  if (!segmenter) return text.split(/\s+/).filter(Boolean).length;
  let count = 0;
  for (const part of segmenter.segment(text)) {
    if (!part.isWordLike) continue;
    // A CJK run segmented as one word still reads as one word per character
    // when Intl lacks a dictionary; count characters so the limit holds.
    const cjk = part.segment.match(/[㐀-鿿豈-﫿]/g);
    count += cjk && cjk.length === part.segment.length ? cjk.length : 1;
  }
  return count;
}

export type WorkReplyPurpose = 'ack' | 'result' | 'attention' | 'answer';

// ── Runner ↔ host (IPC) ────────────────────────────────────────────────

/** How the Runner knows a session's role in team mode. */
export type TeamRole =
  | { role: 'router' }
  | { role: 'worker'; workItemId: string; writable: boolean };

export interface WorkRouteItem {
  kind: 'accept' | 'attach' | 'stop' | 'ignore';
  /** The candidate's trigger (provider message id). */
  triggerMessageId: string;
  /** accept: a short title; attach/stop: the work item. */
  title?: string;
  workItemId?: string;
  /** accept: the one-line acknowledgement posted under the request. */
  acknowledgement?: string;
  /** accept/attach: routing background, at most 30 words; never a plan. */
  note?: string;
  reason?: string;
  /** Inferred candidates: one entry per enabled rule. */
  ruleAssessments?: { ruleId: string; matched: boolean; reason: string }[];
}

export interface WorkRouteResultItem {
  triggerMessageId: string;
  ok: boolean;
  error?: string;
  workItemId?: string;
  decision?: WorkDecisionKind;
}

export const WORK_IPC_TYPES = [
  'work_route',
  'work_reply',
  'work_list',
  'work_report',
  'work_ack',
  'work_handback',
] as const;
export type WorkIpcType = (typeof WORK_IPC_TYPES)[number];

// ── Web ────────────────────────────────────────────────────────────────

export interface WorkItemView extends WorkItem {
  stage: WorkStage;
  workspaceName: string;
  channelName: string | null;
}

/** WebSocket: a work item changed; the Web refetches or merges it. */
export interface WorkItemWsEvent {
  type: 'work_item_updated';
  workspaceJid: string;
  item: WorkItemView;
}
