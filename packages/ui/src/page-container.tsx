import * as React from "react";
import { cn } from "./utils";

type PageContainerProps = React.HTMLAttributes<HTMLDivElement> & {
  children: React.ReactNode;
  maxWidth?: "full" | "layout";
};

/**
 * Centers content within the configured layout max width.
 */
export function PageContainer({
  children,
  maxWidth = "full",
  className,
  ...props
}: PageContainerProps) {
  const maxWidthClass =
    maxWidth === "layout"
      ? "max-w-[var(--ui-layout-max-width)]"
      : "max-w-none";
  return (
    <div
      className={cn(
        "mx-auto w-full",
        maxWidthClass,
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
