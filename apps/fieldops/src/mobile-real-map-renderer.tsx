import * as React from "react";
import type { MobileRealMapRendererProps } from "./mobile-real-map-renderer.types";

export function MobileRealMapRenderer({ model, onState }: MobileRealMapRendererProps) {
  React.useEffect(() => {
    onState({ modelId: model.id, status: "error" });
  }, [model.id, onState]);
  return null;
}
