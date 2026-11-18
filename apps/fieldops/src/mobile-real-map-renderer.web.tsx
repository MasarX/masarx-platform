import * as React from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import mapWorkerAsset from "../../../packages/ui/map-worker-asset.json";
import { MOBILE_REAL_MAP_LINE_PAINT, MOBILE_REAL_MAP_POINT_PAINT, type MobileRealMapRendererProps } from "./mobile-real-map-renderer.types";

export function MobileRealMapRenderer(props: MobileRealMapRendererProps) {
  return <WebMapScene key={JSON.stringify(props.style)} {...props} />;
}

function WebMapScene({ model, style, camera: cameraOptions, onState, onSelect }: MobileRealMapRendererProps) {
  const initialStyle = React.useRef(style).current;
  const container = React.useRef<HTMLDivElement>(null);
  const map = React.useRef<MapLibreMap | null>(null);
  const current = React.useRef({ model, cameraOptions, onState, onSelect });
  const generation = React.useRef(0);
  const [loaded, setLoaded] = React.useState(false);
  const failed = React.useRef(false);

  React.useLayoutEffect(() => {
    current.current = { model, cameraOptions, onState, onSelect };
  }, [model, cameraOptions, onState, onSelect]);

  React.useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let instance: MapLibreMap | undefined;
    failed.current = false;
    const fail = () => {
      if (disposed) return;
      failed.current = true;
      const latest = current.current;
      latest.onState({ modelId: latest.model.id, status: "error" });
    };
    void (async () => {
      try {
        const [maplibre] = await Promise.all([
          import("maplibre-gl"),
          import("maplibre-gl/dist/maplibre-gl.css"),
        ]);
        if (disposed || !container.current) return;
        // Expo serves/export-copies public assets; EXPO_BASE_URL is its built-in
        // deployment prefix. Native React Native does not import this web file.
        const workerUrl = new URL(`${(process.env.EXPO_BASE_URL || "").replace(/\/$/, "")}/${mapWorkerAsset.filename}`, window.location.origin);
        if (workerUrl.origin !== window.location.origin) throw new Error("map_worker_origin_unavailable");
        maplibre.setWorkerUrl(workerUrl.toString());
        instance = new maplibre.Map({
          container: container.current,
          style: initialStyle,
          attributionControl: {},
          maxZoom: current.current.cameraOptions.maxZoom,
        });
        map.current = instance;
        instance.on("error", fail);
        instance.on("load", () => {
          if (!disposed && !failed.current) setLoaded(true);
        });
        instance.on("click", "fieldops-stop-points", event => {
          const latest = current.current;
          const id = event.features?.[0]?.properties?.id;
          if (!disposed && typeof id === "string" && latest.model.points.features.some(point => point.properties.id === id)) {
            latest.onSelect(id);
          }
        });
        observer = new ResizeObserver(() => {
          if (!disposed) instance?.resize();
        });
        observer.observe(container.current);
      } catch {
        fail();
      }
    })();
    return () => {
      disposed = true;
      generation.current += 1;
      observer?.disconnect();
      instance?.remove();
      map.current = null;
    };
  }, [initialStyle]);

  React.useEffect(() => {
    const { model, cameraOptions, onState } = current.current;
    const revision = ++generation.current;
    const instance = map.current;
    let cancelled = false;
    let idle: (() => void) | undefined;
    const isCurrent = () => !cancelled && generation.current === revision;
    onState({ modelId: model.id, status: failed.current ? "error" : "loading" });
    if (loaded && instance && !failed.current) {
      void (async () => {
        try {
          if (!model.bounds) throw new Error("Map bounds unavailable");
          instance.setMaxZoom(cameraOptions.maxZoom);
          if (!instance.getSource("fieldops-route")) {
            instance.addSource("fieldops-route", { type: "geojson", data: model.routeLine });
            instance.addLayer({ id: "fieldops-route-line", type: "line", source: "fieldops-route", paint: MOBILE_REAL_MAP_LINE_PAINT });
            instance.addSource("fieldops-stops", { type: "geojson", data: model.points });
            instance.addLayer({
              id: "fieldops-stop-points", type: "circle", source: "fieldops-stops",
              paint: MOBILE_REAL_MAP_POINT_PAINT,
            });
          }
          const routeSource = instance.getSource<GeoJSONSource>("fieldops-route");
          const stopSource = instance.getSource<GeoJSONSource>("fieldops-stops");
          if (!routeSource || !stopSource) throw new Error("Map data source unavailable");
          await Promise.all([
            routeSource.setData(model.routeLine),
            stopSource.setData(model.points),
          ]);
          if (!isCurrent() || failed.current) return;
          idle = () => {
            if (isCurrent() && !failed.current && instance.loaded()) {
              current.current.onState({ modelId: model.id, status: "ready" });
              if (idle) instance.off("idle", idle);
            }
          };
          instance.on("idle", idle);
          if (model.count === 1) {
            instance.jumpTo({ center: model.points.features[0].geometry.coordinates, zoom: cameraOptions.singlePointZoom });
          } else {
            instance.fitBounds([model.bounds.southwest, model.bounds.northeast], { padding: cameraOptions.padding, duration: 0, maxZoom: cameraOptions.maxZoom });
          }
          instance.triggerRepaint();
        } catch {
          if (isCurrent()) {
            failed.current = true;
            current.current.onState({ modelId: model.id, status: "error" });
          }
        }
      })();
    }
    return () => {
      cancelled = true;
      if (idle && instance) instance.off("idle", idle);
    };
  }, [loaded, model.id, cameraOptions.padding.top, cameraOptions.padding.right, cameraOptions.padding.bottom, cameraOptions.padding.left, cameraOptions.singlePointZoom, cameraOptions.maxZoom]);

  return <div ref={container} style={{ width: "100%", height: "100%", minHeight: 1 }} />;
}
