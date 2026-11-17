"use client";

import * as React from "react";
import type { TemplateBlock } from "./canvas-types";
import { getBarcodeConfig } from "./barcode-types";

type CanvasBarcodeBlockProps = {
  block: TemplateBlock;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
};

// Cache for rendered barcode SVGs
const svgCache = new Map<string, string>();

// Lazy-loaded bwip-js reference
let bwipPromise: Promise<{ toSVG: (opts: Record<string, unknown>) => string }> | null = null;

function loadBwip() {
  if (!bwipPromise) {
    // @ts-expect-error -- bwip-js types are under nested browser export condition; typed via bwipPromise
    bwipPromise = import("bwip-js") as Promise<{ toSVG: (opts: Record<string, unknown>) => string }>;
  }
  return bwipPromise;
}

export function CanvasBarcodeBlock({
  block,
  x,
  y,
  width,
  height,
  scale,
}: CanvasBarcodeBlockProps) {
  const [svgContent, setSvgContent] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);

  const barcodeType = (block.barcode_type || "code128").toLowerCase();
  const config = getBarcodeConfig(barcodeType);
  const data = block.fallback || block.value_path || (config?.is2D ? "SAMPLE" : "12345678");

  // Logical (unscaled) dimensions for the cache key
  const logicalW = block.width || 80;
  const logicalH = block.height || 20;
  const cacheKey = `${barcodeType}:${data}:${logicalW}:${logicalH}:${block.module_width || ""}:${block.quiet_zone_modules || ""}:${block.error_correction || ""}`;

  React.useEffect(() => {
    if (svgCache.has(cacheKey)) {
      setSvgContent(svgCache.get(cacheKey)!);
      setError(false);
      return;
    }

    let cancelled = false;

    loadBwip()
      .then((bwip) => {
        if (cancelled) return;

        const encoder = config?.encoder || "code128";
        const options: Record<string, unknown> = {
          bcid: encoder,
          text: data,
          scale: 2,
          includetext: block.human_readable !== false,
          textxalign: "center",
        };

        if (block.module_width) options.width = block.module_width;
        if (block.quiet_zone_modules) options.paddingwidth = block.quiet_zone_modules;
        if (block.error_correction && barcodeType === "qr") {
          options.eclevel = block.error_correction;
        }

        try {
          const svg = bwip.toSVG(options);
          if (!cancelled) {
            svgCache.set(cacheKey, svg);
            setSvgContent(svg);
            setError(false);
          }
        } catch {
          if (!cancelled) {
            setError(true);
            setSvgContent(null);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, config, data, barcodeType, block.human_readable, block.module_width, block.quiet_zone_modules, block.error_correction]);

  if (error || !svgContent) {
    // Fallback placeholder
    return (
      <g>
        <rect x={x} y={y} width={width} height={height} fill="#f8f9fa" stroke="#d1d5db" strokeWidth={1} />
        <text
          x={x + width / 2}
          y={y + height / 2 + 4}
          fontSize={Math.max(9 * scale, 8)}
          fill="#9ca3af"
          textAnchor="middle"
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          {error ? "Invalid" : "Loading..."}
        </text>
      </g>
    );
  }

  return (
    <g>
      <foreignObject x={x} y={y} width={width} height={height}>
        <div
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: svgContent }}
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            overflow: "hidden",
          }}
        />
      </foreignObject>
    </g>
  );
}
