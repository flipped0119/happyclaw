/**
 * Agent tools for team mode (团队模式).
 *
 * The router session routes candidates (`work_route`), speaks in the group
 * (`work_reply`) and reads the group's work items (`work_list`); a worker
 * session confirms a request once (`work_ack`), reports to the router
 * (`work_report`) and hands back what is beyond its item (`work_handback`).
 *
 * Each call writes one request into the task IPC directory and waits for
 * `<type>_result`: `{ ok: true, data } | { ok: false, error }`. The host
 * derives the caller (workspace, session, role) from the IPC directory and
 * rechecks every rule; the local checks only catch obvious mistakes early,
 * before anything is sent.
 */

import { randomUUID } from 'node:crypto';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  strict,
  strictObject,
  text,
  type ToolResult,
} from './automation-tools.js';

import {
  TEAM_IM_WORD_LIMIT,
  countImWords,
  type TeamRole,
  type WorkIpcType,
  type WorkReportState,
  type WorkRouteItem,
  type WorkRouteResultItem,
} from './work-items.js';

/** Writes the request and resolves with the host's result; throws on timeout. */
export type WorkIpcCall = (
  request: Record<string, unknown> & { type: WorkIpcType; requestId: string },
  resultPrefix: string,
  timeoutMs: number,
) => Promise<Record<string, unknown>>;

type WorkIpcResult =
  | { ok: true; data?: Record<string, unknown> }
  | { ok: false; error?: string };

/** The routing note's ceiling, in `countImWords` words. */
const ROUTE_NOTE_WORD_LIMIT = 30;
const TITLE_CHAR_LIMIT = 60;

/** Accepting creates sessions and maybe a git worktree, so it waits longer. */
const ROUTE_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const REPORT_STATES = [
  'progress',
  'waiting',
  'ready',
  'blocked',
  'failed',
  'dropped',
] as const satisfies readonly WorkReportState[];

function overWordLimit(label: string, value: string, limit: number) {
  // Every word is at least one character, so a short text needs no count.
  if (value.length <= limit) return null;
  const words = countImWords(value);
  return words > limit
    ? `${label} is ${words} words; the limit is ${limit}`
    : null;
}

/** What a route item is missing for its kind; empty when it can be sent. */
function routeItemErrors(item: WorkRouteItem): string[] {
  const errors: string[] = [];
  const need = (field: keyof WorkRouteItem) => {
    const value = item[field];
    if (typeof value !== 'string' || !value.trim())
      errors.push(`${item.kind} needs ${field}`);
  };
  if (item.kind === 'accept') {
    need('title');
    need('acknowledgement');
    if (item.acknowledgement) {
      const over = overWordLimit(
        'acknowledgement',
        item.acknowledgement,
        TEAM_IM_WORD_LIMIT,
      );
      if (over) errors.push(over);
    }
  } else if (item.kind === 'attach' || item.kind === 'stop') {
    need('workItemId');
  } else {
    need('reason');
  }
  if (item.note) {
    const over = overWordLimit('note', item.note, ROUTE_NOTE_WORD_LIMIT);
    if (over) errors.push(over);
  }
  return errors;
}

function describeRouteResult(result: WorkRouteResultItem): string {
  if (!result.ok)
    return `- ${result.triggerMessageId}: refused: ${result.error ?? 'unknown error'}`;
  const parts = [result.decision ?? 'done'];
  if (result.workItemId) parts.push(`work item ${result.workItemId}`);
  return `- ${result.triggerMessageId}: ${parts.join(', ')}`;
}

interface WorkListEntry {
  id: string;
  seq: number;
  title: string;
  stage: string;
  lastReport: string | null;
  lastSummary: string | null;
  attention: string | null;
  sourceMessageId: string;
}

function describeListEntry(item: WorkListEntry): string {
  const parts = [
    `#${item.seq} ${item.title}`,
    `id: ${item.id}`,
    `stage: ${item.stage}`,
    `last report: ${item.lastReport ?? 'none'}`,
    `source: ${item.sourceMessageId}`,
  ];
  if (item.attention) parts.push(`waiting on a person: ${item.attention}`);
  if (item.lastSummary) parts.push(`summary: ${item.lastSummary}`);
  return `- ${parts.join(' · ')}`;
}

const routeItemSchema = strictObject({
  kind: z
    .enum(['accept', 'attach', 'stop', 'ignore'])
    .describe(
      'accept: new work; attach: the message continues an existing work item; stop: an explicit candidate asks to stop an item; ignore: not work',
    ),
  triggerMessageId: z
    .string()
    .min(1)
    .describe(
      'The candidate\'s trigger, exactly as <team_candidate trigger="...">',
    ),
  title: z
    .string()
    .max(TITLE_CHAR_LIMIT)
    .optional()
    .describe(
      `accept: a short title for people, at most ${TITLE_CHAR_LIMIT} characters`,
    ),
  workItemId: z
    .string()
    .optional()
    .describe('attach/stop: the work item id (from work_list or the card)'),
  acknowledgement: z
    .string()
    .optional()
    .describe(
      `accept: one short sentence posted as a reply to the request, naming the change and the intended result, in the requester's language; at most ${TEAM_IM_WORD_LIMIT} words`,
    ),
  note: z
    .string()
    .optional()
    .describe(
      `accept/attach: routing background or an explicit human constraint for the worker, at most ${ROUTE_NOTE_WORD_LIMIT} words; never a plan`,
    ),
  reason: z
    .string()
    .optional()
    .describe(
      'ignore: why (required); other kinds: optional, for the decision log',
    ),
  ruleAssessments: z
    .array(
      strictObject({
        ruleId: z.string().min(1),
        matched: z.boolean(),
        reason: z.string().min(1).describe('A factual reason'),
      }),
    )
    .optional()
    .describe(
      'Inferred candidates: exactly one entry for every enabled rule, matched or not',
    ),
});

/**
 * `currentInputTurnId` is read when each request is written: the host judges
 * the request by the input it names. Requests carry only the contract's
 * fields; the host never takes the caller from the body.
 */
export function createWorkTools(
  teamRole: TeamRole,
  call: WorkIpcCall,
  currentInputTurnId: () => string | null | undefined,
): SdkMcpToolDefinition<any>[] {
  /**
   * Send and turn the host's answer into tool text. A timeout leaves the
   * outcome of a write unknown, so it is checked before it is retried.
   */
  const send = async (
    type: WorkIpcType,
    payload: object,
    onSuccess: (data: Record<string, unknown>) => string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ToolResult> => {
    const inputTurnId = currentInputTurnId();
    const request = {
      type,
      requestId: randomUUID(),
      ...(inputTurnId ? { inputTurnId } : {}),
      ...payload,
    };
    let result: WorkIpcResult;
    try {
      result = (await call(
        request,
        `${type}_result`,
        timeoutMs,
      )) as unknown as WorkIpcResult;
    } catch {
      return text(
        type === 'work_list'
          ? 'The host did not answer in time; try again shortly.'
          : `The host did not confirm in time; ${type} may have taken effect. Check with ${teamRole.role === 'router' ? 'work_list' : 'the next input'} before retrying.`,
        true,
      );
    }
    if (!result.ok) return text(result.error || `${type} failed`, true);
    return text(onSuccess(result.data ?? {}));
  };

  if (teamRole.role === 'router') {
    return [
      tool(
        'work_route',
        `Decide team candidates (<team_candidate> inputs), one item per candidate, several in one call. Each item is judged on its own and gets its own result.
- accept: new work. Needs title and acknowledgement. An inferred candidate needs ruleAssessments with one entry for every enabled rule and at least one matched; under acceptMode observe it is only recorded.
- attach: only when the message explicitly points at that work item (quotes or replies to its request or its messages, names it, or refers to the change just made and exactly one item fits). A similar topic is not enough: accept or ignore it instead. Needs workItemId and an explicit candidate; never attach a hand-back to the item that handed it back.
- stop: a listed person explicitly asks to stop an item. Needs workItemId and an explicit candidate.
- ignore: ordinary discussion, thanks, a duplicate, or anything that is not work. Needs reason.
note is at most ${ROUTE_NOTE_WORD_LIMIT} words of routing background; the worker reads the original message, so never add a plan, requirements or checklists.`,
        strict({
          items: z
            .array(routeItemSchema)
            .min(1)
            .describe('One decision per candidate'),
        }),
        async ({ items }) => {
          const errors = (items as WorkRouteItem[]).flatMap((item) =>
            routeItemErrors(item).map(
              (error) => `${item.triggerMessageId}: ${error}`,
            ),
          );
          if (errors.length > 0)
            return text(
              `Nothing was sent; fix these and call again: ${errors.join('; ')}`,
              true,
            );
          return send(
            'work_route',
            { items },
            (data) => {
              const results = (data.results ?? []) as WorkRouteResultItem[];
              return results.length
                ? results.map(describeRouteResult).join('\n')
                : 'Routed.';
            },
            ROUTE_TIMEOUT_MS,
          );
        },
      ),

      tool(
        'work_reply',
        `Post one message in the group. This is the only way the team speaks; the host replies under the right message.
- result: deliver a work item's result. Only when its last report is ready (a <work_report state="ready"> arrived). Needs workItemId.
- attention: ask the one question a work item is waiting on a person for (its <work_report> carried attention). Needs workItemId; copy the question faithfully.
- answer: a short direct answer to a candidate that asked a question and belongs to no work item. Needs triggerMessageId.
text is at most ${TEAM_IM_WORD_LIMIT} words (a hard ceiling, not a target), in the group's language; write a fresh message from the report's facts instead of forwarding it. Do not repeat an outcome already posted. A refused reply is final: do not rephrase it into another purpose or send it some other way.`,
        strict({
          purpose: z.enum(['result', 'attention', 'answer']),
          workItemId: z
            .string()
            .optional()
            .describe('result/attention: the work item id'),
          triggerMessageId: z
            .string()
            .optional()
            .describe('answer: the candidate trigger being answered'),
          text: z.string().trim().min(1),
        }),
        async (args) => {
          const errors: string[] = [];
          if (args.purpose === 'answer' && !args.triggerMessageId)
            errors.push('answer needs triggerMessageId');
          if (args.purpose !== 'answer' && !args.workItemId)
            errors.push(`${args.purpose} needs workItemId`);
          const over = overWordLimit('text', args.text, TEAM_IM_WORD_LIMIT);
          if (over) errors.push(over);
          if (errors.length > 0)
            return text(`Nothing was sent: ${errors.join('; ')}`, true);
          return send(
            'work_reply',
            args,
            () =>
              'Queued for the group. A queued reply is not yet delivered; do not send it again.',
          );
        },
      ),

      tool(
        'work_list',
        "List this group's work items: id, #number, title, stage, last report and summary, and any question waiting on a person. Use it to find the item a message points at, or to check state after a timeout or compaction. Never use it to investigate the work yourself.",
        strict({
          status: z
            .enum(['open', 'ended', 'all'])
            .optional()
            .describe('Default open'),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        async (args) =>
          send('work_list', args, (data) => {
            const items = (data.items ?? []) as WorkListEntry[];
            return items.length
              ? items.map(describeListEntry).join('\n')
              : 'No work items.';
          }),
      ),
    ];
  }

  return [
    tool(
      'work_ack',
      `Confirm once, before substantial work, that you are handling a person's request: the assignment's trigger, or a follow-up you will act on. The host replies under that message, so do not quote it. One short sentence naming the concrete object and intended result, in the requester's language, at most ${TEAM_IM_WORD_LIMIT} words. Never acknowledge bots, CI, thanks or plain discussion. A repeat for the same trigger is a no-op (duplicate=true) and keeps the first text.`,
      strict({
        triggerMessageId: z
          .string()
          .min(1)
          .describe('The trigger from <work_assignment> or <work_followup>'),
        text: z.string().trim().min(1),
      }),
      async (args) => {
        const over = overWordLimit('text', args.text, TEAM_IM_WORD_LIMIT);
        if (over) return text(`Nothing was sent: ${over}`, true);
        return send('work_ack', args, (data) =>
          data.duplicate === true
            ? 'Already acknowledged; nothing new was posted.'
            : 'Acknowledgement queued. Keep working; do not send it again.',
        );
      },
    ),

    tool(
      'work_report',
      `Report to the router. Only the router speaks to people, from this report.
- progress: internal bookkeeping; updates the item and wakes no one.
- waiting: you are idle until a person or a follow-up moves the item.
- ready: the result is usable and verified as far as you can; summary states the outcome a person cares about, then the evidence.
- blocked: you cannot go on until a person acts; name the concrete missing prerequisite.
- failed: you tried and it did not work; say what failed and what you tried.
- dropped: nothing for anyone to do (not reproduced, not a defect, already handled); ends the item without a message.
humanAction is the one concrete question a person must decide; it reaches the router at once with any state, including progress. Report honestly: a draft is not ready, and a failure is reported as failed.`,
      strict({
        state: z.enum(REPORT_STATES),
        summary: z
          .string()
          .trim()
          .min(1)
          .describe(
            'Concise facts for the router: outcome, changes, checks actually run, risks, links',
          ),
        humanAction: z
          .string()
          .nullable()
          .optional()
          .describe(
            'One specific question for a person; null clears an earlier one',
          ),
        questionForMessageId: z
          .string()
          .optional()
          .describe(
            "The person's message the question is about (e.g. a <work_followup> trigger), so the question is posted under it",
          ),
      }),
      async (args) =>
        send('work_report', args, () =>
          args.state === 'progress' && !args.humanAction
            ? 'Recorded.'
            : 'Reported to the router.',
        ),
    ),

    tool(
      'work_handback',
      "Hand a follow-up that is beyond this work item, or belongs to another one, back to the router as a new candidate. Do not acknowledge it. Only for a <work_followup> delivered to this item; a message on this item's thread that is in scope is yours to do.",
      strict({
        triggerMessageId: z
          .string()
          .min(1)
          .describe('The <work_followup> trigger'),
        reason: z
          .string()
          .trim()
          .min(1)
          .describe('One sentence: why it is not this item'),
      }),
      async (args) =>
        send('work_handback', args, () => 'Handed back to the router.'),
    ),
  ];
}
