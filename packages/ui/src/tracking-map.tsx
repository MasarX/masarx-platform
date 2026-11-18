"use client";

import * as React from "react";
import type { Map as MapLibreMap, Popup as MapLibrePopup } from "maplibre-gl";
import type { TrackingMapConfiguration } from "./tracking-map-policy";

// Web Mercator's finite square-world latitude boundary. MapLibre clamps beyond
// this extent; reject instead so a pin never appears at an invented position.
const MERCATOR_MAX_LATITUDE = Math.atan(Math.sinh(Math.PI)) * 180 / Math.PI;

export type TrackingMapPin = {
  id: string;
  latitude: number;
  longitude: number;
  label: string | null;
  status: string | null;
};
export type TrackingMapProps = {
  /** Verified actor/scope, selected dataset and page identity from the server. */
  identity: string;
  pins: readonly TrackingMapPin[];
  policy: TrackingMapConfiguration;
  labels: { map: string; loading: string; unavailable: string; empty: string };
};

export function TrackingMap(props: TrackingMapProps) {
  if (!props.policy.ok || !props.identity || props.pins.some(pin =>
    !pin.id || !Number.isFinite(pin.latitude) || Math.abs(pin.latitude) > MERCATOR_MAX_LATITUDE ||
    !Number.isFinite(pin.longitude) || Math.abs(pin.longitude) > 180
  ) || new Set(props.pins.map(pin => pin.id)).size !== props.pins.length) {
    return <p role="alert">{props.labels.unavailable}</p>;
  }
  if (!props.pins.length) return <p>{props.labels.empty}</p>;
  // Replacement removes the old scope's DOM synchronously; asynchronous callbacks
  // belong only to their mounted scene, never to the next actor or page.
  return <TrackingMapScene key={JSON.stringify([props.identity, props.pins, props.policy])}
    {...props} policy={props.policy} />;
}

function TrackingMapScene({ pins, policy, labels }: TrackingMapProps & {
  policy: Extract<TrackingMapConfiguration, { ok: true }>;
}) {
  const container = React.useRef<HTMLDivElement>(null);
  const snapshot = React.useRef({ pins, policy }).current;
  const togglePin = React.useRef<((pin: TrackingMapPin) => void) | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [state, setState] = React.useState<"loading" | "ready" | "error">("loading");
  type Stage = "module" | "map" | "waiting-load" | "source" | "camera" | "waiting-idle";
  type Readiness = { loaded: boolean | null; style: boolean | null; tiles: boolean | null;
    pins: boolean | null; moving: boolean | null; render: number; idle: number; sourcedata: number; resize: number };
  const [diagnostic, setDiagnostic] = React.useState<{ stage: Stage; cause: "exception" | "event" | "timeout"; readiness?: Readiness } | null>(null);
  React.useEffect(() => {
    const { pins, policy } = snapshot;
    let disposed = false;
    let failed = false;
    let stage: Stage = "module";
    let instance: MapLibreMap | undefined;
    let observer: ResizeObserver | undefined;
    let popup: MapLibrePopup | undefined;
    let popupPinId: string | undefined;
    const counts = { render: 0, idle: 0, sourcedata: 0, resize: 0 };
    const readBoolean = (read: () => unknown): boolean | null => {
      try { const value = read(); return typeof value === "boolean" ? value : null; } catch { return null; }
    };
    const removePopup = () => {
      popup?.remove();
      popup = undefined;
      popupPinId = undefined;
    };
    const disposeMap = () => {
      togglePin.current = null;
      removePopup();
      observer?.disconnect();
      observer = undefined;
      const old = instance;
      instance = undefined;
      old?.remove();
    };
    const fail = (cause: "exception" | "event" | "timeout") => {
      if (disposed || failed) return;
      failed = true;
      // Snapshot public predicates before removal; null means unavailable, never false proof.
      const readiness = cause === "timeout" ? {
        loaded: readBoolean(() => instance?.loaded()),
        style: readBoolean(() => instance?.isStyleLoaded()),
        tiles: readBoolean(() => instance?.areTilesLoaded()),
        pins: readBoolean(() => instance?.getSource("tracking-pins") ? instance.isSourceLoaded("tracking-pins") : undefined),
        moving: readBoolean(() => instance?.isMoving()), ...counts,
      } : undefined;
      setSelectedId(null);
      setDiagnostic({ stage, cause, readiness });
      clearTimeout(timer);
      disposeMap();
      setState("error");
    };
    const timer = setTimeout(() => fail("timeout"), policy.loadTimeoutMs);
    // Generic web mechanics adapted from mobile-real-map-renderer.web.tsx.
    // No mobile validation, route model, provider defaults, or remote styles.
    void (async () => {
      try {
        const [maplibre, , worker] = await Promise.all([
          import("maplibre-gl"), import("maplibre-gl/dist/maplibre-gl.css"), import("./tracking-map-worker-url.mjs"),
        ]);
        if (disposed || failed || !container.current) return;
        // MapLibre 6 no longer embeds its worker. Configure the bundled asset
        // before constructing any map; do not add blob/CDN CSP exceptions.
        const workerUrl = new URL(worker.default, window.location.href);
        if (workerUrl.origin !== window.location.origin) throw new Error("map_worker_origin_unavailable");
        maplibre.setWorkerUrl(workerUrl.toString());
        stage = "map";
        const map = new maplibre.Map({ container: container.current, style: policy.style,
          maxZoom: policy.camera.maxZoom, interactive: false, attributionControl: false });
        instance = map;
        for (const event of ["render", "idle", "sourcedata", "resize"] as const) {
          map.on(event, () => { if (!disposed && !failed) counts[event] = Math.min(1000000, counts[event] + 1); });
        }
        map.on("error", () => fail("event"));
        map.on("load", () => {
          if (disposed || failed) return;
          try {
            stage = "source";
            map.addSource("tracking-pins", { type: "geojson", data: {
              type: "FeatureCollection", features: pins.map(pin => ({
                type: "Feature", id: pin.id, properties: { id: pin.id },
                geometry: { type: "Point", coordinates: [pin.longitude, pin.latitude] },
              })),
            } });
            map.addLayer({ id: "tracking-points", type: "circle", source: "tracking-pins",
              paint: { "circle-radius": 7, "circle-color": "#2563eb",
                "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
            togglePin.current = (pin) => {
              if (disposed || failed || !map.loaded()) return;
              const wasSelected = popupPinId === pin.id;
              removePopup();
              if (wasSelected) {
                setSelectedId(null);
                return;
              }
              const content = document.createElement("div");
              const label = document.createElement("strong");
              label.textContent = pin.label || pin.latitude + ", " + pin.longitude;
              content.append(label);
              if (pin.status) {
                const status = document.createElement("div");
                status.textContent = pin.status;
                content.append(status);
              }
              popup = new maplibre.Popup({ closeButton: false, closeOnClick: false, focusAfterOpen: false })
                .setLngLat([pin.longitude, pin.latitude]).setDOMContent(content).addTo(map);
              popupPinId = pin.id;
              setSelectedId(pin.id);
            };
            map.on("click", "tracking-points", (event) => {
              const id = event.features?.[0]?.id;
              const pin = pins.find((entry) => entry.id === id);
              if (pin) togglePin.current?.(pin);
            });
            map.on("idle", () => {
              if (!disposed && !failed && map.loaded()) {
                clearTimeout(timer);
                setState("ready");
              }
            });
            let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
            stage = "camera";
            for (const pin of pins) {
              west = Math.min(west, pin.longitude); east = Math.max(east, pin.longitude);
              south = Math.min(south, pin.latitude); north = Math.max(north, pin.latitude);
            }
            if (west === east && south === north) {
              map.jumpTo({ center: [west, south], zoom: policy.camera.singlePointZoom });
            } else {
              map.fitBounds([[west, south], [east, north]], {
                padding: policy.camera.padding, duration: 0, maxZoom: policy.camera.maxZoom,
              });
            }
            map.triggerRepaint();
            stage = "waiting-idle";
          } catch { fail("exception"); }
        });
        observer = new ResizeObserver(() => { if (!disposed && !failed) map.resize(); });
        observer.observe(container.current);
        stage = "waiting-load";
      } catch { fail("exception"); }
    })();
    return () => { disposed = true; clearTimeout(timer); disposeMap(); };
  }, [snapshot]);

  return <figure aria-busy={state === "loading"} data-map-state={state}
    data-map-failure-stage={diagnostic?.stage} data-map-failure-cause={diagnostic?.cause}
    data-map-readiness={diagnostic?.readiness ? JSON.stringify(diagnostic.readiness) : undefined}>
    <figcaption>{labels.map}</figcaption>
    {state === "loading" ? <p>{labels.loading}</p> : null}
    {state === "error" ? <p role="alert">{labels.unavailable}</p> : null}
    <div ref={container} aria-hidden="true" style={{ width: "100%", height: "24rem" }} />
    <a href={policy.attributionUrl} rel="noreferrer">{policy.attributionLabel}</a>
    <ul>{pins.map(pin => <li key={pin.id}>
      <button type="button" className="text-start" disabled={state !== "ready"}
        aria-pressed={selectedId === pin.id}
        onClick={() => togglePin.current?.(pin)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && selectedId === pin.id) togglePin.current?.(pin);
        }}>
        {pin.label ? <span>{pin.label} </span> : null}
        <span>{pin.latitude}, {pin.longitude}</span>
        {pin.status ? <span> — {pin.status}</span> : null}
      </button>
    </li>)}</ul>
  </figure>;
}
