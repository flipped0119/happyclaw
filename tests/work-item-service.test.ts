import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-work-items-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    STORE_DIR: path.join(root, 'store'),
    GROUPS_DIR: path.join(root, 'groups'),
    DATA_DIR: root,
    isDockerAvailable: () => false,
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/work-item-store.js');
const service = await import('../src/work-item-service.js');
const runtime = await import('../src/work-item-runtime.js');
const gate = await import('../src/team-gate.js');
const webContext = await import('../src/web-context.js');

import type { NewMessage } from '../src/types.js';
import type { WorkItem } from '../src/work-items.js';

const OWNER = 'owner-1';
const WORKSPACE = 'web:team-ws';
const FOLDER = 'team-ws';
const CHAT = 'feishu:oc_team';
const ACTOR = { userId: OWNER, isAdmin: false };

let replySeq = 0;
const replies: runtime.TeamReplyRequest[] = [];
const laneMessages: { laneJid: string; text: string; id: string }[] = [];
const interrupted: string[] = [];
const broadcasts: string[] = [];
let failReplies = false;

function installHooks(): void {
  runtime.setWorkItemRuntimeHooks({
    admitInput: () => 'started',
    wake: vi.fn(),
    broadcastNewMessage: vi.fn(),
    interruptLane: (laneJid) => interrupted.push(laneJid),
    postReply: async (request) => {
      replies.push(request);
      if (failReplies) return { ok: false, error: 'rejected by Feishu' };
      return { ok: true, providerMessageId: `om_bot_${++replySeq}` };
    },
    postLaneMessage: async (laneJid, text, id) => {
      laneMessages.push({ laneJid, text, id });
      db.storeMessageDirect(
        id,
        laneJid,
        'happyclaw-agent',
        'HappyClaw',
        text,
        new Date().toISOString(),
        true,
      );
    },
    broadcastWorkItemEvent: (event) => broadcasts.push(event.item.id),
  });
}

function setGroup(jid: string, extra: Record<string, unknown> = {}): void {
  db.setRegisteredGroup(jid, {
    name: '研发群',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    created_by: OWNER,
    target_main_jid: WORKSPACE,
    feishu_chat_mode: 'group',
    owner_im_id: 'ou_owner',
    sender_allowlist: ['ou_listed'],
    channel_account_id: 'acct-1',
    ...extra,
  } as never);
}

async function enable(overrides: Record<string, unknown> = {}) {
  return service.saveTeamMountSettings(
    WORKSPACE,
    CHAT,
    {
      enabled: true,
      admission: {
        listedUnaddressed: 'inferred',
        unlistedAddressed: 'explicit',
        unlistedUnaddressed: 'ignore',
      },
      acceptMode: 'auto',
      rules: [
        { id: 'r1', name: 'CI', instruction: 'Fix red CI', enabled: true },
        { id: 'r2', name: 'Docs', instruction: 'Fix typos', enabled: true },
      ],
      ...overrides,
    },
    ACTOR,
  );
}

function routerCaller() {
  const team = store.getTeamMount(CHAT)!;
  return { folder: FOLDER, agentId: team.routerAgentId };
}

function routerLane(): string {
  return `${WORKSPACE}#agent:${store.getTeamMount(CHAT)!.routerAgentId}`;
}

/** A group message the connector stored in the router lane as a candidate. */
function storeCandidate(
  messageId: string,
  input: {
    strength?: 'explicit' | 'inferred';
    listed?: boolean;
    sender?: string;
    content?: string;
  } = {},
): void {
  const item = gate.candidateInputItem({
    triggerMessageId: messageId,
    strength: input.strength ?? 'explicit',
    listed: input.listed ?? true,
    addressed: true,
    settings: store.getTeamMount(CHAT)!.settings,
    threadItems: [],
    senderImId: input.sender ?? 'ou_listed',
  });
  db.storeMessageDirect(
    messageId,
    routerLane(),
    input.sender ?? 'ou_listed',
    '小王',
    input.content ?? '帮我修一下 CI',
    new Date().toISOString(),
    false,
    {
      sourceJid: CHAT,
      attachments: gate.withTeamInputAttachment(null, item),
    },
  );
}

async function route(item: Record<string, unknown>, caller = routerCaller()) {
  return service.handleWorkIpc(caller, {
    type: 'work_route',
    items: [item],
  });
}

async function accept(trigger: string, extra: Record<string, unknown> = {}) {
  const result = await route({
    kind: 'accept',
    triggerMessageId: trigger,
    title: '修 CI',
    acknowledgement: '收到，我来看看',
    ...extra,
  });
  expect(result.ok).toBe(true);
  return (result as { data: { results: Record<string, unknown>[] } }).data
    .results[0];
}

function workerCaller(item: WorkItem) {
  return { folder: FOLDER, agentId: item.agentId };
}

function laneRows(laneJid: string): NewMessage[] {
  return db.getMessagesSince(laneJid, { timestamp: '', id: '' });
}

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(WORKSPACE, {
    name: 'Team WS',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER,
  });
  setGroup(CHAT);
  webContext.setWebDeps({
    broadcastAgentStatus: vi.fn(),
    broadcastAgentRemoved: vi.fn(),
    queue: { stopGroup: vi.fn(async () => {}) },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
  installHooks();
});

beforeEach(() => {
  replies.length = 0;
  laneMessages.length = 0;
  interrupted.length = 0;
  broadcasts.length = 0;
  failReplies = false;
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('team mount settings', () => {
  test('enabling creates the router session and bumps the version', async () => {
    const first = await enable();
    expect(first.settings.version).toBe(1);
    const router = db.getAgent(first.routerAgentId!);
    expect(router).toMatchObject({
      source_kind: 'team_router',
      chat_jid: WORKSPACE,
      kind: 'conversation',
    });
    const second = await enable();
    expect(second.settings.version).toBe(2);
    expect(second.routerAgentId).toBe(first.routerAgentId);
    expect(service.listTeamMountViews(WORKSPACE)).toEqual([
      expect.objectContaining({ channelJid: CHAT, eligible: true }),
    ]);
  });

  test('a topic group or a private chat cannot run team mode', async () => {
    const topic = 'feishu:oc_topic';
    setGroup(topic, { feishu_chat_mode: 'topic' });
    expect(service.teamMountIneligibility(topic, WORKSPACE)).toMatch(/普通群/);
    await expect(
      service.saveTeamMountSettings(
        WORKSPACE,
        topic,
        { ...store.getTeamMount(CHAT)!.settings, enabled: true },
        ACTOR,
      ),
    ).rejects.toThrow(/普通群/);
  });
});

describe('work_route', () => {
  test('accept creates the item, its worker, its subscription and replies under the request', async () => {
    storeCandidate('om_req1');
    const result = await accept('om_req1', { note: '先看日志' });
    expect(result).toMatchObject({ ok: true, decision: 'accept' });
    const item = store.getWorkItem(result.workItemId as string)!;
    expect(item).toMatchObject({
      sourceMessageId: 'om_req1',
      status: 'open',
      mandate: { strength: 'explicit', writable: true, requesterListed: true },
    });
    expect(db.getAgent(item.agentId)).toMatchObject({
      source_kind: 'work_item',
      chat_jid: WORKSPACE,
    });
    await runtime.flushTeamReplies();
    // The acknowledgement is quoted under the request and its message is
    // subscribed for the item.
    expect(replies).toEqual([
      expect.objectContaining({
        channelJid: CHAT,
        quoteMessageId: 'om_req1',
        text: '收到，我来看看',
      }),
    ]);
    const keys = store
      .listWorkItemSubscriptions(item.id)
      .map((entry) => entry.subKey);
    expect(keys).toEqual(['msg:om_req1', `msg:om_bot_${replySeq}`]);
    // The ack is stored as the router's own message, so a reply to it is a
    // reply to the bot.
    const context = service.resolveTeamGroup(CHAT)!;
    expect(service.isTeamBotMessage(context, `om_bot_${replySeq}`)).toBe(true);
    // The worker receives its assignment.
    const [assignment] = laneRows(`${WORKSPACE}#agent:${item.agentId}`);
    expect(assignment.source_kind).toBe('work_item_input');
    expect(gate.readTeamInput(assignment.attachments)).toMatchObject({
      tag: 'work_assignment',
      note: '先看日志',
    });
    expect(broadcasts).toContain(item.id);
    expect(service.getWorkItemDetail(item.id)?.events[0]).toMatchObject({
      kind: 'input',
      triggerMessageId: 'om_req1',
      text: '帮我修一下 CI',
    });
    expect(service.listWorkItemViews(WORKSPACE)).toContainEqual(
      expect.objectContaining({
        id: item.id,
        workspaceName: 'Team WS',
        channelName: '研发群',
      }),
    );
    expect(store.getWorkDecisionForTrigger(CHAT, 'om_req1')?.kind).toBe(
      'accept',
    );
  });

  test('accept is idempotent by trigger, also when retried concurrently', async () => {
    storeCandidate('om_req2');
    const [a, b] = await Promise.all([accept('om_req2'), accept('om_req2')]);
    expect(a.workItemId).toBe(b.workItemId);
    const again = await accept('om_req2');
    expect(again.workItemId).toBe(a.workItemId);
    // The losing call's session was not kept: every worker has an item.
    const items = new Set(
      store.listWorkItems(WORKSPACE).map((item) => item.agentId),
    );
    const workers = db
      .listAgentsByJid(WORKSPACE)
      .filter((agent) => agent.source_kind === 'work_item');
    expect(workers.length).toBeGreaterThan(0);
    expect(workers.every((agent) => items.has(agent.id))).toBe(true);
  });

  test('observe only records would_accept for an inferred candidate', async () => {
    await enable({ acceptMode: 'observe' });
    storeCandidate('om_inf1', { strength: 'inferred' });
    const result = await accept('om_inf1', {
      ruleAssessments: [
        { ruleId: 'r1', matched: true, reason: 'CI is red' },
        { ruleId: 'r2', matched: false, reason: 'no' },
      ],
    });
    expect(result).toMatchObject({ ok: true, decision: 'would_accept' });
    expect(store.getWorkItemBySource(CHAT, 'om_inf1')).toBeUndefined();
    expect(store.getWorkDecisionForTrigger(CHAT, 'om_inf1')).toMatchObject({
      kind: 'would_accept',
      matchedRuleIds: ['r1'],
    });
    await enable({ acceptMode: 'auto' });
  });

  test('inferred needs a judgement of every rule and auto needs a match', async () => {
    storeCandidate('om_inf2', { strength: 'inferred' });
    const missing = await accept('om_inf2', {
      ruleAssessments: [{ ruleId: 'r1', matched: true, reason: 'red' }],
    });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.error).toMatch(/every enabled rule.*r2/);
    const none = await accept('om_inf2', {
      ruleAssessments: [
        { ruleId: 'r1', matched: false, reason: 'no' },
        { ruleId: 'r2', matched: false, reason: 'no' },
      ],
    });
    expect(none.error).toMatch(/No enabled rule matched/);
    const ok = await accept('om_inf2', {
      ruleAssessments: [
        { ruleId: 'r1', matched: true, reason: 'red' },
        { ruleId: 'r2', matched: false, reason: 'no' },
      ],
    });
    const item = store.getWorkItem(ok.workItemId as string)!;
    expect(item.mandate).toMatchObject({
      strength: 'inferred',
      writable: false,
      matchedRules: [{ id: 'r1', name: 'CI', instruction: 'Fix red CI' }],
    });
  });

  test('an explicit request from an unlisted sender is read-only', async () => {
    storeCandidate('om_unl', { listed: false, sender: 'ou_stranger' });
    const result = await accept('om_unl');
    expect(
      store.getWorkItem(result.workItemId as string)!.mandate,
    ).toMatchObject({ requesterListed: false, writable: false });
  });

  test('attach and stop need an explicit candidate; ignore needs a reason', async () => {
    storeCandidate('om_base');
    const base = await accept('om_base');
    storeCandidate('om_inf3', { strength: 'inferred' });
    const attachInferred = await route({
      kind: 'attach',
      triggerMessageId: 'om_inf3',
      workItemId: base.workItemId,
    });
    expect(
      (attachInferred as { data: { results: { ok: boolean }[] } }).data
        .results[0].ok,
    ).toBe(false);
    storeCandidate('om_more');
    const attached = await route({
      kind: 'attach',
      triggerMessageId: 'om_more',
      workItemId: base.workItemId,
    });
    expect(attached).toMatchObject({
      ok: true,
      data: { results: [{ ok: true, decision: 'attach' }] },
    });
    const item = store.getWorkItem(base.workItemId as string)!;
    expect(
      store.listWorkItemSubscriptions(item.id).map((s) => s.subKey),
    ).toContain('msg:om_more');
    const workerRows = laneRows(`${WORKSPACE}#agent:${item.agentId}`);
    expect(workerRows.map((row) => row.id)).toContain(
      service.followupCopyId('om_more', item.id),
    );
    const ignore = await route({ kind: 'ignore', triggerMessageId: 'om_inf3' });
    expect(
      (ignore as { data: { results: { error?: string }[] } }).data.results[0]
        .error,
    ).toMatch(/reason/);
    storeCandidate('om_stop');
    const stop = await route({
      kind: 'stop',
      triggerMessageId: 'om_stop',
      workItemId: item.id,
    });
    expect(stop).toMatchObject({ data: { results: [{ ok: true }] } });
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'stopped',
    });
    expect(interrupted).toContain(`${WORKSPACE}#agent:${item.agentId}`);
  });

  test('a decided candidate is not decided again', async () => {
    storeCandidate('om_dec');
    await route({ kind: 'ignore', triggerMessageId: 'om_dec', reason: 'chat' });
    const again = await accept('om_dec');
    expect(again.error).toMatch(/already decided/);
  });
});

describe('lane roles', () => {
  test('a worker cannot route and a router cannot report', async () => {
    storeCandidate('om_roles');
    const { workItemId } = await accept('om_roles');
    const item = store.getWorkItem(workItemId as string)!;
    const asWorker = await route(
      { kind: 'ignore', triggerMessageId: 'om_roles', reason: 'x' },
      workerCaller(item),
    );
    expect(asWorker).toEqual({
      ok: false,
      error: 'Only a team router session can use this tool.',
    });
    const asRouter = await service.handleWorkIpc(routerCaller(), {
      type: 'work_report',
      state: 'ready',
      summary: 'done',
    });
    expect(asRouter).toEqual({
      ok: false,
      error: 'Only a work item session can use this tool.',
    });
    // The main session (no agent id) is neither.
    const asMain = await service.handleWorkIpc(
      { folder: FOLDER, agentId: null },
      { type: 'work_list' },
    );
    expect(asMain.ok).toBe(false);
  });
});

describe('work_reply', () => {
  async function newItem(trigger: string): Promise<WorkItem> {
    storeCandidate(trigger);
    const { workItemId } = await accept(trigger);
    await runtime.flushTeamReplies();
    replies.length = 0;
    return store.getWorkItem(workItemId as string)!;
  }

  const reply = (payload: Record<string, unknown>) =>
    service.handleWorkIpc(routerCaller(), { type: 'work_reply', ...payload });

  test('result needs a ready, blocked or failed report', async () => {
    const item = await newItem('om_res');
    expect(
      await reply({ purpose: 'result', workItemId: item.id, text: '好了' }),
    ).toMatchObject({ ok: false });
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'blocked',
      summary: '没有权限',
    });
    expect(
      await reply({ purpose: 'result', workItemId: item.id, text: '做不了' }),
    ).toEqual({ ok: true, data: { queued: true } });
    await runtime.flushTeamReplies();
    expect(replies).toEqual([
      expect.objectContaining({ quoteMessageId: 'om_res', text: '做不了' }),
    ]);
    // The result message is subscribed: a reply to it reaches the item.
    expect(
      store.findSubscribedWorkItems(CHAT, [`msg:om_bot_${replySeq}`]),
    ).toEqual([expect.objectContaining({ id: item.id })]);
  });

  test('attention needs a question and quotes the message that raised it', async () => {
    const item = await newItem('om_att');
    expect(
      await reply({
        purpose: 'attention',
        workItemId: item.id,
        text: '问一下',
      }),
    ).toMatchObject({ ok: false });
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'waiting',
      summary: '需要确认',
      humanAction: '用哪个分支？',
      questionForMessageId: 'om_q',
    });
    expect(
      await reply({
        purpose: 'attention',
        workItemId: item.id,
        text: '用哪个分支？',
      }),
    ).toMatchObject({ ok: true });
    await runtime.flushTeamReplies();
    expect(replies[0]).toMatchObject({ quoteMessageId: 'om_q' });
  });

  test('answer is for a candidate no work item owns', async () => {
    storeCandidate('om_ask');
    expect(
      await reply({
        purpose: 'answer',
        triggerMessageId: 'om_ask',
        text: '在 README 里',
      }),
    ).toMatchObject({ ok: true });
    const item = await newItem('om_owned');
    expect(item).toBeTruthy();
    expect(
      await reply({
        purpose: 'answer',
        triggerMessageId: 'om_owned',
        text: '答',
      }),
    ).toMatchObject({ ok: false });
    expect(
      await reply({
        purpose: 'answer',
        triggerMessageId: 'om_unknown',
        text: '答',
      }),
    ).toMatchObject({ ok: false });
  });

  test('more than 100 words is refused so the model rewrites it', async () => {
    storeCandidate('om_long');
    const long = '很'.repeat(101);
    const result = await reply({
      purpose: 'answer',
      triggerMessageId: 'om_long',
      text: long,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/101 words.*100/);
    expect(
      await reply({
        purpose: 'answer',
        triggerMessageId: 'om_long',
        text: '很'.repeat(100),
      }),
    ).toMatchObject({ ok: true });
  });

  test('a failed delivery is recorded on the item', async () => {
    const item = await newItem('om_fail');
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'failed',
      summary: '编译失败',
    });
    failReplies = true;
    await reply({ purpose: 'result', workItemId: item.id, text: '失败了' });
    await runtime.flushTeamReplies();
    expect(store.listWorkEvents(item.id)).toContainEqual(
      expect.objectContaining({ kind: 'reply', state: 'failed' }),
    );
  });
});

describe('work reports and approval', () => {
  test('a read-only item that reports ready waits for approval', async () => {
    storeCandidate('om_ro', { listed: false, sender: 'ou_stranger' });
    const { workItemId } = await accept('om_ro');
    let item = store.getWorkItem(workItemId as string)!;
    expect(service.resolveTeamRole(item.agentId)).toEqual({
      role: 'worker',
      workItemId: item.id,
      writable: false,
    });
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'ready',
      summary: '复现了，改法是……',
    });
    const [view] = service
      .listWorkItemViews(WORKSPACE)
      .filter((entry) => entry.id === item.id);
    expect(view).toMatchObject({ status: 'open', stage: 'approval' });
    // The report reaches the router.
    const reports = laneRows(routerLane()).filter(
      (row) => gate.readTeamInput(row.attachments)?.tag === 'work_report',
    );
    expect(reports.at(-1)?.content).toBe('复现了，改法是……');

    const approved = await service.approveWorkItem(item.id, ACTOR);
    expect(approved.approvedAt).toBeTruthy();
    expect(service.resolveTeamRole(item.agentId)).toMatchObject({
      writable: true,
    });
    expect(
      laneRows(`${WORKSPACE}#agent:${item.agentId}`).map(
        (row) => gate.readTeamInput(row.attachments)?.tag,
      ),
    ).toContain('work_approved');
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'ready',
      summary: '已改好',
    });
    item = store.getWorkItem(item.id)!;
    expect(item).toMatchObject({ status: 'ended', outcome: 'completed' });
  });

  test('progress only updates the item; dropped ends it silently', async () => {
    storeCandidate('om_prog');
    const { workItemId } = await accept('om_prog');
    const item = store.getWorkItem(workItemId as string)!;
    const before = laneRows(routerLane()).length;
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'progress',
      summary: '在看',
    });
    expect(laneRows(routerLane()).length).toBe(before);
    expect(store.getWorkItem(item.id)!.lastReport).toBe('progress');
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'dropped',
      summary: '不需要做了',
    });
    expect(laneRows(routerLane()).length).toBe(before);
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'dropped',
    });
  });

  test('the router’s acknowledgement makes a worker ack on the same trigger a duplicate', async () => {
    storeCandidate('om_ack');
    const { workItemId } = await accept('om_ack');
    const item = store.getWorkItem(workItemId as string)!;
    await runtime.flushTeamReplies();
    replies.length = 0;
    expect(
      await service.handleWorkIpc(workerCaller(item), {
        type: 'work_ack',
        triggerMessageId: 'om_ack',
        text: '开工',
      }),
    ).toEqual({ ok: true, data: { duplicate: true } });
    expect(
      await service.handleWorkIpc(workerCaller(item), {
        type: 'work_ack',
        triggerMessageId: 'om_elsewhere',
        text: '开工',
      }),
    ).toMatchObject({ ok: false });
    expect(replies).toEqual([]);
  });
});

describe('subscribed group messages', () => {
  test('the first item gets the message, further items a copy; ended items resume, stopped ones do not', async () => {
    storeCandidate('om_a');
    const a = store.getWorkItem((await accept('om_a')).workItemId as string)!;
    storeCandidate('om_b');
    const b = store.getWorkItem((await accept('om_b')).workItemId as string)!;
    storeCandidate('om_c');
    const c = store.getWorkItem((await accept('om_c')).workItemId as string)!;
    // All three follow one thread; b has completed, c was stopped.
    for (const item of [a, b, c]) {
      store.subscribeWorkItem(item.id, CHAT, 'thread:omt_shared', 'x');
    }
    await service.handleWorkIpc(workerCaller(b), {
      type: 'work_report',
      state: 'ready',
      summary: 'done',
    });
    await service.stopWorkItem(c.id, ACTOR);

    const context = service.resolveTeamGroup(CHAT)!;
    const decision = gate.decideTeamInbound(
      context,
      {
        messageId: 'om_follow',
        threadId: 'omt_shared',
        senderImId: 'ou_listed',
        mentionedBot: false,
      },
      {
        findSubscribedItems: store.findSubscribedWorkItems,
        isListed: (sender) => service.isTeamListed(context, sender),
        isOwnBotMessage: (id) => service.isTeamBotMessage(context, id),
        hasWorker: service.hasWorkerSession,
      },
    );
    expect(decision.kind).toBe('subscribed');
    if (decision.kind !== 'subscribed') return;
    expect(decision.items.map((item) => item.id)).toEqual([a.id, b.id]);
    expect(decision.resumeIds).toEqual([b.id]);

    service.onTeamMessageStored(decision, {
      id: 'om_follow',
      content: '还有一个问题',
      sender_name: '小王',
      source_jid: CHAT,
    });
    expect(store.getWorkItem(b.id)).toMatchObject({ status: 'open' });
    const copy = laneRows(`${WORKSPACE}#agent:${b.agentId}`).find(
      (row) => row.id === service.followupCopyId('om_follow', b.id),
    );
    expect(copy).toMatchObject({
      content: '还有一个问题',
      source_jid: CHAT,
      source_kind: 'work_item_input',
    });
    expect(
      laneRows(`${WORKSPACE}#agent:${c.agentId}`).some((row) =>
        row.id.startsWith('om_follow'),
      ),
    ).toBe(false);
    // The follow-up was delivered to a, so a may acknowledge it.
    expect(
      await service.handleWorkIpc(workerCaller(a), {
        type: 'work_ack',
        triggerMessageId: 'om_follow',
        text: '看到了',
      }),
    ).toEqual({ ok: true, data: { duplicate: false } });
  });

  test('a hand-back returns the follow-up to the router once', async () => {
    storeCandidate('om_h');
    const item = store.getWorkItem(
      (await accept('om_h')).workItemId as string,
    )!;
    const header = gate.followupInputItem({
      item,
      triggerMessageId: 'om_h2',
      addressed: true,
      senderImId: 'ou_listed',
    });
    db.storeMessageDirect(
      'om_h2',
      `${WORKSPACE}#agent:${item.agentId}`,
      'ou_listed',
      '小王',
      '另一个需求',
      new Date().toISOString(),
      false,
      {
        sourceJid: CHAT,
        attachments: gate.withTeamInputAttachment(null, header),
      },
    );
    service.onTeamMessageStored(
      {
        kind: 'subscribed',
        channelJid: CHAT,
        workspaceJid: WORKSPACE,
        items: [item],
        resumeIds: [],
      },
      {
        id: 'om_h2',
        content: '另一个需求',
        sender_name: '小王',
        source_jid: CHAT,
      },
    );
    const handback = () =>
      service.handleWorkIpc(workerCaller(item), {
        type: 'work_handback',
        triggerMessageId: 'om_h2',
        reason: '不是这个工作项的事',
      });
    expect(await handback()).toEqual({ ok: true, data: {} });
    expect(await handback()).toEqual({ ok: true, data: {} });
    const handed = laneRows(routerLane()).filter(
      (row) => row.id === 'handback:om_h2',
    );
    expect(handed).toHaveLength(1);
    expect(gate.readTeamInput(handed[0].attachments)?.attrs).toContainEqual([
      'handed_back_by',
      `#${item.seq}`,
    ]);
    // The source request itself is not a follow-up.
    expect(
      await service.handleWorkIpc(workerCaller(item), {
        type: 'work_handback',
        triggerMessageId: 'om_h',
        reason: 'x',
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('session deletion', () => {
  test('deleting a worker session ends its item', async () => {
    storeCandidate('om_del');
    const item = store.getWorkItem(
      (await accept('om_del')).workItemId as string,
    )!;
    const { deleteConversationSession } =
      await import('../src/session-factory.js');
    await deleteConversationSession({
      workspaceJid: WORKSPACE,
      group: db.getRegisteredGroup(WORKSPACE)!,
      session: db.getAgent(item.agentId)!,
    });
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'stopped',
    });
  });
});
