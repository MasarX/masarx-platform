import * as React from "react";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import type { MobileRealMapModel } from "./mobile-real-map-model";
import { resolveMobileMapConfiguration, type MobileOpenMapPolicy } from "./mobile-open-map-policy";
import { MobileRealMapRenderer } from "./mobile-real-map-renderer";
import { MOBILE_REAL_MAP_TONE_COLORS } from "./mobile-real-map-renderer.types";
import type { RouteStatusTone } from "./mobile-shell-route-map";

const legendTones: RouteStatusTone[] = ["done", "issue", "active", "neutral"];

export type MobileRealMapStrings = {
  title: string;
  points: string;
  eta: string;
  status: string;
  unknownStatus: string;
  mapToneLabels?: Record<RouteStatusTone, string>;
  loading: string;
  empty: string;
  error: string;
  blocked: string;
  retry: string;
  excluded: (count: number) => string;
};

export function MobileRealMap({ model, policy, strings, onSelect, interactionLocked = false }: {
  model: MobileRealMapModel;
  policy: MobileOpenMapPolicy;
  strings: MobileRealMapStrings;
  onSelect: (id: string) => void;
  interactionLocked?: boolean;
}) {
  const { mapToneLabels } = strings;
  const runtime = Platform.OS === "web" ? "web" : Platform.OS === "ios" || Platform.OS === "android" ? "native" : "unsupported";
  const origin = runtime === "web" && typeof window !== "undefined" ? window.location.origin : undefined;
  const config = React.useMemo(() => resolveMobileMapConfiguration(policy, runtime, origin), [policy, runtime, origin]);
  const [attempt, setAttempt] = React.useState(0);
  const [selection, setSelection] = React.useState<{ modelId: string; id: string } | null>(null);
  const identity = JSON.stringify([model.id, config, attempt]);
  const effectiveModel = React.useMemo(() => ({ ...model, id: identity }), [model, identity]);
  const [state, setState] = React.useState<{ modelId: string; status: "loading" | "ready" | "error" }>({ modelId: identity, status: "loading" });
  const admission = React.useRef({ identity, failed: false });
  React.useLayoutEffect(() => { admission.current = { identity, failed: false }; }, [identity]);
  const onState = React.useCallback((next: typeof state) => {
    if (next.modelId !== admission.current.identity || admission.current.failed) return;
    if (next.status === "error") admission.current.failed = true;
    setState(next);
  }, []);
  const selectPoint = (id: string) => {
    if (interactionLocked || admission.current.identity !== identity || admission.current.failed || !model.points.features.some((point) => point.properties.id === id)) return;
    setSelection({ modelId: model.id, id });
    onSelect(id);
  };
  const status = state.modelId === identity ? state.status : "loading";
  React.useEffect(() => {
    if (!config.ok || !model.count || status !== "loading") return;
    const timer = setTimeout(() => onState({ modelId: identity, status: "error" }), config.loadTimeoutMs);
    return () => clearTimeout(timer);
  }, [config, model.count, status, identity, onState]);
  return (
    <View testID="mobile-real-map" accessibilityLabel={strings.title}>
      {model.excludedCount > 0 ? <Text>{strings.excluded(model.excludedCount)}</Text> : null}
      {!config.ok ? <Text accessibilityRole="alert">{strings.blocked}</Text> : !model.count ? <Text>{strings.empty}</Text> : (
        <>
          {status !== "error" ? (
            <View style={{ height: 400 }} pointerEvents={interactionLocked ? "none" : "auto"} accessibilityState={{ disabled: interactionLocked, busy: status === "loading" }}>
              <MobileRealMapRenderer key={attempt} model={effectiveModel} style={config.style} camera={config.camera} onState={onState} onSelect={selectPoint} />
            </View>
          ) : null}
          {status === "ready" ? (
            <View>
              {mapToneLabels ? (
                <View testID="mobile-real-map-legend" style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
                  {legendTones.map((tone) => (
                    <View key={tone} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                      <View aria-hidden={true} style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: MOBILE_REAL_MAP_TONE_COLORS[tone] }} />
                      <Text>{mapToneLabels[tone]}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              <Text>{strings.points}: {model.count}</Text>
              {model.points.features.map(({ properties: point }) => {
                const label = [point.title, `${strings.status}: ${point.status ?? strings.unknownStatus}`, point.etaMinutes === null ? null : `${strings.eta}: ${point.etaMinutes}`]
                  .filter(Boolean).join(" · ");
                return (
                  <Pressable key={point.id} testID={`mobile-map-point-${point.id}`}
                    accessibilityRole="button" accessibilityLabel={label}
                    accessibilityState={{ disabled: interactionLocked, selected: selection?.modelId === model.id && selection.id === point.id }}
                    disabled={interactionLocked} onPress={() => selectPoint(point.id)}
                    style={{ minHeight: 48, paddingVertical: 8 }}>
                    <Text>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {status === "loading" ? <Text accessibilityLiveRegion="polite">{strings.loading}</Text> : null}
          {status === "error" ? (
            <View accessibilityRole="alert">
              <Text>{strings.error}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={strings.retry} disabled={interactionLocked} accessibilityState={{ disabled: interactionLocked }} onPress={() => setAttempt((value) => value + 1)}>
                <Text>{strings.retry}</Text>
              </Pressable>
            </View>
          ) : status === "ready" ? (
            <Pressable accessibilityRole="link" accessibilityLabel={config.attributionLabel} onPress={() => { void Linking.openURL(config.attributionUrl).catch(() => undefined); }}>
              <Text>{config.attributionLabel}</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}
