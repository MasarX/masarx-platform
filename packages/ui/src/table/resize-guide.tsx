export type ResizeGuide = {
  x: number;
  width: number;
};

type TableResizeGuideProps = {
  guide: ResizeGuide | null;
};

export function TableResizeGuide({ guide }: TableResizeGuideProps) {
  if (!guide) return null;
  // Snap display to nearest 10px
  const snapped = Math.round(guide.width / 10) * 10;
  return (
    <div
      className="pointer-events-none absolute inset-y-0 transition-[left] duration-75"
      style={{ left: guide.x }}
    >
      <div className="h-full w-px bg-ui-accent/50" />
      <div className="absolute top-2 -translate-x-1/2 rounded-md bg-ui-ink/85 px-2 py-1 text-[10px] font-medium tabular-nums text-white shadow-sm">
        {`${snapped}px`}
      </div>
    </div>
  );
}
