import { useState, type ReactNode } from 'react';
import { ChevronRight, Layers } from 'lucide-react';

/**
 * A phone's one row for a reply's reasoning and trace (Jarvis's 「工具 3 ·
 * 1 分 ›」): what they hold on one line, the two blocks, open, in its place
 * once it is pressed.
 */
export function ProcessSummaryRow({
  label,
  defaultOpen = false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  /** The blocks the row stands for, rendered open. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (open) return <>{children}</>;
  return (
    <div className="mb-2 font-sans">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        data-process-summary=""
        className="-mx-1.5 flex min-h-10 w-[calc(100%+0.75rem)] cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-label text-muted-foreground transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        <Layers
          className="size-3.5 shrink-0 text-faint-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate tabular-nums">{label}</span>
        <ChevronRight
          className="size-3.5 shrink-0 text-faint-foreground"
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
