import React from "react";
import { View } from "react-native";

// Web stub for react-native-maps.
// react-native-maps only runs on native (iOS/Android). On the web build, the
// Metro resolver (see metro.config.js) rewrites `react-native-maps` to this
// module so the bundle stays clean and browsers never try to load the native
// modules. Every export is a no-op component that renders `null` so callers
// can keep a single render path on both platforms.

type StubProps = {
  children?: React.ReactNode;
  [key: string]: unknown;
};

function StubComponent(_props: StubProps): JSX.Element | null {
  return null;
}

// Mirror the shape of react-native-maps' public exports so TypeScript callers
// that do `import MapView, { Marker, Callout } from "react-native-maps"` keep
// working on the web target. The default export is a plain `View` so callers
// that pass through props (style, accessibility, testID) still render a
// container on web without importing the native module.
export const MapView = View;
export const Marker = StubComponent;
export const Callout = StubComponent;
export const Polyline = StubComponent;
export const Polygon = StubComponent;
export const Circle = StubComponent;
export const Overlay = StubComponent;
export const Heatmap = StubComponent;
export const Geojson = StubComponent;
export const PROVIDER_GOOGLE = undefined;
export const PROVIDER_DEFAULT = undefined;

export default View;
