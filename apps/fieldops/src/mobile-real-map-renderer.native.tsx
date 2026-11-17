import * as React from "react";
import { Camera, GeoJSONSource, Layer, Map, type CameraRef } from "@maplibre/maplibre-react-native";
import { MOBILE_REAL_MAP_LINE_PAINT, MOBILE_REAL_MAP_POINT_PAINT, type MobileRealMapRendererProps } from "./mobile-real-map-renderer.types";

export function MobileRealMapRenderer(props: MobileRealMapRendererProps) {
  // Native render events have no model identity: isolate actual model/style/camera changes.
  const { padding, singlePointZoom, maxZoom } = props.camera;
  const sceneId = JSON.stringify([props.model.id, props.style, padding.top, padding.right, padding.bottom, padding.left, singlePointZoom, maxZoom]);
  return <NativeMapScene key={sceneId} {...props} />;
}

function NativeMapScene({ model, style, camera: cameraOptions, onState, onSelect }: MobileRealMapRendererProps) {
  const initialStyle = React.useRef(style).current;
  const latest = React.useRef({ model, cameraOptions, onState });
  React.useLayoutEffect(() => { latest.current = { model, cameraOptions, onState }; }, [model, cameraOptions, onState]);
  const fatal = React.useRef(false);
  const camera = React.useRef<CameraRef>(null);
  const generation = React.useRef(0);
  const current = React.useRef({ modelId: model.id, dispatched: false, accepted: false, rendered: false, ready: false, failed: false, alive: false });
  const [loaded, setLoaded] = React.useState(false);
  React.useLayoutEffect(() => () => { current.current.alive = false; }, []);
  const settle = () => {
    const state = current.current;
    if (state.alive && state.accepted && state.rendered && !state.failed && !state.ready) {
      state.ready = true;
      latest.current.onState({ modelId: state.modelId, status: "ready" });
    }
  };

  React.useEffect(() => {
    const { model, cameraOptions, onState } = latest.current;
    const revision = ++generation.current;
    current.current = { modelId: model.id, dispatched: false, accepted: false, rendered: false, ready: false, failed: fatal.current, alive: true };
    onState({ modelId: model.id, status: fatal.current ? "error" : "loading" });
    const isCurrent = () => current.current.alive && generation.current === revision;
    if (loaded && !fatal.current) {
      void (async () => {
        try {
          if (!camera.current || !model.bounds) throw new Error("Map camera or bounds unavailable");
          const { southwest, northeast } = model.bounds;
          const padding = cameraOptions.padding;
          // setStop acknowledges command handling, not pixels. Require a scene-local
          // full-render event after dispatch as a separate lifecycle signal, in either order.
          current.current.dispatched = true;
          await camera.current.setStop(model.count === 1 ? {
            center: model.points.features[0].geometry.coordinates,
            zoom: cameraOptions.singlePointZoom,
            duration: 0,
          } : {
            bounds: [southwest[0], southwest[1], northeast[0], northeast[1]],
            padding,
            duration: 0,
          });
          if (isCurrent() && !current.current.failed) {
            current.current.accepted = true;
            settle();
          }
        } catch {
          if (isCurrent()) {
            current.current.failed = true;
            latest.current.onState({ modelId: model.id, status: "error" });
          }
        }
      })();
    }
    return () => { current.current.alive = false; };
  }, [loaded, model.id, cameraOptions.padding.top, cameraOptions.padding.right, cameraOptions.padding.bottom, cameraOptions.padding.left, cameraOptions.singlePointZoom, cameraOptions.maxZoom]);

  const fail = () => {
    if (!current.current.alive) return;
    fatal.current = true;
    current.current.failed = true;
    latest.current.onState({ modelId: current.current.modelId, status: "error" });
  };

  return (
    <Map
      mapStyle={initialStyle}
      style={{ flex: 1 }}
      attribution
      dragPan
      touchZoom
      touchRotate={false}
      touchPitch={false}
      onDidFinishLoadingMap={() => { if (current.current.alive && !fatal.current) setLoaded(true); }}
      onDidFailLoadingMap={fail}
      onDidFinishRenderingMapFully={() => {
        const state = current.current;
        if (state.alive && state.dispatched && !state.failed) {
          state.rendered = true;
          settle();
        }
      }}
    >
      <Camera ref={camera} maxZoom={cameraOptions.maxZoom} />
      <GeoJSONSource id="fieldops-route" data={model.routeLine}>
        <Layer id="fieldops-route-line" type="line" paint={MOBILE_REAL_MAP_LINE_PAINT} />
      </GeoJSONSource>
      <GeoJSONSource
        id="fieldops-stops"
        data={model.points}
        onPress={(event) => {
          if (!current.current.alive) return;
          const id = event.nativeEvent.features[0]?.properties?.id;
          if (typeof id === "string" && model.points.features.some(point => point.properties.id === id)) onSelect(id);
        }}
      >
        <Layer
          id="fieldops-stop-points"
          type="circle"
          paint={MOBILE_REAL_MAP_POINT_PAINT}
        />
      </GeoJSONSource>
    </Map>
  );
}
