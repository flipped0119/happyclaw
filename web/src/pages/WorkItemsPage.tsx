import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadErrorNotice } from '@/components/common/LoadErrorNotice';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useChatStore } from '../stores/chat';
import { useWorkItemsStore } from '../stores/work-items';
import {
  WorkItemList,
  buildWorkSections,
  firstWorkItem,
} from '../components/team/WorkItemList';
import { WorkItemDetail } from '../components/team/WorkItemDetail';
import { PhonePageHeader } from '../components/layout/PhonePageHeader';
import { workItemHref } from '../lib/team-mode';

/**
 * 工作项 (团队模式): what needs me, what runs and what ended on the left, the
 * selected item on the right. Below the desktop width the list and the
 * detail are two screens (`/work` and `/work/:id`).
 */
export function WorkItemsPage() {
  const navigate = useNavigate();
  const { itemId } = useParams();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const groups = useChatStore((s) => s.groups);
  const itemMap = useWorkItemsStore((s) => s.items);
  const decisionMap = useWorkItemsStore((s) => s.decisions);
  const loaded = useWorkItemsStore((s) => s.loaded);
  const loading = useWorkItemsStore((s) => s.loading);
  const error = useWorkItemsStore((s) => s.error);
  const load = useWorkItemsStore((s) => s.load);

  // Team mode belongs to the workspaces this user owns.
  const workspaceKey = Object.entries(groups)
    .filter(([jid, group]) => jid.startsWith('web:') && group.can_modify)
    .map(([jid]) => jid)
    .sort()
    .join('\n');
  const reload = useMemo(
    () => () => load(workspaceKey ? workspaceKey.split('\n') : []),
    [load, workspaceKey],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const items = useMemo(() => Object.values(itemMap), [itemMap]);
  const decisions = useMemo(
    () => Object.values(decisionMap).flat(),
    [decisionMap],
  );
  const routed = itemId ? itemMap[itemId] : undefined;
  const selected =
    routed ??
    (isDesktop && !itemId
      ? (firstWorkItem(buildWorkSections(items, decisions)) ?? undefined)
      : undefined);
  const select = (id: string) => navigate(workItemHref(id));
  const back = () => navigate('/work');

  const header = (
    <div className="px-4 pt-5 pb-3 lg:pt-6 phone:hidden">
      <h1 className="text-title-lg text-foreground">工作项</h1>
    </div>
  );
  const list = (
    <WorkItemList
      items={items}
      decisions={decisions}
      selectedId={selected?.id ?? null}
      onSelect={select}
      loading={loading && !loaded}
    />
  );
  const notFound = (
    <EmptyState
      icon={ClipboardList}
      title="找不到这个工作项"
      description="它可能不属于你的工作区。"
      action={
        <Button variant="outline" onClick={back}>
          返回列表
        </Button>
      }
    />
  );
  const errorNotice = error && (
    <div className="p-4">
      <LoadErrorNotice
        title="工作项加载失败"
        message={error}
        onRetry={() => void reload()}
      />
    </div>
  );

  if (!isDesktop) {
    if (itemId) {
      if (routed) return <WorkItemDetail item={routed} onBack={back} />;
      return (
        <>
          <PhonePageHeader title="工作项" onBack={back} />
          {loaded ? notFound : null}
        </>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PhonePageHeader title="工作项" />
        {header}
        {errorNotice}
        {list}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <aside
        aria-label="工作项列表"
        className="flex w-80 shrink-0 flex-col border-r border-surface-border"
      >
        {header}
        {errorNotice}
        {list}
      </aside>
      <main className="min-w-0 flex-1">
        {selected ? (
          <WorkItemDetail key={selected.id} item={selected} />
        ) : (
          loaded &&
          (itemId
            ? notFound
            : items.length > 0 && (
                <EmptyState
                  icon={ClipboardList}
                  title="选择一个工作项"
                  description="在左侧选择以查看详情和时间线。"
                />
              ))
        )}
      </main>
    </div>
  );
}
