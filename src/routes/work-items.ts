// Team mode (团队模式) REST routes: group mount settings, work items and the
// router's decision log.
//
// Thin layer over work-item-service: it owns permissions and the HTTP shape.
// Everything here belongs to the workspace's owner. There is no admin bypass
// (an admin only passes the extra Host-mode check, on their own workspace),
// other users' workspaces and items answer 404, and guests are refused both
// by the guest guard (no allowlist entry) and here.

import { Hono, type Context } from 'hono';

import { getGroupsByOwner, getRegisteredGroup } from '../db.js';
import { canAccessGroup } from '../group-acl.js';
import { GUEST_READ_ONLY_ERROR } from '../guest-access.js';
import { logger } from '../logger.js';
import { authMiddleware } from '../middleware/auth.js';
import { TeamSettingsBodySchema } from '../schemas.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import {
  hasHostExecutionPermission,
  isHostExecutionGroup,
  type Variables,
} from '../web-context.js';
import {
  approveWorkItem,
  getWorkItemDetail,
  listTeamMountViews,
  listWorkDecisionsForWorkspace,
  listWorkItemViews,
  saveTeamMountSettings,
  stopWorkItem,
  WorkItemError,
  type WorkItemActor,
} from '../work-item-service.js';
import { stageNeedsPerson, type WorkDecisionKind } from '../work-items.js';

type AppContext = Context<{ Variables: Variables }>;

const workItemRoutes = new Hono<{ Variables: Variables }>();

const NOT_FOUND = '工作区不存在';
const ITEM_NOT_FOUND = '工作项不存在';
const DECISION_KINDS = new Set<WorkDecisionKind>([
  'accept',
  'attach',
  'stop',
  'ignore',
  'would_accept',
]);

/** The caller's own workspace, or null (missing, someone else's, Host without admin). */
function ownedWorkspace(
  user: AuthUser,
  jid: string,
): (RegisteredGroup & { jid: string }) | null {
  if (!jid.startsWith('web:')) return null;
  const group = getRegisteredGroup(jid);
  if (!group) return null;
  const workspace = { ...group, jid };
  if (group.created_by !== user.id || !canAccessGroup(user, workspace))
    return null;
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(user))
    return null;
  return workspace;
}

function actorOf(user: AuthUser): WorkItemActor {
  return { userId: user.id, isAdmin: user.role === 'admin' };
}

type Handler = (c: AppContext, user: AuthUser) => Promise<Response> | Response;

/** Refuse guests and map WorkItemError to `{ error }` with its status. */
function handle(handler: Handler) {
  return async (c: AppContext) => {
    const user = c.get('user') as AuthUser;
    if (user.role === 'guest')
      return c.json({ error: GUEST_READ_ONLY_ERROR }, 403);
    try {
      return await handler(c, user);
    } catch (error) {
      if (error instanceof WorkItemError)
        return c.json({ error: error.message }, error.status);
      logger.error(
        { err: error, path: c.req.path },
        'Work item request failed',
      );
      return c.json({ error: '操作失败，请稍后重试' }, 500);
    }
  };
}

/** Resolve `:id` to a work item in one of the caller's workspaces. */
function ownedItemDetail(user: AuthUser, id: string) {
  const detail = getWorkItemDetail(id);
  if (!detail || !ownedWorkspace(user, detail.item.workspaceJid)) return null;
  return detail;
}

function param(c: AppContext, name: string): string {
  return c.req.param(name) ?? '';
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0
    ? Math.min(value, 500)
    : undefined;
}

workItemRoutes.get(
  '/workspaces/:jid/team-mounts',
  authMiddleware,
  handle((c, user) => {
    const jid = param(c, 'jid');
    if (!ownedWorkspace(user, jid)) return c.json({ error: NOT_FOUND }, 404);
    return c.json({ mounts: listTeamMountViews(jid) });
  }),
);

workItemRoutes.put(
  '/workspaces/:jid/team-mounts/:channelJid',
  authMiddleware,
  handle(async (c, user) => {
    const jid = param(c, 'jid');
    const channelJid = param(c, 'channelJid');
    if (!ownedWorkspace(user, jid)) return c.json({ error: NOT_FOUND }, 404);
    const parsed = TeamSettingsBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: '请求格式不正确' }, 400);
    await saveTeamMountSettings(
      jid,
      channelJid,
      parsed.data.settings,
      actorOf(user),
    );
    const mount = listTeamMountViews(jid).find(
      (view) => view.channelJid === channelJid,
    );
    if (!mount) return c.json({ error: '群绑定不存在' }, 404);
    return c.json({ mount });
  }),
);

workItemRoutes.get(
  '/workspaces/:jid/work-items',
  authMiddleware,
  handle((c, user) => {
    const jid = param(c, 'jid');
    if (!ownedWorkspace(user, jid)) return c.json({ error: NOT_FOUND }, 404);
    const status = c.req.query('status');
    if (status !== undefined && status !== 'open' && status !== 'ended')
      return c.json({ error: '请求格式不正确' }, 400);
    return c.json({
      items: listWorkItemViews(jid, {
        status,
        limit: parseLimit(c.req.query('limit')),
      }),
    });
  }),
);

workItemRoutes.get(
  '/workspaces/:jid/work-decisions',
  authMiddleware,
  handle((c, user) => {
    const jid = param(c, 'jid');
    if (!ownedWorkspace(user, jid)) return c.json({ error: NOT_FOUND }, 404);
    const kind = c.req.query('kind') || undefined;
    if (kind !== undefined && !DECISION_KINDS.has(kind as WorkDecisionKind))
      return c.json({ error: '请求格式不正确' }, 400);
    return c.json({
      decisions: listWorkDecisionsForWorkspace(jid, {
        kind: kind as WorkDecisionKind | undefined,
        limit: parseLimit(c.req.query('limit')),
      }),
    });
  }),
);

// Across the caller's own workspaces: open items in a stage that waits for a
// person. `needs=me` is the only supported query.
workItemRoutes.get(
  '/work-items',
  authMiddleware,
  handle((c, user) => {
    if (c.req.query('needs') !== 'me')
      return c.json({ error: '请求格式不正确' }, 400);
    const items = getGroupsByOwner(user.id)
      .filter((group) => ownedWorkspace(user, group.jid))
      .flatMap((group) => listWorkItemViews(group.jid, { status: 'open' }))
      .filter((item) => stageNeedsPerson(item.stage))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json({ items });
  }),
);

workItemRoutes.get(
  '/work-items/:id',
  authMiddleware,
  handle((c, user) => {
    const detail = ownedItemDetail(user, param(c, 'id'));
    if (!detail) return c.json({ error: ITEM_NOT_FOUND }, 404);
    return c.json(detail);
  }),
);

workItemRoutes.post(
  '/work-items/:id/stop',
  authMiddleware,
  handle(async (c, user) => {
    const id = param(c, 'id');
    if (!ownedItemDetail(user, id))
      return c.json({ error: ITEM_NOT_FOUND }, 404);
    return c.json({ item: await stopWorkItem(id, actorOf(user)) });
  }),
);

workItemRoutes.post(
  '/work-items/:id/approve',
  authMiddleware,
  handle(async (c, user) => {
    const id = param(c, 'id');
    if (!ownedItemDetail(user, id))
      return c.json({ error: ITEM_NOT_FOUND }, 404);
    return c.json({ item: await approveWorkItem(id, actorOf(user)) });
  }),
);

export default workItemRoutes;
