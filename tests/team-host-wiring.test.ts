import { describe, expect, test, vi } from 'vitest';

import { isProviderAcknowledgeableInputId } from '../src/processing-indicator-batch.js';
import {
  candidateInputItem,
  readTeamInput,
  withTeamInputAttachment,
} from '../src/team-gate.js';
import { getChannelType } from '../src/im-channel.js';
import { laneJidOf } from '../src/work-item-runtime.js';
import { DEFAULT_TEAM_SETTINGS } from '../src/work-items.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const LANE = 'web:ws#agent:router-1';
const CHAT = 'feishu:oc_team';

function candidate(strength: 'explicit' | 'inferred') {
  return withTeamInputAttachment(
    null,
    candidateInputItem({
      triggerMessageId: 'om_x',
      strength,
      listed: true,
      addressed: strength === 'explicit',
      settings: {
        ...DEFAULT_TEAM_SETTINGS,
        enabled: true,
        acceptMode: 'auto',
        rules: [{ id: 'r1', name: 'CI', instruction: 'x', enabled: true }],
      },
      threadItems: [],
    }),
  );
}

describe('OnIt in team lanes', () => {
  function host(attachments: string) {
    const beginAckReaction = vi.fn(async () => {});
    const globals: Record<string, unknown> = {
      getChannelType,
      isProviderAcknowledgeableInputId,
      getAgentBuilderInputMessage: () => ({ attachments }),
      readTeamInput,
      imManager: { beginAckReaction },
      runAckIndicatorOp: (_jid: string, op: () => Promise<void>) => op(),
      logger: { warn: vi.fn() },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('isQuietTeamInput');
    harness.install('beginBatchAckReactions');
    return { globals, beginAckReaction };
  }
  const owners = [{ inputTurnId: 'om_x', transportJid: CHAT }];

  test('an inferred candidate gets no reaction', async () => {
    const { globals, beginAckReaction } = host(candidate('inferred'));
    await (globals.beginBatchAckReactions as (...a: unknown[]) => unknown)(
      LANE,
      owners,
    );
    expect(beginAckReaction).not.toHaveBeenCalled();
  });

  test('an explicit candidate gets OnIt', async () => {
    const { globals, beginAckReaction } = host(candidate('explicit'));
    await (globals.beginBatchAckReactions as (...a: unknown[]) => unknown)(
      LANE,
      owners,
    );
    expect(beginAckReaction).toHaveBeenCalledWith(CHAT, 'om_x');
  });
});

describe('framework notices of a team lane', () => {
  test('stay in the Web and never reach the group', async () => {
    const sendMessageWithOutcome = vi.fn(async () => ({ webProjected: true }));
    const start = vi.fn();
    const globals: Record<string, unknown> = {
      resolveTeamRole: (agentId: string | null) =>
        agentId === 'router-1' ? { role: 'router' } : null,
      agentIdOfJid: (jid: string) => jid.split('#agent:')[1] ?? null,
      sendMessageWithOutcome,
      ChannelTurnRuntime: { start },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('deliverIndependentChannelSystemNotice');
    const delivered = await (
      globals.deliverIndependentChannelSystemNotice as (
        input: Record<string, unknown>,
      ) => Promise<boolean>
    )({
      logicalChatJid: LANE,
      scopeKey: 'scope',
      targetJid: CHAT,
      originalInputTurnId: 'om_x',
      originalRunId: 'run',
      noticeKey: 'usage-limit-wait',
      text: '额度用尽',
      route: {},
    });
    expect(delivered).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(sendMessageWithOutcome).toHaveBeenCalledWith(LANE, '额度用尽', {
      sendToIM: false,
      messageId: 'sys_notice_om_x:usage-limit-wait',
    });
  });
});

describe('routing a team-mode group message', () => {
  function host(input: {
    teamGroup: boolean;
    cached?: unknown;
    fresh?: unknown;
    primary?: { outcome: string | null } | undefined;
  }) {
    const decideTeamMessage = vi.fn(() =>
      input.fresh ? { decision: input.fresh } : null,
    );
    const globals: Record<string, unknown> = {
      resolveTeamGroup: () => (input.teamGroup ? {} : null),
      recallTeamDecision: () => input.cached,
      getWorkItem: () => input.primary,
      decideTeamMessage,
      laneJidOf,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('resolveTeamRoute');
    const route = (meta?: Record<string, unknown>) =>
      (globals.resolveTeamRoute as (...a: unknown[]) => unknown)(CHAT, meta);
    return { route, decideTeamMessage };
  }
  const subscribed = (agentId: string) => ({
    kind: 'subscribed',
    workspaceJid: 'web:ws',
    items: [{ id: `w-${agentId}`, agentId }],
  });

  test('outside team mode nothing changes', () => {
    expect(host({ teamGroup: false }).route({ messageId: 'om_1' })).toBeNull();
  });

  test('a lost decision is made again, never the main session', () => {
    const fresh = host({ teamGroup: true, fresh: subscribed('a2') });
    expect(fresh.route({ messageId: 'om_1', senderImId: 'ou_x' })).toEqual({
      effectiveJid: 'web:ws#agent:a2',
      agentId: 'a2',
    });
    expect(fresh.decideTeamMessage).toHaveBeenCalled();
    // Nothing to decide with (no sender): rejected, not routed to main.
    expect(host({ teamGroup: true }).route({ messageId: 'om_1' })).toBe(
      'reject',
    );
    expect(
      host({ teamGroup: true, cached: { kind: 'ignore' } }).route({
        messageId: 'om_1',
      }),
    ).toBe('reject');
  });

  test('a decision whose first item was stopped is made again', () => {
    const stopped = host({
      teamGroup: true,
      cached: subscribed('a1'),
      primary: { outcome: 'stopped' },
      fresh: {
        kind: 'candidate',
        workspaceJid: 'web:ws',
        routerAgentId: 'router-1',
      },
    });
    expect(stopped.route({ messageId: 'om_1', senderImId: 'ou_x' })).toEqual({
      effectiveJid: LANE,
      agentId: 'router-1',
    });
    const live = host({
      teamGroup: true,
      cached: subscribed('a1'),
      primary: { outcome: null },
    });
    expect(live.route({ messageId: 'om_1' })).toEqual({
      effectiveJid: 'web:ws#agent:a1',
      agentId: 'a1',
    });
    expect(live.decideTeamMessage).not.toHaveBeenCalled();
  });
});

describe('where a stored follow-up fans out', () => {
  test('every stored IM message of a team lane, including a subsumed one', () => {
    const onTeamMessageStored = vi.fn();
    const broadcastNewMessage = vi.fn();
    const globals: Record<string, unknown> = {
      broadcastNewMessage,
      readTeamInput,
      onTeamMessageStored,
      logger: { error: vi.fn() },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('onImMessagePersisted');
    const persisted = globals.onImMessagePersisted as (...a: unknown[]) => void;
    const message = {
      id: 'om_f',
      delivery_status: 'subsumed',
      attachments: candidate('explicit'),
    };
    persisted('web:ws#agent:w1', message, 'w1');
    expect(broadcastNewMessage).toHaveBeenCalledWith(
      'web:ws#agent:w1',
      message,
      'w1',
    );
    expect(onTeamMessageStored).toHaveBeenCalledWith('web:ws#agent:w1', 'om_f');
    // Not a team message: broadcast only.
    persisted('web:ws', { id: 'om_g' }, undefined);
    expect(onTeamMessageStored).toHaveBeenCalledTimes(1);
  });
});
