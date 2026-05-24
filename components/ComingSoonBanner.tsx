interface Props {
  title: string;
  reason: string;
}

export function ComingSoonBanner({ title, reason }: Props) {
  return (
    <div className="rounded-lg border border-dashed border-muted-foreground/40 bg-muted/30 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="inline-flex h-2 w-2 rounded-full bg-amber-500" />
        {title}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{reason}</p>
    </div>
  );
}
