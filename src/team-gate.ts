/**
 * Team mode (团队模式): where an inbound group message goes.
 *
 * Every message of a team-mode group lands in exactly one of three places,
 * decided here before the @ gate and before anything is stored:
 *
 * 1. subscribed — its parent, root or thread is subscribed by a work item:
 *    the message goes to that item's worker (the first item gets the real
 *    message, further items a copy). No @ is needed. An ended item (not
 *    stopped) is resumed by a person's message, unless its mandate relied on
 *    the requester being listed and they no longer are.
 * 2. candidate — `admitMessage` turns it into an explicit request or an
 *    inferred candidate: it goes to the group's router session.
 * 3. ignore — handled exactly like a message that failed the activation gate.
 *
 * The decision is pure over the lookups in `TeamGateDeps`. The connector asks
 * for it once (through the conversation plan) and the inbound router reads
 * the same decision back from a small cache keyed by chat and message, so the
 * gate and the route can never disagree.
 */
import { escapeXml } from './message-prompt.js';
import {
  admitMessage,
  subscriptionKey,
  type TeamSettings,
  type WorkItem,
  type WorkStrength,
} from './work-items.js';

// ── Subscription keys ──────────────────────────────────────────────────

/** The keys a message reaches work items through: its parent, root, thread. */
export function teamMessageKeys(meta: {
  parentId?: string;
  rootId?: string;
  threadId?: string;
}): string[] {
  const keys = new Set<string>();
  if (meta.parentId) keys.add(subscriptionKey('msg', meta.parentId));
  if (meta.rootId) keys.add(subscriptionKey('msg', meta.rootId));
  if (meta.threadId) keys.add(subscriptionKey('thread', meta.threadId));
  return [...keys];
}

/** The keys a work item subscribes for a trigger: the message and its thread. */
export function teamTriggerKeys(trigger: {
  messageId: string;
  threadId?: string | null;
}): string[] {
  const keys = [subscriptionKey('msg', trigger.messageId)];
  if (trigger.threadId) keys.push(subscriptionKey('thread', trigger.threadId));
  return keys;
}

// ── The decision ───────────────────────────────────────────────────────

/** A team-mode group as the gate sees it. */
export interface TeamGateGroup {
  /** The group's conversation JID (account-scoped `feishu:oc_…`). */
  channelJid: string;
  workspaceJid: string;
  settings: TeamSettings;
  routerAgentId: string;
}

export interface TeamInboundMessage {
  messageId: string;
  parentId?: string;
  rootId?: string;
  threadId?: string;
  senderImId?: string;
  senderIsBot?: boolean;
  /** A structural @ of the bot (Feishu mention metadata, not text). */
  mentionedBot: boolean;
}

export interface TeamGateDeps {
  /** Subscribed items, oldest first; items a person stopped are excluded. */
  findSubscribedItems(channelJid: string, keys: string[]): WorkItem[];
  /** The workspace owner or a sender on the group allowlist. */
  isListed(senderImId: string | undefined): boolean;
  /** One of the bot's own messages in this group. */
  isOwnBotMessage(messageId: string): boolean;
  /** The item's worker session still exists. */
  hasWorker(item: WorkItem): boolean;
}

export type TeamInboundDecision =
  | {
      kind: 'subscribed';
      channelJid: string;
      workspaceJid: string;
      /** Items the message reaches, the first gets the real message. */
      items: WorkItem[];
      /** Ended items among `items` that this message resumes. */
      resumeIds: string[];
    }
  | {
      kind: 'candidate';
      channelJid: string;
      workspaceJid: string;
      routerAgentId: string;
      strength: WorkStrength;
      listed: boolean;
      addressed: boolean;
      /** Items already subscribed on the thread that this message did not reach. */
      threadItems: WorkItem[];
    }
  | { kind: 'ignore'; channelJid: string; reason: string };

/** Whether an ended item may be resumed by a person's message. */
function canResume(item: WorkItem, deps: TeamGateDeps): boolean {
  if (!item.mandate.requesterListed) return true;
  return deps.isListed(item.mandate.requesterImId ?? undefined);
}

export function decideTeamInbound(
  group: TeamGateGroup,
  message: TeamInboundMessage,
  deps: TeamGateDeps,
): TeamInboundDecision {
  const fromBot = message.senderIsBot === true;
  const found = deps
    .findSubscribedItems(group.channelJid, teamMessageKeys(message))
    .filter((item) => deps.hasWorker(item));
  // A bot never resumes anything; a person resumes an ended item only when
  // its mandate still holds.
  const reached = found.filter(
    (item) => item.status === 'open' || (!fromBot && canResume(item, deps)),
  );
  if (reached.length > 0) {
    return {
      kind: 'subscribed',
      channelJid: group.channelJid,
      workspaceJid: group.workspaceJid,
      items: reached,
      resumeIds: reached
        .filter((item) => item.status === 'ended')
        .map((item) => item.id),
    };
  }
  const listed = !fromBot && deps.isListed(message.senderImId);
  const addressed =
    message.mentionedBot ||
    (!!message.parentId && deps.isOwnBotMessage(message.parentId));
  const outcome = admitMessage(group.settings, { listed, addressed, fromBot });
  if (outcome === 'ignore') {
    return {
      kind: 'ignore',
      channelJid: group.channelJid,
      reason: fromBot ? 'from_bot' : 'not_admitted',
    };
  }
  return {
    kind: 'candidate',
    channelJid: group.channelJid,
    workspaceJid: group.workspaceJid,
    routerAgentId: group.routerAgentId,
    strength: outcome,
    listed,
    addressed,
    threadItems: found,
  };
}

// ── Decision cache (gate → route) ──────────────────────────────────────

const DECISIONS_KEPT = 2000;
const decisions = new Map<string, TeamInboundDecision>();

function decisionKey(channelJid: string, messageId: string): string {
  return `${channelJid}\u0000${messageId}`;
}

export function rememberTeamDecision(
  channelJid: string,
  messageId: string,
  decision: TeamInboundDecision,
): void {
  const key = decisionKey(channelJid, messageId);
  decisions.delete(key);
  decisions.set(key, decision);
  if (decisions.size > DECISIONS_KEPT) {
    const oldest = decisions.keys().next().value as string | undefined;
    if (oldest !== undefined) decisions.delete(oldest);
  }
}

export function recallTeamDecision(
  channelJid: string,
  messageId: string | undefined,
): TeamInboundDecision | undefined {
  return messageId
    ? decisions.get(decisionKey(channelJid, messageId))
    : undefined;
}

// ── Model-facing input headers ─────────────────────────────────────────

export const TEAM_INPUT_ATTACHMENT_TYPE = 'team_input';

export type TeamInputTag =
  | 'team_candidate'
  | 'work_followup'
  | 'work_report'
  | 'work_assignment'
  | 'work_approved';

/**
 * The header a team input carries, stored as a hidden attachment item next
 * to any images (the Web renders image items only). The agent receives the
 * header on the line before the message text. `sender` attributes are filled
 * from the stored message's sender name when rendered, because the connector
 * resolves the display name after the decision is made.
 */
export interface TeamInputItem {
  type: typeof TEAM_INPUT_ATTACHMENT_TYPE;
  tag: TeamInputTag;
  /** Attribute pairs in order; a null value takes the sender's name. */
  attrs: [string, string | null][];
  /** work_assignment: the content is the request, this is the router note. */
  note?: string;
  /**
   * An inferred team_candidate: the group's enabled rules when it arrived,
   * rendered right after the header so the system prompt never changes with
   * the rules.
   */
  rules?: { id: string; name: string; instruction: string }[];
  /** Facts the host reads back (never rendered). */
  facts?: {
    strength?: WorkStrength;
    listed?: boolean;
    addressed?: boolean;
    senderImId?: string;
    threadId?: string;
    workItemId?: string;
    /** A subscribed message: the further items that received a copy. */
    copyItemIds?: string[];
  };
}

function parseAttachments(json: string | null | undefined): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isTeamInputItem(item: unknown): item is TeamInputItem {
  if (!item || typeof item !== 'object') return false;
  const value = item as Record<string, unknown>;
  return (
    value.type === TEAM_INPUT_ATTACHMENT_TYPE &&
    typeof value.tag === 'string' &&
    Array.isArray(value.attrs)
  );
}

export function readTeamInput(
  attachmentsJson: string | null | undefined,
): TeamInputItem | null {
  // Every prompt reads every message: parse only rows that can carry one.
  if (!attachmentsJson?.includes(`"${TEAM_INPUT_ATTACHMENT_TYPE}"`)) {
    return null;
  }
  return parseAttachments(attachmentsJson).find(isTeamInputItem) ?? null;
}

/** `attachmentsJson` with the team item added (replacing an earlier one). */
export function withTeamInputAttachment(
  attachmentsJson: string | null | undefined,
  item: TeamInputItem,
): string {
  const rest = parseAttachments(attachmentsJson).filter(
    (entry) => !isTeamInputItem(entry),
  );
  return JSON.stringify([...rest, item]);
}

/**
 * The full body the agent reads for a team input: the header tag, then the
 * text (escaped like any message body), an assignment's request and note
 * wrapped in their own elements.
 */
export function renderTeamInputBody(
  item: TeamInputItem,
  message: { content: string; sender_name: string },
): string {
  const attrs = item.attrs
    .map(
      ([name, value]) =>
        ` ${name}="${escapeXml(value ?? message.sender_name)}"`,
    )
    .join('');
  const header = `<${item.tag}${attrs}/>`;
  if (item.tag === 'work_approved') return header;
  if (item.rules?.length) {
    const rules = item.rules
      .map(
        (rule) =>
          `- ${escapeXml(rule.name)} (${escapeXml(rule.id)}): ${escapeXml(rule.instruction)}`,
      )
      .join('\n');
    return `${header}\n<team_rules>\n${rules}\n</team_rules>\n${escapeXml(message.content)}`;
  }
  if (item.tag === 'work_assignment') {
    const note = item.note ? `\n<note>${escapeXml(item.note)}</note>` : '';
    return `${header}\n<request>${escapeXml(message.content)}</request>${note}`;
  }
  return `${header}\n${escapeXml(message.content)}`;
}

/**
 * Format a batch with each team input's body rendered by
 * {@link renderTeamInputBody}. The formatter escapes every body, so a team
 * input's body is swapped for a token it leaves alone and put back after:
 * a person cannot forge a header by typing one.
 */
export function formatWithTeamInputs<
  T extends { content: string; sender_name: string; attachments?: string },
>(messages: T[], format: (messages: T[]) => string): string {
  const bodies: string[] = [];
  const prepared = messages.map((message) => {
    const item = readTeamInput(message.attachments);
    if (!item) {
      // No other body may carry a token of its own.
      return message.content.includes('\u0000')
        ? { ...message, content: message.content.replace(/\u0000/g, '') }
        : message;
    }
    bodies.push(renderTeamInputBody(item, message));
    return {
      ...message,
      content: `\u0000team-input:${bodies.length - 1}\u0000`,
    };
  });
  if (bodies.length === 0) return format(messages);
  return format(prepared).replace(
    /\u0000team-input:(\d+)\u0000/g,
    (token, index: string) => bodies[Number(index)] ?? token,
  );
}

/** `#12 open,#9 ended`: the items a candidate's thread already has. */
function threadItemsAttr(items: readonly WorkItem[]): string {
  return items.map((item) => `#${item.seq} ${item.status}`).join(',');
}

/** The header of a message the router receives as a candidate. */
export function candidateInputItem(input: {
  triggerMessageId: string;
  strength: WorkStrength;
  listed: boolean;
  addressed: boolean;
  settings: TeamSettings;
  threadItems: readonly WorkItem[];
  senderImId?: string;
  threadId?: string;
  /** Present on a hand-back: the item that returned it and why. */
  handback?: { item: WorkItem; reason: string };
}): TeamInputItem {
  const attrs: [string, string | null][] = [
    ['trigger', input.triggerMessageId],
    ['strength', input.strength],
    ['sender', null],
    ['listed', String(input.listed)],
    ['addressed', String(input.addressed)],
    ['items', threadItemsAttr(input.threadItems)],
  ];
  const inferred = input.strength === 'inferred';
  if (inferred) attrs.push(['mode', input.settings.acceptMode]);
  if (input.handback) {
    attrs.push(['handed_back_by', `#${input.handback.item.seq}`]);
    attrs.push(['reason', input.handback.reason]);
  }
  return {
    type: TEAM_INPUT_ATTACHMENT_TYPE,
    tag: 'team_candidate',
    attrs,
    ...(inferred
      ? {
          rules: input.settings.rules
            .filter((rule) => rule.enabled)
            .map(({ id, name, instruction }) => ({ id, name, instruction })),
        }
      : {}),
    facts: {
      strength: input.strength,
      listed: input.listed,
      addressed: input.addressed,
      senderImId: input.senderImId,
      threadId: input.threadId,
    },
  };
}

/** The header of a group message a worker receives on its thread. */
export function followupInputItem(input: {
  item: WorkItem;
  triggerMessageId: string;
  addressed: boolean;
  senderImId?: string;
  threadId?: string;
  copyItemIds?: string[];
}): TeamInputItem {
  return {
    type: TEAM_INPUT_ATTACHMENT_TYPE,
    tag: 'work_followup',
    attrs: [
      ['item', `#${input.item.seq}`],
      ['trigger', input.triggerMessageId],
      ['sender', null],
    ],
    facts: {
      workItemId: input.item.id,
      addressed: input.addressed,
      senderImId: input.senderImId,
      threadId: input.threadId,
      ...(input.copyItemIds?.length ? { copyItemIds: input.copyItemIds } : {}),
    },
  };
}
