import { useEffect } from 'react';
import { create } from 'zustand';

import { api, type ApiError } from '../api/client';
import { wsManager } from '../api/ws';
import type {
  TeamMountView,
  TeamSettingsDraft,
  WorkItemDetail,
} from '../lib/team-mode';
import type {
  WorkDecision,
  WorkItemView,
  WorkItemWsEvent,
} from '../work-items';

// Team mode (团队模式): work items, the decisions kept for review and the
// group mounts' settings, for the 工作项 page, the settings dialog and the
// session tree's tags.

/** Ended items and recorded decisions shown per workspace. */
const RECENT_LIMIT = 20;

interface WorkItemsState {
  items: Record<string, WorkItemView>;
  /** `would_accept` decisions per workspace, newest first. */
  decisions: Record<string, WorkDecision[]>;
  details: Record<string, WorkItemDetail>;
  /** Workspaces whose lists were fetched (or are being fetched). */
  requested: Record<string, true>;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Items with a stop or approve request in flight. */
  busy: Record<string, boolean>;

  /** The page: every listed workspace's items and recorded decisions. */
  load: (workspaceJids: string[]) => Promise<void>;
  /** Once per workspace, for the session tree's `#N` tags. */
  ensureWorkspace: (workspaceJid: string) => void;
  loadDetail: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  approve: (id: string) => Promise<void>;
  handleUpdated: (event: WorkItemWsEvent) => void;
}

const enc = encodeURIComponent;

async function fetchWorkspace(jid: string) {
  const base = `/api/workspaces/${enc(jid)}`;
  const [open, ended, decisions] = await Promise.all([
    api.get<{ items: WorkItemView[] }>(`${base}/work-items?status=open`),
    api.get<{ items: WorkItemView[] }>(
      `${base}/work-items?status=ended&limit=${RECENT_LIMIT}`,
    ),
    api.get<{ decisions: WorkDecision[] }>(
      `${base}/work-decisions?kind=would_accept&limit=${RECENT_LIMIT}`,
    ),
  ]);
  return {
    items: [...open.items, ...ended.items],
    decisions: decisions.decisions,
  };
}

// WS events refetch an open detail at most once per burst.
const REFRESH_DELAY_MS = 120;
const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>();

export const useWorkItemsStore = create<WorkItemsState>((set, get) => {
  const putItem = (item: WorkItemView) =>
    set((state) => ({
      items: { ...state.items, [item.id]: item },
      details: state.details[item.id]
        ? { ...state.details, [item.id]: { ...state.details[item.id], item } }
        : state.details,
    }));

  const act = async (id: string, action: 'stop' | 'approve') => {
    set((state) => ({ busy: { ...state.busy, [id]: true } }));
    try {
      const data = await api.post<{ item: WorkItemView }>(
        `/api/work-items/${enc(id)}/${action}`,
      );
      putItem(data.item);
      void get()
        .loadDetail(id)
        .catch(() => undefined);
    } finally {
      set((state) => {
        const busy = { ...state.busy };
        delete busy[id];
        return { busy };
      });
    }
  };

  return {
    items: {},
    decisions: {},
    details: {},
    requested: {},
    loaded: false,
    loading: false,
    error: null,
    busy: {},

    load: async (workspaceJids) => {
      set((state) => ({
        loading: true,
        requested: {
          ...state.requested,
          ...Object.fromEntries(workspaceJids.map((jid) => [jid, true])),
        },
      }));
      const results = await Promise.allSettled(
        workspaceJids.map(async (jid) => ({
          jid,
          ...(await fetchWorkspace(jid)),
        })),
      );
      // A workspace this user cannot run team mode in answers 404: skip it.
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected' &&
          (result.reason as ApiError)?.status !== 404,
      );
      set((state) => {
        const items = { ...state.items };
        const decisions = { ...state.decisions };
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const { jid } = result.value;
          for (const [id, item] of Object.entries(items))
            if (item.workspaceJid === jid) delete items[id];
          for (const item of result.value.items) items[item.id] = item;
          decisions[jid] = result.value.decisions;
        }
        return {
          items,
          decisions,
          loaded: true,
          loading: false,
          error: failure
            ? (failure.reason as ApiError)?.message || '加载工作项失败'
            : null,
        };
      });
    },

    ensureWorkspace: (workspaceJid) => {
      if (get().requested[workspaceJid]) return;
      set((state) => ({
        requested: { ...state.requested, [workspaceJid]: true },
      }));
      void fetchWorkspace(workspaceJid)
        .then(({ items }) =>
          set((state) => ({
            items: {
              ...Object.fromEntries(items.map((item) => [item.id, item])),
              ...state.items,
            },
          })),
        )
        .catch(() => undefined);
    },

    loadDetail: async (id) => {
      try {
        const detail = await api.get<WorkItemDetail>(
          `/api/work-items/${enc(id)}`,
        );
        set((state) => ({
          items: { ...state.items, [id]: detail.item },
          details: { ...state.details, [id]: detail },
        }));
      } catch (err) {
        if ((err as ApiError).status !== 404) throw err;
        set((state) => {
          const items = { ...state.items };
          const details = { ...state.details };
          delete items[id];
          delete details[id];
          return { items, details };
        });
      }
    },

    stop: (id) => act(id, 'stop'),
    approve: (id) => act(id, 'approve'),

    handleUpdated: (event) => {
      if (!event?.item?.id) return;
      putItem(event.item);
      const id = event.item.id;
      if (!get().details[id] || pendingRefresh.has(id)) return;
      pendingRefresh.set(
        id,
        setTimeout(() => {
          pendingRefresh.delete(id);
          void get()
            .loadDetail(id)
            .catch(() => undefined);
        }, REFRESH_DELAY_MS),
      );
    },
  };
});

/** Keep work items current; mount once for the signed-in app. */
export function useWorkItemSubscription(): void {
  useEffect(() => {
    const unsubs = [
      wsManager.on('work_item_updated', (data: WorkItemWsEvent) =>
        useWorkItemsStore.getState().handleUpdated(data),
      ),
      // Events missed while the socket was down.
      wsManager.on('connected', (data: { reconnect?: boolean }) => {
        const { loaded, requested, load } = useWorkItemsStore.getState();
        if (data?.reconnect && loaded) void load(Object.keys(requested));
      }),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, []);
}

/** The work item a worker session runs, once its workspace is loaded. */
export function useWorkItemForSession(
  workspaceJid: string,
  agentId: string,
  enabled: boolean,
): WorkItemView | undefined {
  const ensureWorkspace = useWorkItemsStore((s) => s.ensureWorkspace);
  useEffect(() => {
    if (enabled) ensureWorkspace(workspaceJid);
  }, [enabled, workspaceJid, ensureWorkspace]);
  return useWorkItemsStore((s) =>
    enabled
      ? Object.values(s.items).find((item) => item.agentId === agentId)
      : undefined,
  );
}

// ── Group mount settings ───────────────────────────────────────────────

export async function fetchTeamMounts(
  workspaceJid: string,
): Promise<TeamMountView[]> {
  const data = await api.get<{ mounts: TeamMountView[] }>(
    `/api/workspaces/${enc(workspaceJid)}/team-mounts`,
  );
  return data.mounts;
}

export async function saveTeamMount(
  workspaceJid: string,
  channelJid: string,
  settings: TeamSettingsDraft,
): Promise<TeamMountView> {
  const data = await api.put<{ mount: TeamMountView }>(
    `/api/workspaces/${enc(workspaceJid)}/team-mounts/${enc(channelJid)}`,
    { settings },
  );
  return data.mount;
}
