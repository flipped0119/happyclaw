import { cn } from '@/lib/utils';
import { VENDOR_MARKS, type VendorKind } from './vendorMarks';

interface VendorTileProps {
  /** Null shows the monogram of `name`. */
  vendor: VendorKind | null;
  /** The connection or model the tile stands for; its first letter is the fallback. */
  name: string;
  size?: 'sm' | 'md';
  /** The mark alone, without its tile; nothing when no mark is known. */
  plain?: boolean;
  className?: string;
}

/**
 * A vendor's mark in a small rounded tile, or the first letter of the name
 * when no mark is known. Decorative: the name is always written next to it.
 */
export function VendorTile({
  vendor,
  name,
  size = 'md',
  plain = false,
  className,
}: VendorTileProps) {
  const mark = vendor ? VENDOR_MARKS[vendor] : null;
  // A tile's mark is a size smaller than a plain one.
  const glyphSize = plain
    ? size === 'sm'
      ? 'size-3.5'
      : 'size-4'
    : size === 'sm'
      ? 'size-3'
      : 'size-4';
  const glyph = mark && (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule={'evenOdd' in mark ? 'evenodd' : undefined}
      className={glyphSize}
    >
      {mark.paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
  if (plain) {
    return glyph ? (
      <span
        aria-hidden="true"
        data-vendor={vendor ?? undefined}
        className={cn('flex shrink-0 text-foreground', className)}
      >
        {glyph}
      </span>
    ) : null;
  }
  return (
    <span
      aria-hidden="true"
      data-vendor={vendor ?? undefined}
      className={cn(
        'flex shrink-0 items-center justify-center bg-surface-selected text-foreground',
        size === 'sm' ? 'size-5 rounded-md' : 'size-7 rounded-lg',
        className,
      )}
    >
      {glyph ? (
        glyph
      ) : (
        <span
          className={cn(
            'font-semibold text-muted-foreground',
            size === 'sm' ? 'text-micro' : 'text-caption',
          )}
        >
          {Array.from(name.trim())[0]?.toUpperCase() ?? '?'}
        </span>
      )}
    </span>
  );
}
