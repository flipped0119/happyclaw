import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useWorkItemForSession } from '../../stores/work-items';
import { workItemHref } from '../../lib/team-mode';
import type { AgentInfo } from '../../types';

/**
 * 「团队路由」 or 「#N 工作项」 on a team-mode session in the session tree.
 * A work item's tag opens its detail.
 */
export function TeamSessionTag({
  workspaceJid,
  session,
  className,
}: {
  workspaceJid: string;
  session: Pick<AgentInfo, 'id' | 'source_kind'>;
  className?: string;
}) {
  const navigate = useNavigate();
  const isWorker = session.source_kind === 'work_item';
  const item = useWorkItemForSession(workspaceJid, session.id, isWorker);
  if (session.source_kind === 'team_router')
    return (
      <Badge variant="outline" className={cn('shrink-0', className)}>
        团队路由
      </Badge>
    );
  if (!isWorker) return null;
  const label = item ? `#${item.seq} 工作项` : '工作项';
  if (!item)
    return (
      <Badge variant="outline" className={cn('shrink-0', className)}>
        {label}
      </Badge>
    );
  return (
    <Badge
      asChild
      variant="outline"
      className={cn(
        'relative z-10 shrink-0 cursor-pointer pointer-coarse:before:absolute pointer-coarse:before:-inset-2.5',
        className,
      )}
    >
      <button
        type="button"
        aria-label={`打开工作项 #${item.seq}`}
        onClick={(event) => {
          event.stopPropagation();
          navigate(workItemHref(item.id));
        }}
      >
        {label}
      </button>
    </Badge>
  );
}
