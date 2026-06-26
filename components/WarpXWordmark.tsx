import Image from "next/image";
import Link from "next/link";

import { cn } from "@/lib/utils";

type WarpXWordmarkProps = {
  href?: string;
  size?: "md" | "lg";
  showBeta?: boolean;
  className?: string;
};

/** Text-only WarpX — Plus Jakarta semibold (600). */
export function WarpXWordmark({
  href,
  size = "md",
  showBeta = false,
  className
}: WarpXWordmarkProps) {
  const large = size === "lg";

  const mark = (
    <span
      className={cn(
        "inline-flex items-center font-display font-semibold leading-none tracking-[-0.03em]",
        large ? "gap-3 text-[2rem] sm:text-[2.25rem]" : "gap-2 text-[22px]",
        className
      )}
    >
      {/*    <Image
        src="/logo.png"
        alt=""
        width={large ? 40 : 28}
        height={large ? 40 : 28}
        className={cn("shrink-0", large ? "size-10" : "size-7")}
        aria-hidden
      /> */}
      <span>
        <span className="text-on-surface">Warp</span>
        <span className="text-primary">X</span>
      </span>
      {showBeta ? (
        <span className="rounded-md bg-primary/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-primary">
          Beta
        </span>
      ) : null}
    </span>
  );

  if (href) {
    return (
      <Link
        href={href}
        aria-label="WarpX — home"
        className="inline-flex transition-opacity hover:opacity-80"
      >
        {mark}
      </Link>
    );
  }

  return mark;
}
