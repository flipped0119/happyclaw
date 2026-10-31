/**
 * Team mode (团队模式): the operations REST and the host runtime share.
 *
 * Validation, the state machine and the side effects (creating and stopping
 * worker sessions, delivering inputs, posting replies) live here, so the Web
 * and the router's tools change work items the same way. Callers check
 * workspace access first; these functions check the rest.
 *
 * Lanes: the router session of a group is the Runtime Session recorded on
 * its team mount (source_kind 'team_router'); each work item has a worker
 * session of its own (source_kind 'work_item'). Inputs into both are composed
 * here and moved by work-item-runtime.ts.
 */
import crypto from 'crypto';

import { resolveChannelConversationKind } from './channel-conversation-kind.js';
import {
  getAgent,
  getAgentBuilderInputMessage,
  getChannelMount,
  getRegisteredGroup,
  listChannelMountsByWorkspace,
} from './db.js';
import { getChannelType } from './im-channel.js';
import { logger } from './logger.js';
import {
  createConversationSession,
  deleteConversationSession,
} from './session-factory.js';
import {
  createSessionWorktree,
  getWorktreeSupport,
} from './session-worktree.js';
import {
  candidateInputItem,
  followupInputItem,
  readTeamInput,
  teamTriggerKeys,
  type TeamGateGroup,
  type TeamInboundDecision,
  type TeamInputItem,
} from './team-gate.js';
import type { ChannelMount, NewMessage, RegisteredGroup } from './types.js';
import {
  getTeamMount,
  getTeamMountByRouter,
  getWorkDecisionForTrigger,
  getWorkItem,
  getWorkItemByAgent,
  getWorkItemBySource,
  insertWorkItem,
  listWorkDecisions,
  listWorkEvents,
  listWorkItems,
  listWorkItemSubscriptions,
  recordWorkDecision,
  recordWorkEvent,
  saveTeamMountSettings as storeTeamMountSettings,
  subscribeWorkItem,
  unsubscribeWorkItem,
  updateWorkItem,
  type TeamMount,
  type WorkEvent,
  type WorkItemPatch,
} from './work-item-store.js';
import {
  getWorkItemRuntimeHooks,
  injectTeamInput,
  laneJidOf,
  queueTeamReply,
} from './work-item-runtime.js';
import {
  admitMessage,
  countImWords,
  deriveWorkStage,
  parseTeamSettings,
  subscriptionKey,
  TEAM_IM_WORD_LIMIT,
  TEAM_RULE_LIMIT,
  TEAM_RULE_TEXT_LIMIT,
  type TeamRole,
  type TeamSettings,
  type WorkDecision,
  type WorkDecisionKind,
  type WorkItem,
  type WorkItemStatus,
  type WorkItemView,
  type WorkMandate,
  type WorkReportState,
  type WorkRouteItem,
  type WorkRouteResultItem,
} from './work-items.js';

export interface WorkItemActor {
  userId: string;
  isAdmin: boolean;
}

/** Thrown for a refused request; REST maps `status` to the HTTP status. */
export class WorkItemError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'WorkItemError';
  }
}

export interface TeamMountView {
  channelJid: string;
  channelName: string | null;
  /** False when the mount cannot run team mode, with the reason. */
  eligible: boolean;
  ineligibleReason: string | null;
  settings: TeamSettings;
  routerAgentId: string | null;
}

export interface WorkItemDetail {
  item: WorkItemView;
  events: WorkEvent[];
  subscriptions: { channelJid: string; subKey: string }[];
}

const TITLE_LIMIT = 60;
const NOTE_WORD_LIMIT = 30;
const SUMMARY_CHAR_LIMIT = 4000;
const REASON_CHAR_LIMIT = 500;

// ── Team groups ────────────────────────────────────────────────────────

/** Why a group mount cannot run team mode, or null when it can. */
export function teamMountIneligibility(
  channelJid: string,
  workspaceJid: string,
  mount: ChannelMount | undefined = getChannelMount(channelJid),
): string | null {
  if (!mount || mount.workspace_jid !== workspaceJid) {
    return '这个群没有绑定到当前工作区';
  }
  if (getChannelType(channelJid) !== 'feishu') {
    return '团队模式目前只支持飞书群';
  }
  const chat = getRegisteredGroup(channelJid);
  if (resolveChannelConversationKind(channelJid, chat ?? {}) !== 'group') {
    return '团队模式只支持飞书普通群（不支持私聊和话题群）';
  }
  if (mount.routing_mode !== 'single_session' || mount.session_id) {
    return '群需要绑定到工作区的主会话';
  }
  return null;
}

/** A group with team mode on and routable, as the gate and the tools use it. */
export interface TeamGroupContext extends TeamGateGroup {
  team: TeamMount;
  mount: ChannelMount;
  chat: RegisteredGroup;
  workspace: RegisteredGroup;
}

/**
 * The group's team context, or null when team mode is off or the mount no
 * longer qualifies (then nothing about the group changes). A missing router
 * session reads as `routerAgentId: ''`: the group is in team mode but cannot
 * take requests until the settings are saved again.
 */
export function resolveTeamGroup(channelJid: string): TeamGroupContext | null {
  const team = getTeamMount(channelJid);
  if (!team?.settings.enabled) return null;
  const mount = getChannelMount(channelJid);
  if (teamMountIneligibility(channelJid, team.workspaceJid, mount)) return null;
  const chat = getRegisteredGroup(channelJid);
  const workspace = getRegisteredGroup(team.workspaceJid);
  if (!chat || !workspace || !mount) return null;
  const router = team.routerAgentId ? getAgent(team.routerAgentId) : undefined;
  const routerAgentId =
    router?.kind === 'conversation' && router.chat_jid === team.workspaceJid
      ? router.id
      : '';
  return {
    channelJid,
    workspaceJid: team.workspaceJid,
    settings: team.settings,
    routerAgentId,
    team,
    mount,
    chat,
    workspace,
  };
}

function ownerImIdOf(context: TeamGroupContext): string | null {
  return context.chat.owner_im_id || context.mount.owner_im_id || null;
}

/** The workspace owner or a sender on the group allowlist (/allow). */
export function isTeamListed(
  context: TeamGroupContext,
  senderImId: string | undefined,
): boolean {
  if (!senderImId) return false;
  return (
    senderImId === ownerImIdOf(context) ||
    (context.chat.sender_allowlist ?? []).includes(senderImId)
  );
}

/** One of the bot's own messages in the group: stored in its router lane. */
export function isTeamBotMessage(
  context: TeamGroupContext,
  messageId: string,
): boolean {
  if (!context.routerAgentId) return false;
  const row = getAgentBuilderInputMessage(
    laneJidOf(context.workspaceJid, context.routerAgentId),
    messageId,
  );
  return row?.is_from_me === 1;
}

export function hasWorkerSession(item: WorkItem): boolean {
  const agent = getAgent(item.agentId);
  return agent?.kind === 'conversation' && agent.chat_jid === item.workspaceJid;
}

/** The role a Runtime Session plays in team mode, or null for none. */
export function resolveTeamRole(
  agentId: string | null | undefined,
): TeamRole | null {
  if (!agentId) return null;
  const agent = getAgent(agentId);
  if (agent?.source_kind === 'team_router') {
    return getTeamMountByRouter(agentId) ? { role: 'router' } : null;
  }
  if (agent?.source_kind === 'work_item') {
    const item = getWorkItemByAgent(agentId);
    if (!item) return null;
    return {
      role: 'worker',
      workItemId: item.id,
      writable: item.mandate.writable || !!item.approvedAt,
    };
  }
  return null;
}

/** The warm-runner identity of a team role (see RunnerMessageRequirements). */
export function teamRoleKey(role: TeamRole | null): string | null {
  if (!role) return null;
  return role.role === 'router'
    ? 'router'
    : `worker:${role.workItemId}:${role.writable ? 'rw' : 'ro'}`;
}

// ── Views and broadcast ────────────────────────────────────────────────

function toView(item: WorkItem): WorkItemView {
  return {
    ...item,
    stage: deriveWorkStage(item),
    workspaceName: getRegisteredGroup(item.workspaceJid)?.name ?? '',
    channelName: getRegisteredGroup(item.channelJid)?.name ?? null,
  };
}

function broadcast(item: WorkItem): WorkItemView {
  const view = toView(item);
  try {
    getWorkItemRuntimeHooks().broadcastWorkItemEvent({
      type: 'work_item_updated',
      workspaceJid: item.workspaceJid,
      item: view,
    });
  } catch (error) {
    logger.warn(
      { err: error, workItemId: item.id },
      'Work item broadcast failed',
    );
  }
  return view;
}

function now(): string {
  return new Date().toISOString();
}

function patchItem(item: WorkItem, patch: WorkItemPatch): WorkItem {
  return updateWorkItem(item.id, patch, now()) ?? item;
}

function endItem(
  item: WorkItem,
  outcome: 'completed' | 'dropped' | 'stopped',
  extra: WorkItemPatch = {},
): WorkItem {
  const at = now();
  return (
    updateWorkItem(
      item.id,
      { ...extra, status: 'ended', outcome, endedAt: at },
      at,
    ) ?? item
  );
}

// ── REST ───────────────────────────────────────────────────────────────

/** The workspace's group mounts and their team settings. */
export function listTeamMountViews(workspaceJid: string): TeamMountView[] {
  return listChannelMountsByWorkspace(workspaceJid)
    .filter((mount) => getChannelType(mount.channel_jid) === 'feishu')
    .filter((mount) => !mount.session_id)
    .map((mount) => {
      const team = getTeamMount(mount.channel_jid);
      const ineligibleReason = teamMountIneligibility(
        mount.channel_jid,
        workspaceJid,
        mount,
      );
      const current = team?.workspaceJid === workspaceJid ? team : undefined;
      return {
        channelJid: mount.channel_jid,
        channelName: getRegisteredGroup(mount.channel_jid)?.name ?? null,
        eligible: ineligibleReason === null,
        ineligibleReason,
        settings: current?.settings ?? parseTeamSettings(null),
        routerAgentId: current?.routerAgentId ?? null,
      };
    });
}

function normalizeSettings(
  settings: Omit<TeamSettings, 'version'>,
  version: number,
): TeamSettings {
  if (!settings || typeof settings !== 'object') {
    throw new WorkItemError('团队设置格式不正确');
  }
  const rules = Array.isArray(settings.rules) ? settings.rules : [];
  if (rules.length > TEAM_RULE_LIMIT) {
    throw new WorkItemError(`规则最多 ${TEAM_RULE_LIMIT} 条`);
  }
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule.name !== 'string' ||
      typeof rule.instruction !== 'string' ||
      !rule.name.trim() ||
      !rule.instruction.trim()
    ) {
      throw new WorkItemError('每条规则都需要名称和说明');
    }
    if (
      rule.name.length > TEAM_RULE_TEXT_LIMIT ||
      rule.instruction.length > TEAM_RULE_TEXT_LIMIT
    ) {
      throw new WorkItemError(`规则文字不能超过 ${TEAM_RULE_TEXT_LIMIT} 字`);
    }
  }
  return parseTeamSettings(
    JSON.stringify({
      ...settings,
      rules: rules.map((rule) => ({
        id:
          typeof rule.id === 'string' && rule.id.trim()
            ? rule.id.trim()
            : crypto.randomUUID().slice(0, 8),
        name: rule.name.trim(),
        instruction: rule.instruction.trim(),
        enabled: rule.enabled !== false,
      })),
      version,
    }),
  );
}

/**
 * Save a mount's team settings. Bumps the version, creates the router
 * session on first enable, and stops routing through it when disabled.
 * Refuses a mount that is not an eligible Feishu group of this workspace.
 */
export async function saveTeamMountSettings(
  workspaceJid: string,
  channelJid: string,
  settings: Omit<TeamSettings, 'version'>,
  actor: WorkItemActor,
): Promise<TeamMount> {
  const workspace = getRegisteredGroup(workspaceJid);
  if (!workspace) throw new WorkItemError('工作区不存在', 404);
  const mount = getChannelMount(channelJid);
  if (!mount || mount.workspace_jid !== workspaceJid) {
    throw new WorkItemError('这个群没有绑定到当前工作区', 404);
  }
  const existing = getTeamMount(channelJid);
  const current =
    existing?.workspaceJid === workspaceJid ? existing : undefined;
  const next = normalizeSettings(
    settings,
    (current?.settings.version ?? 0) + 1,
  );
  if (next.enabled) {
    const reason = teamMountIneligibility(channelJid, workspaceJid, mount);
    if (reason) throw new WorkItemError(reason);
  }
  let routerAgentId = current?.routerAgentId ?? null;
  const router = routerAgentId ? getAgent(routerAgentId) : undefined;
  if (!router || router.chat_jid !== workspaceJid) routerAgentId = null;
  if (next.enabled && !routerAgentId) {
    const chatName = getRegisteredGroup(channelJid)?.name || '飞书群';
    const session = await createConversationSession({
      workspaceJid,
      group: workspace,
      createdBy: workspace.created_by ?? actor.userId,
      name: `团队路由 · ${chatName}`,
      sourceKind: 'team_router',
    });
    routerAgentId = session.id;
  }
  const saved = storeTeamMountSettings({
    channelJid,
    workspaceJid,
    settings: next,
    routerAgentId,
    updatedBy: actor.userId,
    now: now(),
  });
  logger.info(
    {
      channelJid,
      workspaceJid,
      enabled: next.enabled,
      version: next.version,
      routerAgentId,
    },
    'Team mode settings saved',
  );
  return saved;
}

export function listWorkItemViews(
  workspaceJid: string,
  options?: { status?: WorkItemStatus; limit?: number },
): WorkItemView[] {
  return listWorkItems(workspaceJid, options).map(toView);
}

export function getWorkItemDetail(id: string): WorkItemDetail | undefined {
  const item = getWorkItem(id);
  if (!item) return undefined;
  return {
    item: toView(item),
    events: listWorkEvents(id),
    subscriptions: listWorkItemSubscriptions(id),
  };
}

function requireItem(id: string): WorkItem {
  const item = getWorkItem(id);
  if (!item) throw new WorkItemError('工作项不存在', 404);
  return item;
}

function stopItem(item: WorkItem, by: string): WorkItem {
  const stopped = endItem(item, 'stopped', { attention: null });
  recordWorkEvent({ workItemId: item.id, kind: 'stop', text: by, now: now() });
  // Stops the turn the worker runs now; queued inputs stay with the session.
  getWorkItemRuntimeHooks().interruptLane(
    laneJidOf(item.workspaceJid, item.agentId),
  );
  return stopped;
}

/** End an item as stopped by a person; interrupts its worker. */
export async function stopWorkItem(
  id: string,
  _actor: WorkItemActor,
): Promise<WorkItemView> {
  const item = requireItem(id);
  if (item.status === 'ended') {
    if (item.outcome === 'stopped') return toView(item);
    throw new WorkItemError('工作项已经结束', 409);
  }
  return broadcast(stopItem(item, 'web'));
}

/** Allow edits on an item that started read-only, and tell its worker. */
export async function approveWorkItem(
  id: string,
  _actor: WorkItemActor,
): Promise<WorkItemView> {
  const item = requireItem(id);
  if (item.status === 'ended') throw new WorkItemError('工作项已经结束', 409);
  if (item.mandate.writable || item.approvedAt) {
    throw new WorkItemError('工作项已经可以修改', 409);
  }
  const approved = patchItem(item, { approvedAt: now() });
  recordWorkEvent({ workItemId: item.id, kind: 'approve', now: now() });
  // The worker's role changes with this (writable), so its next turn starts
  // on a fresh runner with the edit tools restored.
  injectTeamInput({
    workspaceJid: item.workspaceJid,
    agentId: item.agentId,
    messageId: `work-approved-${item.id}`,
    content: '',
    item: { tag: 'work_approved', attrs: [['item', `#${item.seq}`]] },
  });
  return broadcast(approved);
}

export function listWorkDecisionsForWorkspace(
  workspaceJid: string,
  options?: { kind?: WorkDecisionKind; limit?: number },
): WorkDecision[] {
  return listWorkDecisions(workspaceJid, options);
}

// ── Inbound: what a stored group message does ──────────────────────────

/**
 * The header a routed group message is stored with, so its lane reads it as
 * a candidate or a follow-up. Null for ignored messages.
 */
export function teamInputItemFor(
  decision: TeamInboundDecision,
  message: {
    messageId: string;
    threadId?: string;
    senderImId?: string;
    mentionedBot: boolean;
  },
): TeamInputItem | null {
  if (decision.kind === 'ignore') return null;
  if (decision.kind === 'subscribed') {
    const [primary, ...copies] = decision.items;
    return followupInputItem({
      item: primary,
      triggerMessageId: message.messageId,
      addressed: message.mentionedBot,
      senderImId: message.senderImId,
      threadId: message.threadId,
      copyItemIds: copies.map((item) => item.id),
    });
  }
  const team = getTeamMount(decision.channelJid);
  return candidateInputItem({
    triggerMessageId: message.messageId,
    strength: decision.strength,
    listed: decision.listed,
    addressed: decision.addressed,
    settings: team?.settings ?? parseTeamSettings(null),
    threadItems: decision.threadItems,
    senderImId: message.senderImId,
    threadId: message.threadId,
  });
}

/** The id of the copy of group message `messageId` for a further item. */
export function followupCopyId(messageId: string, workItemId: string): string {
  return `${messageId}:wi:${workItemId}`;
}

/**
 * A subscribed group message was stored in its first item's lane: resume
 * ended items it reaches, give each further item its copy, and note the
 * delivery on every item (work_ack and work_handback check it).
 */
export function onTeamMessageStored(
  decision: TeamInboundDecision,
  message: Pick<
    NewMessage,
    'id' | 'content' | 'sender_name' | 'source_jid' | 'chat_jid'
  > & { senderImId?: string; threadId?: string; mentionedBot?: boolean },
): void {
  if (decision.kind !== 'subscribed') return;
  const at = now();
  for (const [index, reached] of decision.items.entries()) {
    let item = getWorkItem(reached.id) ?? reached;
    if (decision.resumeIds.includes(item.id) && item.status === 'ended') {
      if (item.outcome === 'stopped') continue;
      item = patchItem(item, {
        status: 'open',
        outcome: null,
        endedAt: null,
      });
      recordWorkEvent({
        workItemId: item.id,
        kind: 'resume',
        triggerMessageId: message.id,
        now: at,
      });
    }
    recordWorkEvent({
      workItemId: item.id,
      kind: 'input',
      triggerMessageId: message.id,
      now: at,
    });
    if (index > 0) {
      injectTeamInput({
        workspaceJid: item.workspaceJid,
        agentId: item.agentId,
        messageId: followupCopyId(message.id, item.id),
        content: message.content,
        senderName: message.sender_name,
        sourceJid: message.source_jid ?? item.channelJid,
        item: followupInputItem({
          item,
          triggerMessageId: message.id,
          addressed: message.mentionedBot === true,
          senderImId: message.senderImId,
          threadId: message.threadId,
        }),
      });
    }
    broadcast(item);
  }
}

/**
 * The ids of the copies a stored group message was given: the further items
 * of a subscribed message, or the item a router attached a candidate to.
 * Recalling the message withdraws them with it.
 */
export function followupCopyIdsOf(
  channelJid: string,
  messageId: string,
  attachmentsJson: string | null | undefined,
): string[] {
  const item = readTeamInput(attachmentsJson);
  if (!item) return [];
  const ids = item.facts?.copyItemIds ?? [];
  if (item.tag === 'team_candidate') {
    const decision = getWorkDecisionForTrigger(channelJid, messageId);
    if (decision?.kind === 'attach' && decision.workItemId) {
      ids.push(decision.workItemId);
    }
  }
  return ids.map((id) => followupCopyId(messageId, id));
}

// ── IPC: router and worker tools ───────────────────────────────────────

/** Host-derived identity of the session that called a team tool. */
export interface WorkIpcCaller {
  folder: string;
  agentId: string | null;
}

export type WorkIpcResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

class WorkIpcError extends Error {}

function fail(message: string): never {
  throw new WorkIpcError(message);
}

interface RouterLane {
  context: TeamGroupContext;
  laneJid: string;
}

function requireRouter(caller: WorkIpcCaller): RouterLane {
  const agent = caller.agentId ? getAgent(caller.agentId) : undefined;
  const team =
    agent?.source_kind === 'team_router'
      ? getTeamMountByRouter(agent.id)
      : undefined;
  if (!agent || !team || agent.group_folder !== caller.folder) {
    fail('Only a team router session can use this tool.');
  }
  const context = resolveTeamGroup(team.channelJid);
  if (!context || context.routerAgentId !== agent.id) {
    fail('Team mode is off for this group.');
  }
  return { context, laneJid: laneJidOf(context.workspaceJid, agent.id) };
}

function requireWorker(caller: WorkIpcCaller): WorkItem {
  const agent = caller.agentId ? getAgent(caller.agentId) : undefined;
  const item =
    agent?.source_kind === 'work_item'
      ? getWorkItemByAgent(agent.id)
      : undefined;
  if (!agent || !item || agent.group_folder !== caller.folder) {
    fail('Only a work item session can use this tool.');
  }
  return item;
}

function requireImText(value: unknown, what: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) fail(`${what} is required.`);
  const words = countImWords(text);
  if (words > TEAM_IM_WORD_LIMIT) {
    fail(
      `${what} has ${words} words; group messages are limited to ${TEAM_IM_WORD_LIMIT}. Rewrite it shorter and call again.`,
    );
  }
  return text;
}

function optionalText(value: unknown, limit: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('Expected a string.');
  const text = value.trim();
  return text ? text.slice(0, limit) : null;
}

/** A message the router received as a candidate, original or handed back. */
interface Candidate {
  messageId: string;
  content: string;
  senderName: string;
  sourceJid: string | null;
  item: TeamInputItem;
}

function handbackInputId(triggerMessageId: string): string {
  return `handback:${triggerMessageId}`;
}

function loadCandidate(
  router: RouterLane,
  triggerMessageId: unknown,
): Candidate {
  if (typeof triggerMessageId !== 'string' || !triggerMessageId) {
    fail('triggerMessageId is required.');
  }
  for (const id of [triggerMessageId, handbackInputId(triggerMessageId)]) {
    const row = getAgentBuilderInputMessage(router.laneJid, id);
    const item = row ? readTeamInput(row.attachments) : null;
    if (row && item?.tag === 'team_candidate') {
      return {
        messageId: triggerMessageId,
        content: row.content,
        senderName: row.sender_name ?? '',
        sourceJid: row.source_jid,
        item,
      };
    }
  }
  fail(`${triggerMessageId} is not a candidate this router received.`);
}

function requireGroupItem(router: RouterLane, workItemId: unknown): WorkItem {
  const item =
    typeof workItemId === 'string' ? getWorkItem(workItemId) : undefined;
  if (!item || item.channelJid !== router.context.channelJid) {
    fail('workItemId is not a work item of this group.');
  }
  return item;
}

function decide(
  router: RouterLane,
  candidate: Candidate,
  kind: WorkDecisionKind,
  input: { workItemId?: string | null; reason?: string; ruleIds?: string[] },
): void {
  recordWorkDecision({
    id: crypto.randomUUID(),
    workspaceJid: router.context.workspaceJid,
    channelJid: router.context.channelJid,
    triggerMessageId: candidate.messageId,
    strength: candidate.item.facts?.strength ?? 'explicit',
    kind,
    workItemId: input.workItemId ?? null,
    reason: input.reason ?? '',
    matchedRuleIds: input.ruleIds ?? [],
    createdAt: now(),
  });
}

function refuseDecided(router: RouterLane, candidate: Candidate): void {
  const previous = getWorkDecisionForTrigger(
    router.context.channelJid,
    candidate.messageId,
  );
  if (previous) {
    fail(`This candidate was already decided (${previous.kind}).`);
  }
}

/**
 * Post a team reply quoted under `quoteMessageId`, after the replies already
 * queued for the group. A delivered reply is stored as a bot message in
 * `laneJid` and subscribed for `subscribeFor`; a failure is recorded on it.
 */
function postTeamReply(input: {
  channelJid: string;
  quoteMessageId: string;
  text: string;
  deliveryKey: string;
  laneJid: string;
  subscribeFor?: WorkItem;
  purpose: string;
}): void {
  void queueTeamReply({
    channelJid: input.channelJid,
    quoteMessageId: input.quoteMessageId,
    text: input.text,
    deliveryKey: input.deliveryKey,
  }).then(async (outcome) => {
    const item = input.subscribeFor;
    if (!outcome.ok) {
      logger.warn(
        {
          channelJid: input.channelJid,
          workItemId: item?.id,
          purpose: input.purpose,
        },
        'Team reply was not delivered',
      );
      if (item) {
        recordWorkEvent({
          workItemId: item.id,
          kind: 'reply',
          state: 'failed',
          text: `${input.purpose}: ${outcome.error}`.slice(0, 500),
          triggerMessageId: input.quoteMessageId,
          now: now(),
        });
        broadcast(getWorkItem(item.id) ?? item);
      }
      return;
    }
    if (item && outcome.providerMessageId) {
      subscribeWorkItem(
        item.id,
        item.channelJid,
        subscriptionKey('msg', outcome.providerMessageId),
        now(),
      );
    }
    if (item && input.purpose !== 'ack') {
      recordWorkEvent({
        workItemId: item.id,
        kind: 'reply',
        state: input.purpose,
        text: input.text,
        triggerMessageId: input.quoteMessageId,
        now: now(),
      });
    }
    try {
      await getWorkItemRuntimeHooks().postLaneMessage(
        input.laneJid,
        input.text,
        outcome.providerMessageId ?? `team-reply-${input.deliveryKey}`,
      );
    } catch (error) {
      logger.warn(
        { err: error, laneJid: input.laneJid },
        'Team reply was not stored in its lane',
      );
    }
    if (item) broadcast(getWorkItem(item.id) ?? item);
  });
}

// One accept at a time per trigger: a retried tool call never creates two
// worker sessions.
const acceptsInFlight = new Map<string, Promise<WorkRouteResultItem>>();

async function createWorkerSession(
  context: TeamGroupContext,
  title: string,
): Promise<string> {
  const sessionId = crypto.randomUUID();
  const workspace = context.workspace;
  let worktree = null;
  if (workspace.executionMode === 'host') {
    const support = await getWorktreeSupport(workspace);
    if (support.available) {
      worktree = await createSessionWorktree({
        group: workspace,
        chatJid: context.workspaceJid,
        agentId: sessionId,
      });
    }
  }
  const session = await createConversationSession({
    workspaceJid: context.workspaceJid,
    group: workspace,
    createdBy: workspace.created_by ?? '',
    name: title,
    sessionId,
    sourceKind: 'work_item',
    worktree,
  });
  return session.id;
}

async function acceptCandidate(
  router: RouterLane,
  candidate: Candidate,
  route: WorkRouteItem,
): Promise<WorkRouteResultItem> {
  const { context } = router;
  const existing = getWorkItemBySource(context.channelJid, candidate.messageId);
  if (existing) {
    return {
      triggerMessageId: candidate.messageId,
      ok: true,
      workItemId: existing.id,
      decision: 'accept',
    };
  }
  refuseDecided(router, candidate);
  const title = typeof route.title === 'string' ? route.title.trim() : '';
  if (!title) fail('accept needs a title.');
  if ([...title].length > TITLE_LIMIT) {
    fail(`title is limited to ${TITLE_LIMIT} characters.`);
  }
  const acknowledgement = requireImText(
    route.acknowledgement,
    'acknowledgement',
  );
  const note = optionalText(route.note, 2000);
  if (note && countImWords(note) > NOTE_WORD_LIMIT) {
    fail(`note is limited to ${NOTE_WORD_LIMIT} words.`);
  }
  const facts = candidate.item.facts ?? {};
  const strength = facts.strength ?? 'explicit';
  const settings = context.settings;
  let matchedRules: WorkMandate['matchedRules'] = [];
  if (strength === 'inferred') {
    const enabled = settings.rules.filter((rule) => rule.enabled);
    const assessments = Array.isArray(route.ruleAssessments)
      ? route.ruleAssessments
      : [];
    const assessed = new Map(
      assessments.map((entry) => [entry?.ruleId, entry] as const),
    );
    const missing = enabled.filter((rule) => !assessed.has(rule.id));
    if (missing.length > 0) {
      fail(
        `ruleAssessments must judge every enabled rule; missing: ${missing.map((rule) => rule.id).join(', ')}.`,
      );
    }
    matchedRules = enabled
      .filter((rule) => assessed.get(rule.id)?.matched === true)
      .map(({ id, name, instruction }) => ({ id, name, instruction }));
    if (matchedRules.length === 0) {
      fail('No enabled rule matched this inferred candidate; use ignore.');
    }
    if (settings.acceptMode === 'observe') {
      decide(router, candidate, 'would_accept', {
        reason: note ?? title,
        ruleIds: matchedRules.map((rule) => rule.id),
      });
      return {
        triggerMessageId: candidate.messageId,
        ok: true,
        decision: 'would_accept',
      };
    }
    if (settings.acceptMode !== 'auto') {
      fail('This group does not accept inferred work.');
    }
  }
  const listed = facts.listed === true;
  const ownerImId = ownerImIdOf(context);
  const mandate: WorkMandate = {
    strength,
    requesterImId: facts.senderImId ?? null,
    requesterName: candidate.senderName || null,
    requesterListed: listed,
    requesterIsOwner: !!ownerImId && facts.senderImId === ownerImId,
    matchedRules,
    settingsVersion: settings.version,
    writable: strength === 'explicit' && listed,
  };

  let agentId: string;
  try {
    agentId = await createWorkerSession(context, title);
  } catch (error) {
    logger.warn(
      {
        err: error,
        channelJid: context.channelJid,
        trigger: candidate.messageId,
      },
      'Could not create the worker session of a work item',
    );
    fail(
      `Could not create the work item's session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const item = insertWorkItem({
    id: crypto.randomUUID(),
    workspaceJid: context.workspaceJid,
    workspaceFolder: context.workspace.folder,
    channelJid: context.channelJid,
    agentId,
    title,
    sourceMessageId: candidate.messageId,
    sourceRouteJid: context.channelJid,
    mandate,
    now: now(),
  });
  if (item.agentId !== agentId) {
    // Another process won the insert: its session does the work.
    const orphan = getAgent(agentId);
    if (orphan) {
      await deleteConversationSession({
        workspaceJid: context.workspaceJid,
        group: context.workspace,
        session: orphan,
      }).catch(() => undefined);
    }
    return {
      triggerMessageId: candidate.messageId,
      ok: true,
      workItemId: item.id,
      decision: 'accept',
    };
  }
  for (const key of teamTriggerKeys({
    messageId: candidate.messageId,
    threadId: facts.threadId,
  })) {
    subscribeWorkItem(item.id, context.channelJid, key, now());
  }
  decide(router, candidate, 'accept', {
    workItemId: item.id,
    reason: note ?? '',
    ruleIds: matchedRules.map((rule) => rule.id),
  });
  // The request itself, in full: the item's detail shows it as the original
  // message.
  recordWorkEvent({
    workItemId: item.id,
    kind: 'input',
    text: candidate.content,
    triggerMessageId: candidate.messageId,
    now: now(),
  });
  // The router's acknowledgement is this trigger's one ack: a worker's
  // work_ack on the same trigger is a duplicate.
  if (
    recordWorkEvent({
      workItemId: item.id,
      kind: 'ack',
      text: acknowledgement,
      triggerMessageId: candidate.messageId,
      now: now(),
    }) !== null
  ) {
    postTeamReply({
      channelJid: context.channelJid,
      quoteMessageId: candidate.messageId,
      text: acknowledgement,
      deliveryKey: `ack:${item.id}:${candidate.messageId}`,
      laneJid: router.laneJid,
      subscribeFor: item,
      purpose: 'ack',
    });
  }
  const rules = matchedRules
    .map((rule) => `${rule.name}: ${rule.instruction}`)
    .join('; ');
  injectTeamInput({
    workspaceJid: item.workspaceJid,
    agentId: item.agentId,
    messageId: `work-assignment-${item.id}`,
    content: candidate.content,
    senderName: candidate.senderName || undefined,
    item: {
      tag: 'work_assignment',
      attrs: [
        ['item', `#${item.seq}`],
        ['id', item.id],
        ['trigger', candidate.messageId],
        ['writable', String(mandate.writable)],
        ['rules', rules],
      ],
      ...(note ? { note } : {}),
      facts: { workItemId: item.id },
    },
  });
  logger.info(
    {
      workItemId: item.id,
      seq: item.seq,
      agentId,
      channelJid: context.channelJid,
      strength,
      writable: mandate.writable,
    },
    'Work item accepted',
  );
  broadcast(item);
  return {
    triggerMessageId: candidate.messageId,
    ok: true,
    workItemId: item.id,
    decision: 'accept',
  };
}

function requireExplicit(candidate: Candidate, kind: string): void {
  if (candidate.item.facts?.strength !== 'explicit') {
    fail(`${kind} needs an explicit candidate.`);
  }
}

function attachCandidate(
  router: RouterLane,
  candidate: Candidate,
  route: WorkRouteItem,
): WorkRouteResultItem {
  requireExplicit(candidate, 'attach');
  let item = requireGroupItem(router, route.workItemId);
  if (item.status === 'ended' && item.outcome === 'stopped') {
    fail('That work item was stopped by a person.');
  }
  refuseDecided(router, candidate);
  const note = optionalText(route.note, 2000);
  if (note && countImWords(note) > NOTE_WORD_LIMIT) {
    fail(`note is limited to ${NOTE_WORD_LIMIT} words.`);
  }
  const facts = candidate.item.facts ?? {};
  if (item.status === 'ended') {
    item = patchItem(item, { status: 'open', outcome: null, endedAt: null });
    recordWorkEvent({
      workItemId: item.id,
      kind: 'resume',
      triggerMessageId: candidate.messageId,
      now: now(),
    });
  }
  for (const key of teamTriggerKeys({
    messageId: candidate.messageId,
    threadId: facts.threadId,
  })) {
    subscribeWorkItem(item.id, item.channelJid, key, now());
  }
  decide(router, candidate, 'attach', {
    workItemId: item.id,
    reason: note ?? '',
  });
  recordWorkEvent({
    workItemId: item.id,
    kind: 'input',
    triggerMessageId: candidate.messageId,
    now: now(),
  });
  injectTeamInput({
    workspaceJid: item.workspaceJid,
    agentId: item.agentId,
    messageId: followupCopyId(candidate.messageId, item.id),
    content: candidate.content,
    senderName: candidate.senderName || undefined,
    sourceJid: candidate.sourceJid ?? item.channelJid,
    item: followupInputItem({
      item,
      triggerMessageId: candidate.messageId,
      addressed: facts.addressed === true,
      senderImId: facts.senderImId,
      threadId: facts.threadId,
    }),
  });
  broadcast(item);
  return {
    triggerMessageId: candidate.messageId,
    ok: true,
    workItemId: item.id,
    decision: 'attach',
  };
}

function stopFromCandidate(
  router: RouterLane,
  candidate: Candidate,
  route: WorkRouteItem,
): WorkRouteResultItem {
  requireExplicit(candidate, 'stop');
  const item = requireGroupItem(router, route.workItemId);
  refuseDecided(router, candidate);
  decide(router, candidate, 'stop', {
    workItemId: item.id,
    reason: optionalText(route.reason, REASON_CHAR_LIMIT) ?? '',
  });
  if (item.status === 'open') broadcast(stopItem(item, candidate.messageId));
  return {
    triggerMessageId: candidate.messageId,
    ok: true,
    workItemId: item.id,
    decision: 'stop',
  };
}

async function routeOne(
  router: RouterLane,
  route: WorkRouteItem,
): Promise<WorkRouteResultItem> {
  const trigger =
    route && typeof route.triggerMessageId === 'string'
      ? route.triggerMessageId
      : '';
  try {
    const candidate = loadCandidate(router, trigger);
    switch (route.kind) {
      case 'accept': {
        const key = `${router.context.channelJid}\u0000${trigger}`;
        const inFlight = acceptsInFlight.get(key);
        if (inFlight) return await inFlight;
        const accepting = acceptCandidate(router, candidate, route);
        acceptsInFlight.set(key, accepting);
        try {
          return await accepting;
        } finally {
          acceptsInFlight.delete(key);
        }
      }
      case 'attach':
        return attachCandidate(router, candidate, route);
      case 'stop':
        return stopFromCandidate(router, candidate, route);
      case 'ignore': {
        const reason = optionalText(route.reason, REASON_CHAR_LIMIT);
        if (!reason) fail('ignore needs a reason.');
        refuseDecided(router, candidate);
        decide(router, candidate, 'ignore', { reason });
        return { triggerMessageId: trigger, ok: true, decision: 'ignore' };
      }
      default:
        fail('kind must be accept, attach, stop or ignore.');
    }
  } catch (error) {
    if (!(error instanceof WorkIpcError) && !(error instanceof WorkItemError)) {
      logger.error(
        { err: error, trigger, kind: route?.kind },
        'work_route item failed unexpectedly',
      );
    }
    return {
      triggerMessageId: trigger,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleWorkRoute(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const router = requireRouter(caller);
  const items = Array.isArray(payload.items)
    ? (payload.items as WorkRouteItem[])
    : fail('items must be a list.');
  if (items.length === 0) fail('items must not be empty.');
  const results: WorkRouteResultItem[] = [];
  for (const route of items) results.push(await routeOne(router, route));
  return { results };
}

function handleWorkReply(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): unknown {
  const router = requireRouter(caller);
  const text = requireImText(payload.text, 'text');
  const purpose = payload.purpose;
  const replyId = crypto.randomUUID();
  if (purpose === 'result' || purpose === 'attention') {
    const item = requireGroupItem(router, payload.workItemId);
    let quote: string;
    if (purpose === 'result') {
      if (
        item.lastReport !== 'ready' &&
        item.lastReport !== 'blocked' &&
        item.lastReport !== 'failed'
      ) {
        fail(
          'A result needs the item to have reported ready, blocked or failed.',
        );
      }
      quote = item.sourceMessageId;
    } else {
      if (!item.attention) fail('This work item is not waiting for anyone.');
      quote = item.attentionMessageId ?? item.sourceMessageId;
    }
    postTeamReply({
      channelJid: item.channelJid,
      quoteMessageId: quote,
      text,
      deliveryKey: `${purpose}:${item.id}:${replyId}`,
      laneJid: router.laneJid,
      subscribeFor: item,
      purpose,
    });
    return { queued: true };
  }
  if (purpose === 'answer') {
    const candidate = loadCandidate(router, payload.triggerMessageId);
    const decision = getWorkDecisionForTrigger(
      router.context.channelJid,
      candidate.messageId,
    );
    if (
      getWorkItemBySource(router.context.channelJid, candidate.messageId) ||
      decision?.kind === 'accept' ||
      decision?.kind === 'attach'
    ) {
      fail('That message belongs to a work item; answer through it.');
    }
    postTeamReply({
      channelJid: router.context.channelJid,
      quoteMessageId: candidate.messageId,
      text,
      deliveryKey: `answer:${candidate.messageId}:${replyId}`,
      laneJid: router.laneJid,
      purpose,
    });
    return { queued: true };
  }
  fail('purpose must be result, attention or answer.');
}

function handleWorkList(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): unknown {
  const router = requireRouter(caller);
  const status =
    payload.status === 'open' || payload.status === 'ended'
      ? payload.status
      : undefined;
  const limit =
    typeof payload.limit === 'number' && Number.isFinite(payload.limit)
      ? Math.min(Math.max(Math.trunc(payload.limit), 1), 100)
      : 30;
  const items = listWorkItems(router.context.workspaceJid, {
    status,
    limit: 500,
  })
    .filter((item) => item.channelJid === router.context.channelJid)
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      seq: item.seq,
      title: item.title,
      stage: deriveWorkStage(item),
      lastReport: item.lastReport,
      lastSummary: item.lastSummary,
      attention: item.attention,
      sourceMessageId: item.sourceMessageId,
    }));
  return { items };
}

const REPORT_STATES = new Set<WorkReportState>([
  'progress',
  'waiting',
  'ready',
  'blocked',
  'failed',
  'dropped',
]);

function handleWorkReport(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): unknown {
  const item = requireWorker(caller);
  if (item.status !== 'open') fail('This work item has ended.');
  const state = payload.state as WorkReportState;
  if (!REPORT_STATES.has(state)) fail('state is not a report state.');
  const summary = optionalText(payload.summary, SUMMARY_CHAR_LIMIT);
  if (!summary) fail('summary is required.');
  const humanAction = optionalText(payload.humanAction, 1000);
  const questionFor = optionalText(payload.questionForMessageId, 200);
  // An omitted humanAction keeps the open question; null clears it.
  const patch: WorkItemPatch = {
    lastReport: state,
    lastSummary: summary,
    ...(payload.humanAction !== undefined
      ? {
          attention: humanAction,
          attentionMessageId: humanAction ? questionFor : null,
        }
      : {}),
  };
  let updated: WorkItem;
  if (state === 'ready' && (item.mandate.writable || item.approvedAt)) {
    updated = endItem(item, 'completed', patch);
  } else if (state === 'dropped') {
    updated = endItem(item, 'dropped', { ...patch, attention: null });
  } else {
    updated = patchItem(item, patch);
  }
  const eventId = recordWorkEvent({
    workItemId: item.id,
    kind: 'report',
    state,
    text: summary,
    now: now(),
  });
  const runtime = getWorkItemRuntimeHooks();
  const workerLane = laneJidOf(item.workspaceJid, item.agentId);
  void runtime
    .postLaneMessage(workerLane, summary, `work-report-${item.id}-${eventId}`)
    .catch((error) =>
      logger.warn({ err: error, workItemId: item.id }, 'Report not stored'),
    );
  // Progress only updates the item; a dropped item ends silently.
  const forward =
    (state !== 'progress' || !!humanAction) && state !== 'dropped';
  const context = forward ? resolveTeamGroup(item.channelJid) : null;
  if (context?.routerAgentId) {
    injectTeamInput({
      workspaceJid: context.workspaceJid,
      agentId: context.routerAgentId,
      messageId: `work-report-${item.id}-${eventId}`,
      content: summary,
      item: {
        tag: 'work_report',
        attrs: [
          ['item', `#${item.seq}`],
          ['id', item.id],
          ['state', state],
          ['attention', humanAction ?? ''],
        ],
        facts: { workItemId: item.id },
      },
    });
  }
  broadcast(updated);
  return {};
}

/** The trigger was delivered to this item (its source or a follow-up). */
function wasDeliveredTo(item: WorkItem, triggerMessageId: string): boolean {
  if (item.sourceMessageId === triggerMessageId) return true;
  return listWorkEvents(item.id, 1000).some(
    (event) =>
      event.kind === 'input' && event.triggerMessageId === triggerMessageId,
  );
}

function handleWorkAck(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): unknown {
  const item = requireWorker(caller);
  const trigger =
    typeof payload.triggerMessageId === 'string'
      ? payload.triggerMessageId
      : '';
  if (!trigger || !wasDeliveredTo(item, trigger)) {
    fail('triggerMessageId is not a message delivered to this work item.');
  }
  const text = requireImText(payload.text, 'text');
  const eventId = recordWorkEvent({
    workItemId: item.id,
    kind: 'ack',
    text,
    triggerMessageId: trigger,
    now: now(),
  });
  if (eventId === null) return { duplicate: true };
  postTeamReply({
    channelJid: item.channelJid,
    quoteMessageId: trigger,
    text,
    deliveryKey: `ack:${item.id}:${trigger}`,
    laneJid: laneJidOf(item.workspaceJid, item.agentId),
    subscribeFor: item,
    purpose: 'ack',
  });
  return { duplicate: false };
}

function handleWorkHandback(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): unknown {
  const item = requireWorker(caller);
  const trigger =
    typeof payload.triggerMessageId === 'string'
      ? payload.triggerMessageId
      : '';
  if (
    !trigger ||
    trigger === item.sourceMessageId ||
    !wasDeliveredTo(item, trigger)
  ) {
    fail('triggerMessageId is not a follow-up delivered to this work item.');
  }
  const reason = optionalText(payload.reason, REASON_CHAR_LIMIT);
  if (!reason) fail('reason is required.');
  const context = resolveTeamGroup(item.channelJid);
  if (!context?.routerAgentId) fail('Team mode is off for this group.');
  const routerLane = laneJidOf(context.workspaceJid, context.routerAgentId);
  if (getAgentBuilderInputMessage(routerLane, handbackInputId(trigger))) {
    return {};
  }
  const workerLane = laneJidOf(item.workspaceJid, item.agentId);
  const row =
    getAgentBuilderInputMessage(workerLane, trigger) ??
    getAgentBuilderInputMessage(workerLane, followupCopyId(trigger, item.id));
  const original = row ? readTeamInput(row.attachments) : null;
  if (!row || !original) fail('The follow-up is no longer stored.');
  const facts = original.facts ?? {};
  const listed = isTeamListed(context, facts.senderImId);
  const addressed = facts.addressed === true;
  const strength = admitMessage(context.settings, {
    listed,
    addressed,
    fromBot: false,
  });
  if (strength === 'ignore') {
    fail(
      'The group would not admit this message as a request; keep or drop it.',
    );
  }
  unsubscribeWorkItem(
    item.id,
    item.channelJid,
    subscriptionKey('msg', trigger),
  );
  recordWorkEvent({
    workItemId: item.id,
    kind: 'handback',
    text: reason,
    triggerMessageId: trigger,
    now: now(),
  });
  injectTeamInput({
    workspaceJid: context.workspaceJid,
    agentId: context.routerAgentId,
    messageId: handbackInputId(trigger),
    content: row.content,
    senderName: row.sender_name ?? undefined,
    sourceJid: row.source_jid ?? item.channelJid,
    item: candidateInputItem({
      triggerMessageId: trigger,
      strength,
      listed,
      addressed,
      settings: context.settings,
      threadItems: [item],
      senderImId: facts.senderImId,
      threadId: facts.threadId,
      handback: { item, reason },
    }),
  });
  broadcast(getWorkItem(item.id) ?? item);
  return {};
}

/** Run one team tool call; never throws. */
export async function handleWorkIpc(
  caller: WorkIpcCaller,
  request: { type: string } & Record<string, unknown>,
): Promise<WorkIpcResult> {
  try {
    let data: unknown;
    switch (request.type) {
      case 'work_route':
        data = await handleWorkRoute(caller, request);
        break;
      case 'work_reply':
        data = handleWorkReply(caller, request);
        break;
      case 'work_list':
        data = handleWorkList(caller, request);
        break;
      case 'work_report':
        data = handleWorkReport(caller, request);
        break;
      case 'work_ack':
        data = handleWorkAck(caller, request);
        break;
      case 'work_handback':
        data = handleWorkHandback(caller, request);
        break;
      default:
        fail('Unknown team tool.');
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof WorkIpcError || error instanceof WorkItemError) {
      return { ok: false, error: error.message };
    }
    logger.error(
      { err: error, type: request.type, agentId: caller.agentId },
      'Team tool call failed unexpectedly',
    );
    return { ok: false, error: 'Internal error while handling the team tool.' };
  }
}

// ── Session deletion ───────────────────────────────────────────────────

/**
 * A deleted session leaves no live team state behind: its work item ends
 * stopped (nothing can run it any more), and a deleted router stops routing
 * until the group's settings are saved again (which creates a new one).
 */
export function onTeamSessionDeleted(agentId: string): void {
  const item = getWorkItemByAgent(agentId);
  if (item && item.status === 'open') {
    const ended = endItem(item, 'stopped', { attention: null });
    recordWorkEvent({
      workItemId: item.id,
      kind: 'stop',
      text: 'session_deleted',
      now: now(),
    });
    broadcast(ended);
  }
  const team = getTeamMountByRouter(agentId);
  if (team) {
    storeTeamMountSettings({
      channelJid: team.channelJid,
      workspaceJid: team.workspaceJid,
      settings: team.settings,
      routerAgentId: null,
      updatedBy: null,
      now: now(),
    });
  }
}

/** Open work items of a group, for `/status`. */
export function countOpenWorkItems(channelJid: string): number {
  const team = getTeamMount(channelJid);
  if (!team) return 0;
  return listWorkItems(team.workspaceJid, {
    status: 'open',
    limit: 500,
  }).filter((item) => item.channelJid === channelJid).length;
}
