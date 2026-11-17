"use client";

import * as React from "react";
import type { AssetItem } from "./types";
import { resolveTrustedExternalDataUrl } from "../url-guard";

type AssetThumbnailProps = {
  asset: AssetItem;
  signedUrl?: string | null;
  testIdPrefix?: string;
  onClick?: () => void;
};

export function AssetThumbnail({
  asset,
  signedUrl,
  testIdPrefix,
  onClick,
}: AssetThumbnailProps) {
  const prefix = testIdPrefix || "asset-thumb";
  const [imgError, setImgError] = React.useState(false);

  const isImage = /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(asset.name);
  const trustedSignedUrl = signedUrl
    ? resolveTrustedExternalDataUrl(signedUrl)
    : null;

  return (
    <button
      type="button"
      className="group relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-ui-border/50 bg-ui-paper/30 transition-all hover:border-blue-300 hover:shadow-sm"
      onClick={onClick}
      title={asset.name}
      data-testid={`${prefix}-${asset.name}`}
    >
      {trustedSignedUrl && isImage && !imgError ? (
        <img
          src={trustedSignedUrl}
          alt={asset.name}
          className="h-full w-full object-contain"
          loading="lazy"
          onError={() => setImgError(true)}
        />
      ) : (
        <div className="flex flex-col items-center gap-0.5 p-1">
          <svg
            className="h-5 w-5 text-ui-muted/60"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <rect x="3" y="3" width="18" height="18" rx="2" strokeLinecap="round" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="w-full truncate text-center text-[8px] text-ui-muted">
            {asset.name}
          </span>
        </div>
      )}

      {/* Hover overlay with name */}
      <div className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <p className="truncate text-center text-[8px] text-white">{asset.name}</p>
      </div>
    </button>
  );
}
