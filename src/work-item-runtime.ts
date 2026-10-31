/**
 * Team mode (团队模式): the conversation-runtime side of work items.
 *
 * The work item service decides; this module moves inputs and replies:
 * - inputs the host composes for a router or worker session (assignment,
 *   follow-up copy, report, approval, hand-back) are ordinary message rows
 *   (source_kind 'work_item_input') carrying their header as a hidden
 *   `team_input` attachment item, admitted like an automation input;
 * - replies in the group are posted by the host, one chat at a time in the
 *   order they were asked for, through the durable Outbox (index.ts);
 * - what the bot said is also stored as an `is_from_me` row in the lane that
 *   said it, so the Web shows it and a reply to it is recognised.
 *
 * index.ts supplies the queue and channel primitives as hooks.
 */
import {
  getChannelTurnRun,
  type ChannelRouteSnapshot,
} from './channel-reliability-store.js';
import { ChannelTurnRuntime } from './channel-turn-runtime.js';
import { ensureChatExists, storeMessageDirect } from './db.js';
import { deliverFeishuCapabilityMutation } from './feishu-capability-outbox.js';
import type {
  FeishuCapabilityRequest,
  FeishuCapabilityResult,
} from './feishu-capability.js';
import { logger } from './logger.js';
import {
  TEAM_INPUT_ATTACHMENT_TYPE,
  withTeamInputAttachment,
  type TeamInputItem,
} from './team-gate.js';
import type { ChannelTurnContext, NewMessage } from './types.js';
import type { WorkItemWsEvent } from './work-items.js';

/** Where a team reply is posted: quoted under one message of the group. */
export interface TeamReplyRequest {
  /** The group's conversation JID (account-scoped `feishu:oc_…`). */
  channelJid: string;
  /** The provider message the reply quotes. */
  quoteMessageId: string;
  text: string;
  /** Stable identity: the same key never posts twice. */
  deliveryKey: string;
}

export type TeamReplyOutcome =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string };

export interface WorkItemRuntimeHooks {
  /** Admit a stored input like an inbound follow-up in `queue` mode. */
  admitInput(input: {
    laneJid: string;
    messageId: string;
    sourceJid: string;
  }): 'started' | 'queued';
  /** Start processing an idle Runtime Session. */
  wake(workspaceJid: string, agentId: string): void;
  broadcastNewMessage(laneJid: string, message: NewMessage): void;
  /** Stop the turn a lane is running now, if any (the lane stays usable). */
  interruptLane(laneJid: string): void;
  /** Post `text` quoted under a message of the group, in the main chat. */
  postReply(request: TeamReplyRequest): Promise<TeamReplyOutcome>;
  /** A bot message into a lane's Web transcript (never sent to IM). */
  postLaneMessage(
    laneJid: string,
    text: string,
    messageId: string,
  ): Promise<void>;
  broadcastWorkItemEvent(event: WorkItemWsEvent): void;
}

let hooks: WorkItemRuntimeHooks | null = null;

/** Set once at startup by index.ts; tests install fakes. */
export function setWorkItemRuntimeHooks(
  next: WorkItemRuntimeHooks | null,
): void {
  hooks = next;
}

export function getWorkItemRuntimeHooks(): WorkItemRuntimeHooks {
  if (!hooks) throw new Error('Work item runtime is not initialized');
  return hooks;
}

export function laneJidOf(workspaceJid: string, agentId: string): string {
  return `${workspaceJid}#agent:${agentId}`;
}

const TEAM_INPUT_SENDER = 'happyclaw-team';
const TEAM_INPUT_SENDER_NAME = 'HappyClaw';

/**
 * Store and admit an input the host composed for a team lane. The id is
 * fixed by the caller, so composing the same input twice is a no-op for the
 * agent (the row is replaced, the queue sees one input).
 */
export function injectTeamInput(input: {
  workspaceJid: string;
  agentId: string;
  messageId: string;
  /** What the Web shows and the agent reads after the header. */
  content: string;
  item: Omit<TeamInputItem, 'type'>;
  /**
   * The route the input belongs to. Copies of a group message keep the
   * group's JID, so recalling the message withdraws them as well; inputs
   * nobody typed in the group use the lane itself.
   */
  sourceJid?: string;
  senderName?: string;
}): void {
  const runtime = getWorkItemRuntimeHooks();
  const laneJid = laneJidOf(input.workspaceJid, input.agentId);
  const sourceJid = input.sourceJid ?? laneJid;
  const attachments = withTeamInputAttachment(null, {
    type: TEAM_INPUT_ATTACHMENT_TYPE,
    ...input.item,
  });
  const row = {
    id: input.messageId,
    chat_jid: laneJid,
    source_jid: sourceJid,
    sender: TEAM_INPUT_SENDER,
    sender_name: input.senderName ?? TEAM_INPUT_SENDER_NAME,
    content: input.content,
    timestamp: new Date().toISOString(),
    attachments,
    source_kind: 'work_item_input',
  } satisfies NewMessage;
  ensureChatExists(laneJid);
  storeMessageDirect(
    row.id,
    row.chat_jid,
    row.sender,
    row.sender_name,
    row.content,
    row.timestamp,
    false,
    {
      attachments,
      sourceJid,
      meta: { sourceKind: 'work_item_input' },
    },
  );
  const disposition = runtime.admitInput({
    laneJid,
    messageId: row.id,
    sourceJid,
  });
  // The header is for the agent: the Web shows the content alone.
  runtime.broadcastNewMessage(laneJid, { ...row, attachments: undefined });
  if (disposition === 'started')
    runtime.wake(input.workspaceJid, input.agentId);
}

// ── Replies in the group, one chat at a time ───────────────────────────

const replyChains = new Map<string, Promise<unknown>>();

/**
 * Post a reply after every reply already asked for in the same group, so
 * the group reads them in the order the sessions sent them. Never rejects.
 */
export function queueTeamReply(
  request: TeamReplyRequest,
): Promise<TeamReplyOutcome> {
  const previous = replyChains.get(request.channelJid) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => getWorkItemRuntimeHooks().postReply(request))
    .catch((error: unknown): TeamReplyOutcome => {
      logger.warn(
        {
          err: error,
          channelJid: request.channelJid,
          key: request.deliveryKey,
        },
        'Team reply delivery threw',
      );
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    });
  replyChains.set(request.channelJid, next);
  void next.finally(() => {
    if (replyChains.get(request.channelJid) === next) {
      replyChains.delete(request.channelJid);
    }
  });
  return next;
}

/** Test seam: wait for every queued reply. */
export async function flushTeamReplies(): Promise<void> {
  await Promise.all([...replyChains.values()]);
}

/**
 * Post one team reply: plain text quoted under a message of the group, in
 * the main chat (`reply_text`), through a turn and Outbox row of its own
 * keyed by the reply's identity, so a retry or a replay never posts twice.
 * Resolves to the provider message id, which the caller subscribes.
 */
export async function deliverTeamReplyThroughOutbox(
  request: TeamReplyRequest,
  route: ChannelRouteSnapshot,
  execute: (
    context: ChannelTurnContext,
    capability: FeishuCapabilityRequest,
  ) => Promise<FeishuCapabilityResult>,
): Promise<TeamReplyOutcome> {
  const runtime = ChannelTurnRuntime.start({
    ...route,
    externalMessageId: `team-reply:${request.deliveryKey}`,
    correlationId: request.quoteMessageId,
  });
  const disposition = runtime.executionDisposition;
  if (disposition !== 'execute') {
    runtime.dispose();
    // Already posted by an earlier attempt: report what it posted.
    const previous = getChannelTurnRun(runtime.runId);
    const posted = (
      previous?.result as { providerMessageId?: unknown } | null | undefined
    )?.providerMessageId;
    return previous?.status === 'completed'
      ? {
          ok: true,
          providerMessageId: typeof posted === 'string' ? posted : null,
        }
      : { ok: false, error: `Reply delivery is ${disposition}.` };
  }
  const context: ChannelTurnContext = {
    schemaVersion: 1,
    provider: 'feishu',
    channelAccountId: route.accountId,
    sourceJid: request.channelJid,
    chat: { id: route.chatId ?? '', type: 'group' },
    message: { id: request.quoteMessageId },
  };
  const capability: FeishuCapabilityRequest = {
    operation: 'reply_text',
    params: { messageId: request.quoteMessageId, text: request.text },
  };
  try {
    const mutation = await deliverFeishuCapabilityMutation({
      ...route,
      turnRunId: runtime.runId,
      request: capability,
      owner: `happyclaw-team-reply:${process.pid}:${runtime.runId}`,
      execute: () => execute(context, capability),
    });
    if (mutation.delivery.status !== 'delivered') {
      const error =
        mutation.delivery.status === 'uncertain'
          ? 'Reply delivery is uncertain; it needs manual reconciliation.'
          : mutation.delivery.error ||
            `Reply delivery ended as ${mutation.delivery.status}.`;
      if (mutation.delivery.status === 'uncertain') runtime.interrupt(error);
      else runtime.fail(error);
      return { ok: false, error };
    }
    const data = mutation.result?.data as { messageId?: unknown } | undefined;
    const providerMessageId =
      typeof data?.messageId === 'string' ? data.messageId : null;
    runtime.markFinalizing();
    runtime.complete({ providerMessageId });
    return { ok: true, providerMessageId };
  } catch (error) {
    runtime.fail(error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    runtime.dispose();
  }
}
