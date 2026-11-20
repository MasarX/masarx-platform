import * as React from "react";
import { Text } from "react-native";
import { useTheme } from "../mobile-theme-context";

const RECENT_CAPTURE_MS = 30_000;

export function LocationCaptureStatus({
  capturedAt,
  maxAccuracyM,
}: {
  capturedAt?: number;
  maxAccuracyM: number | null;
}) {
  const { tokens } = useTheme();
  const [expiredCapture, setExpiredCapture] = React.useState<number>();
  React.useEffect(() => {
    if (capturedAt == null) return;
    const remaining = Math.max(0, RECENT_CAPTURE_MS - (Date.now() - capturedAt));
    const timeout = setTimeout(() => setExpiredCapture(capturedAt), remaining);
    return () => clearTimeout(timeout);
  }, [capturedAt]);

  const recent = capturedAt != null && expiredCapture !== capturedAt &&
    Date.now() - capturedAt < RECENT_CAPTURE_MS;
  return (
    <>
      <Text
        accessibilityLiveRegion="polite"
        testID="mobile-location-heartbeat"
        style={{ color: recent ? tokens.color.successFg : tokens.color.textMuted }}
      >
        {recent ? "Location captured recently" : "No recent location capture"}
      </Text>
      {maxAccuracyM !== null ? (
        <Text style={{ color: tokens.color.textMuted }}>
          Required accuracy: {maxAccuracyM} m or better
        </Text>
      ) : null}
    </>
  );
}
