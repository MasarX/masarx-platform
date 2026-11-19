// Mobile V2 shell components — FxFrame / FxAppBar / SyncBanner / BottomTabs /
// AppDrawer / ToastHost / ScreenShell. Composed from the Fx primitives kit
// and the shell decision helpers. Uses react-native-safe-area-context for
// real device insets (NO synthetic notch overlay per AGENTS.md Mobile Field
// Ops Policy Contract).

import * as React from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  FxButton,
  FxChip,
  FxRow,
} from "./mobile-v2-primitives";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SHADOWS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_LETTER_SPACING,
  MOBILE_V2_TYPE_LINE_TIGHT,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";
import {
  composeDrawer,
  resolveAppBarLeadIcon,
  resolveBottomTabs,
  resolveSyncBannerState,
  resolveToastDuration,
  type ToastKind,
} from "./mobile-v2-shell-helpers";
import type {
  MobileV2NavigationItem,
  MobileV2NavigationSection,
} from "./mobile-v2-navigation";
import { useMobileV2Theme } from "./mobile-v2-theme-context";

// ---------------------------------------------------------------------------
// FxFrame — root container with safe-area-aware padding. Replaces the
// design source's synthetic phone frame; on real devices we trust the OS
// chrome and use safe-area insets only.
// ---------------------------------------------------------------------------

export interface FxFrameProps {
  readonly theme?: MobileV2Theme;
  readonly children: React.ReactNode;
}

export function FxFrame(props: FxFrameProps): React.ReactElement {
  const ctx = useMobileV2ThemeOrFallback();
  const theme = props.theme ?? ctx.theme;
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.bg,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      {props.children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// FxAppBar — top bar with lead icon (driven by resolveAppBarLeadIcon),
// title + optional subtitle, and right-rail slot for actions/chips. Accent
// variant (chrome background) for drawer header etc.
// ---------------------------------------------------------------------------

export interface FxAppBarProps {
  readonly theme?: MobileV2Theme;
  readonly title: string;
  readonly sub?: string;
  readonly onBack?: () => void;
  readonly onMenu?: () => void;
  readonly right?: React.ReactNode;
  readonly accent?: boolean;
  readonly dense?: boolean;
  /**
   * Optional small icon-disk rendered to the left of the title text.
   * Matches the design canvas ScrRoute "truck" tile that prefixes "My
   * route ▾". Implementation: 28×28 surfaceAlt disk with the icon
   * centered.
   *
   * NOTE (audit F10): the Tasks / Route app bar must NOT use this — the
   * design renders the saved-view EMOJI glyph inline with the title (no
   * icon-disk box). Use `titleEmoji` for those screens.
   */
  readonly titleIcon?: import("./mobile-v2-icon-specs").MobileV2IconName;
  /**
   * Optional emoji glyph rendered inline immediately before the title
   * text (NO icon-disk box). Matches the design canvas ScrTasks "⚡ Smart
   * inbox ⌄" / ScrRoute "🛣 My route ⌄" saved-view title (audit F10).
   */
  readonly titleEmoji?: string;
  /**
   * Render a chevron-down glyph immediately after the title so the user
   * can perceive it as a context-switching dropdown (design canvas
   * ScrRoute "My route ▾"). Visual only.
   */
  readonly titleDropdown?: boolean;
  /**
   * When set, the title (+ emoji + chevron) is a pressable that opens
   * the Saved Views sheet — matches the design canvas ScrTasks /
   * ScrRoute `<button>` title (audit F8). Without it the title is a
   * plain non-interactive label.
   */
  readonly onTitlePress?: () => void;
}

export function FxAppBar(props: FxAppBarProps): React.ReactElement {
  const ctx = useMobileV2ThemeOrFallback();
  const theme = props.theme ?? ctx.theme;
  const lead = resolveAppBarLeadIcon({
    hasOnBack: typeof props.onBack === "function",
    hasOnMenu: typeof props.onMenu === "function",
  });
  const accent = props.accent === true;
  const padTop = props.dense === true ? MOBILE_V2_SPACING.lg : MOBILE_V2_SPACING.xl;
  const padBottom = props.dense === true ? MOBILE_V2_SPACING.xl : MOBILE_V2_SPACING["3xl"];
  const fg = accent ? theme.onChrome : theme.ink;
  const subFg = accent ? theme.onChrome : theme.muted;
  const bg = accent ? theme.chrome : theme.surface;
  const borderColor = accent ? theme.chrome : theme.border;

  return (
    <View
      style={{
        backgroundColor: bg,
        paddingHorizontal: MOBILE_V2_SPACING["4xl"],
        paddingTop: padTop,
        paddingBottom: padBottom,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: borderColor,
        flexDirection: "row",
        alignItems: "center",
        // design _kit.jsx FxAppBar uses gap:10 between lead/title/right.
        columnGap: MOBILE_V2_SPACING.xl,
      }}
      accessibilityRole="header"
    >
      {lead === "arrow-left" ? (
        <Pressable
          onPress={props.onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <FxIcon name="arrow-left" size={22} color={fg} />
        </Pressable>
      ) : lead === "menu" ? (
        <Pressable
          onPress={props.onMenu}
          accessibilityRole="button"
          accessibilityLabel="Open menu"
          hitSlop={8}
        >
          <FxIcon name="menu" size={22} color={fg} />
        </Pressable>
      ) : null}

      {props.titleIcon !== undefined ? (
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: MOBILE_V2_RADII.iconDisk,
            backgroundColor: accent ? theme.chrome : theme.surfaceAlt,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FxIcon name={props.titleIcon} size={14} color={fg} />
        </View>
      ) : null}

      <View style={{ flex: 1 }}>
        {(() => {
          // Title row — design ScrTasks / ScrRoute render an inline
          // `{emoji} {name} ⌄` saved-view picker as a <button>. When
          // `onTitlePress` is set the whole row is a pressable.
          const titleRow = (
            <View
              style={{ flexDirection: "row", alignItems: "center", columnGap: MOBILE_V2_SPACING.md }}
            >
              {props.titleEmoji !== undefined ? (
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.appBarTitle,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    lineHeight:
                      MOBILE_V2_TYPE_SIZES.appBarTitle * MOBILE_V2_TYPE_LINE_TIGHT,
                  }}
                >
                  {props.titleEmoji}
                </Text>
              ) : null}
              <Text
                style={{
                  color: fg,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontSize: MOBILE_V2_TYPE_SIZES.appBarTitle,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.appBarTitle,
                  // design _kit.jsx FxAppBar title sets lineHeight:1.1 —
                  // porting it keeps the app-bar height aligned.
                  lineHeight: MOBILE_V2_TYPE_SIZES.appBarTitle * MOBILE_V2_TYPE_LINE_TIGHT,
                }}
                numberOfLines={1}
              >
                {props.title}
              </Text>
              {props.titleDropdown === true ? (
                <FxIcon name="chevron-down" size={16} color={fg} />
              ) : null}
            </View>
          );
          return props.onTitlePress !== undefined ? (
            <Pressable
              onPress={props.onTitlePress}
              accessibilityRole="button"
              accessibilityLabel={`${props.title} — change view`}
              hitSlop={6}
              style={{ alignSelf: "flex-start" }}
            >
              {titleRow}
            </Pressable>
          ) : (
            titleRow
          );
        })()}
        {props.sub !== undefined ? (
          <Text
            style={{
              color: subFg,
              fontFamily: MOBILE_V2_FONT_SANS,
              fontSize: MOBILE_V2_TYPE_SIZES.appBarSubtitle,
              // design _kit.jsx FxAppBar sub sets no fontWeight (→ 400).
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.regular,
              marginTop: 2,
            }}
            numberOfLines={1}
          >
            {props.sub}
          </Text>
        ) : null}
      </View>

      {props.right !== undefined ? <View>{props.right}</View> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// SyncBanner — driven by resolveSyncBannerState. Hidden when queue is empty.
// ---------------------------------------------------------------------------

export interface SyncBannerProps {
  readonly theme?: MobileV2Theme;
  readonly online: boolean;
  readonly syncing: boolean;
  readonly queueCount: number;
  readonly onPress?: () => void;
}

export function SyncBanner(props: SyncBannerProps): React.ReactElement | null {
  const ctx = useMobileV2ThemeOrFallback();
  const theme = props.theme ?? ctx.theme;
  const state = resolveSyncBannerState({
    online: props.online,
    syncing: props.syncing,
    queueCount: props.queueCount,
  });
  if (!state.visible) return null;
  const bg = state.kind === "syncing" ? theme.infoSoft : theme.warningSoft;
  const fg = state.kind === "syncing" ? theme.info : theme.warning;
  const icon: MobileV2IconName = state.kind === "syncing" ? "sync" : "wifi-off";
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={state.label}
      style={{
        backgroundColor: bg,
        paddingHorizontal: MOBILE_V2_SPACING["4xl"],
        paddingVertical: MOBILE_V2_SPACING.lg,
        flexDirection: "row",
        alignItems: "center",
        columnGap: MOBILE_V2_SPACING.lg,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.border,
      }}
    >
      <FxIcon name={icon} size={16} color={fg} />
      <Text
        style={{
          color: fg,
          fontFamily: MOBILE_V2_FONT_SANS,
          fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
          flex: 1,
        }}
      >
        {state.label}
      </Text>
      <Text
        style={{
          color: fg,
          fontFamily: MOBILE_V2_FONT_MONO,
          fontSize: MOBILE_V2_TYPE_SIZES.chip,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
        }}
      >
        {String(state.count)} POSTs queued
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// BottomTabs — role-aware, driven by resolveBottomTabs over filtered
// navigation. Active tab highlighted by accent color.
// ---------------------------------------------------------------------------

export interface BottomTabsProps {
  readonly theme?: MobileV2Theme;
  readonly visibleSections: ReadonlyArray<MobileV2NavigationSection>;
  readonly activeRole: string;
  readonly activeItemId?: string;
  readonly onPressTab: (item: MobileV2NavigationItem) => void;
  readonly maxTabs?: number;
  /**
   * Optional badge counts keyed by tab id (e.g. `{ "mobile-tasks": 13,
   * "mobile-pickups": 5 }`). When > 0, a small accent-toned chip is
   * rendered top-right of the tab icon — matches the design canvas's
   * driver bottom-nav badge contract.
   */
  readonly badges?: Readonly<Record<string, number>>;
}

export function BottomTabs(props: BottomTabsProps): React.ReactElement | null {
  const ctx = useMobileV2ThemeOrFallback();
  const theme = props.theme ?? ctx.theme;
  const { tabs } = resolveBottomTabs({
    visibleSections: props.visibleSections,
    activeRole: props.activeRole,
    maxTabs: props.maxTabs,
  });
  if (tabs.length === 0) return null;
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: theme.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.border,
        // Design BottomTabs (app-shell.jsx:153) has no bar padding — each
        // tab owns its 8px-top / 6px-bottom inset. Bar padding here made
        // the impl tab bar 12px taller and lifted every tab-root screen's
        // nav labels (element-diff dy-8).
      }}
      accessibilityRole="tablist"
    >
      {tabs.map((tab) => {
        const active = tab.id === props.activeItemId;
        const fg = active ? theme.accent : theme.muted;
        const badgeCount = props.badges?.[tab.id] ?? 0;
        return (
          <Pressable
            key={tab.id}
            onPress={() => props.onPressTab(tab)}
            accessibilityRole="tab"
            accessibilityLabel={
              badgeCount > 0 ? `${tab.label}, ${badgeCount} pending` : tab.label
            }
            accessibilityState={{ selected: active }}
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              // design BottomTabs tab padding: 8px top / 6px bottom.
              paddingTop: MOBILE_V2_SPACING.lg,
              paddingBottom: MOBILE_V2_SPACING.md,
              rowGap: MOBILE_V2_SPACING.xs,
            }}
          >
            <View style={{ position: "relative" }}>
              {tab.icon !== null ? (
                // Design BottomTabs (app-shell.jsx:158) overrides the
                // FxIcon stroke to 2.2 active / 1.8 inactive.
                <FxIcon name={tab.icon} size={20} color={fg} stroke={active ? 2.2 : 1.8} />
              ) : null}
              {badgeCount > 0 ? (
                <View
                  style={{
                    // Design BottomTabs badge (app-shell.jsx:160):
                    // 14×14, radius 7, offset top -4 / right -8, 3px
                    // horizontal padding — matched here for nav-bar parity.
                    position: "absolute",
                    top: -4,
                    right: -8,
                    minWidth: 14,
                    height: 14,
                    paddingHorizontal: 3,
                    borderRadius: 7,
                    backgroundColor: theme.accent,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text
                    style={{
                      // Design renders the tab badge count in the mono face.
                      color: theme.accentInk,
                      fontFamily: MOBILE_V2_FONT_MONO,
                      fontSize: 9,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      lineHeight: 12,
                    }}
                  >
                    {badgeCount > 99 ? "99+" : String(badgeCount)}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              style={{
                // Design BottomTabs label (app-shell.jsx:162) is a
                // constant fontSize 10 / fontWeight 600 — only the color
                // changes with the active state, not the weight.
                color: fg,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontSize: MOBILE_V2_TYPE_SIZES.chipDense,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
              }}
              numberOfLines={1}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// AppDrawer — modal slide-in panel with role switcher (when >1 role) and
// filtered nav sections. Composed via composeDrawer.
// ---------------------------------------------------------------------------

export interface AppDrawerIdentity {
  readonly name?: string;
  readonly employeeId?: string;
  readonly phone?: string;
}

export interface AppDrawerProps {
  readonly theme?: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly identity: AppDrawerIdentity;
  readonly availableRoles: ReadonlyArray<string>;
  readonly activeRole: string;
  readonly onSelectRole: (role: string) => void;
  readonly allSections: ReadonlyArray<MobileV2NavigationSection>;
  readonly capabilities: ReadonlyArray<string>;
  readonly onSelectItem: (item: MobileV2NavigationItem) => void;
  readonly onSignOut?: () => void;
}

export function AppDrawer(props: AppDrawerProps): React.ReactElement {
  const ctx = useMobileV2ThemeOrFallback();
  const theme = props.theme ?? ctx.theme;
  const composition = composeDrawer({
    allSections: props.allSections,
    context: { activeRole: props.activeRole, capabilities: props.capabilities },
  });
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="slide"
      onRequestClose={props.onClose}
    >
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View
          style={{
            width: "82%",
            maxWidth: 360,
            backgroundColor: theme.surface,
            ...MOBILE_V2_SHADOWS.drawer,
          }}
        >
          {/* Identity header on chrome */}
          <View
            style={{
              backgroundColor: theme.chrome,
              padding: MOBILE_V2_SPACING["4xl"],
              rowGap: MOBILE_V2_SPACING.sm,
            }}
          >
            <Text
              style={{
                color: theme.onChrome,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontSize: MOBILE_V2_TYPE_SIZES.appBarTitle,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              }}
            >
              {props.identity.name ?? "Field Ops"}
            </Text>
            {props.identity.employeeId !== undefined ? (
              <Text
                style={{
                  color: theme.onChrome,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  fontSize: MOBILE_V2_TYPE_SIZES.chip,
                  opacity: 0.85,
                }}
              >
                {props.identity.employeeId}
              </Text>
            ) : null}
          </View>

          <ScrollView style={{ flex: 1 }}>
            {/* Role switcher when user has multiple roles */}
            {props.availableRoles.length > 1 ? (
              <View
                style={{
                  padding: MOBILE_V2_SPACING["4xl"],
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: theme.border,
                  rowGap: MOBILE_V2_SPACING.lg,
                }}
              >
                <Text
                  style={{
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    fontSize: MOBILE_V2_TYPE_SIZES.sectionHead,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.sectionHead,
                    textTransform: "uppercase",
                  }}
                >
                  Active Role
                </Text>
                <FxRow gap={MOBILE_V2_SPACING.md} wrap>
                  {props.availableRoles.map((role) => (
                    <FxChip
                      key={role}
                      theme={theme}
                      tone={role === props.activeRole ? "accent" : "neutral"}
                      style={{
                        opacity: 1,
                      } as StyleProp<ViewStyle>}
                    >
                      <Pressable onPress={() => props.onSelectRole(role)} hitSlop={4}>
                        <Text>{role}</Text>
                      </Pressable>
                    </FxChip>
                  ))}
                </FxRow>
              </View>
            ) : null}

            {/* Sections */}
            {composition.sections.map((section) => (
              <View
                key={section.id}
                style={{
                  paddingHorizontal: MOBILE_V2_SPACING["4xl"],
                  paddingVertical: MOBILE_V2_SPACING["2xl"],
                  rowGap: MOBILE_V2_SPACING.lg,
                }}
              >
                <Text
                  style={{
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    fontSize: MOBILE_V2_TYPE_SIZES.sectionHead,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.sectionHead,
                    textTransform: "uppercase",
                  }}
                >
                  {section.label}
                </Text>
                {section.items.map((item) => (
                  <Pressable
                    key={item.id}
                    onPress={() => props.onSelectItem(item)}
                    accessibilityRole="link"
                    accessibilityLabel={item.label}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      columnGap: MOBILE_V2_SPACING["2xl"],
                      paddingVertical: MOBILE_V2_SPACING.md,
                    }}
                  >
                    {item.icon !== null ? (
                      <FxIcon name={item.icon} size={20} color={theme.ink} />
                    ) : (
                      <View style={{ width: 20, height: 20 }} />
                    )}
                    <Text
                      style={{
                        flex: 1,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_SANS,
                        fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.medium,
                      }}
                    >
                      {item.label}
                    </Text>
                    <FxIcon name="chevron-right" size={16} color={theme.mutedSoft} />
                  </Pressable>
                ))}
              </View>
            ))}

            {/* Sign out */}
            {props.onSignOut !== undefined ? (
              <View
                style={{
                  padding: MOBILE_V2_SPACING["4xl"],
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: theme.border,
                }}
              >
                <FxButton theme={theme} variant="ghost" full onPress={props.onSignOut} icon="logout">
                  Sign out
                </FxButton>
              </View>
            ) : null}
          </ScrollView>
        </View>

        {/* Scrim */}
        <Pressable
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)" }}
          onPress={props.onClose}
          accessibilityLabel="Close menu"
        />
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// ToastHost — single floating toast with auto-dismiss timer
// ---------------------------------------------------------------------------

export interface ToastDescriptor {
  readonly id: string;
  readonly message: string;
  readonly kind?: ToastKind;
  readonly durationMs?: number;
}

export interface ToastHostProps {
  readonly theme?: MobileV2Theme;
  readonly toast: ToastDescriptor | null;
  readonly onDismiss: () => void;
}

export function ToastHost(props: ToastHostProps): React.ReactElement | null {
  const ctx = useMobileV2ThemeOrFallback();
  const theme = props.theme ?? ctx.theme;
  React.useEffect(() => {
    if (props.toast === null) return;
    const duration = resolveToastDuration({
      kind: props.toast.kind,
      durationMs: props.toast.durationMs,
    });
    const timer = setTimeout(props.onDismiss, duration);
    return () => clearTimeout(timer);
  }, [props.toast, props.onDismiss]);
  if (props.toast === null) return null;
  const kind: ToastKind = props.toast.kind ?? "info";
  const palette = (() => {
    switch (kind) {
      case "success":
        return { bg: theme.successSoft, fg: theme.success, icon: "check" as const };
      case "warning":
        return { bg: theme.warningSoft, fg: theme.warning, icon: "alert" as const };
      case "danger":
        return { bg: theme.dangerSoft, fg: theme.danger, icon: "alert" as const };
      case "info":
      default:
        return { bg: theme.infoSoft, fg: theme.info, icon: "info" as const };
    }
  })();
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        bottom: MOBILE_V2_SPACING["6xl"],
        left: MOBILE_V2_SPACING["4xl"],
        right: MOBILE_V2_SPACING["4xl"],
      }}
    >
      <View
        style={{
          backgroundColor: palette.bg,
          borderRadius: MOBILE_V2_RADII.card,
          padding: MOBILE_V2_SPACING["3xl"],
          flexDirection: "row",
          alignItems: "center",
          columnGap: MOBILE_V2_SPACING["2xl"],
          ...MOBILE_V2_SHADOWS.toast,
          borderWidth: 1,
          borderColor: palette.fg,
        }}
        accessibilityRole="alert"
      >
        <FxIcon name={palette.icon} size={18} color={palette.fg} />
        <Text
          style={{
            flex: 1,
            color: palette.fg,
            fontFamily: MOBILE_V2_FONT_SANS,
            fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
          }}
        >
          {props.toast.message}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// ScreenShell — composes AppBar + sync banner + content + bottom tabs
// inside an FxFrame. Tabs hidden when not provided.
// ---------------------------------------------------------------------------

export interface ScreenShellProps {
  readonly title: string;
  readonly sub?: string;
  readonly onBack?: () => void;
  readonly onMenu?: () => void;
  readonly right?: React.ReactNode;
  readonly accent?: boolean;
  /** Forwarded to FxAppBar.titleIcon — small icon-disk left of title. */
  readonly titleIcon?: import("./mobile-v2-icon-specs").MobileV2IconName;
  /** Forwarded to FxAppBar.titleEmoji — inline emoji glyph before title. */
  readonly titleEmoji?: string;
  /** Forwarded to FxAppBar.titleDropdown — chevron-down after title. */
  readonly titleDropdown?: boolean;
  /** Forwarded to FxAppBar.onTitlePress — opens the Saved Views sheet. */
  readonly onTitlePress?: () => void;
  /**
   * Suppresses the shell's own FxAppBar. Used when the active screen
   * renders its own header (e.g. the POD wizard's per-step app-bar) so the
   * shell does not stack a second header above it.
   */
  readonly hideAppBar?: boolean;

  readonly online?: boolean;
  readonly syncing?: boolean;
  readonly queueCount?: number;
  readonly onSyncPress?: () => void;

  readonly tabs?: {
    readonly visibleSections: ReadonlyArray<MobileV2NavigationSection>;
    readonly activeRole: string;
    readonly activeItemId?: string;
    readonly onPressTab: (item: MobileV2NavigationItem) => void;
    readonly maxTabs?: number;
    readonly badges?: Readonly<Record<string, number>>;
  };

  readonly toast?: ToastDescriptor | null;
  readonly onDismissToast?: () => void;

  readonly children: React.ReactNode;
}

export function ScreenShell(props: ScreenShellProps): React.ReactElement {
  const ctx = useMobileV2ThemeOrFallback();
  return (
    <FxFrame theme={ctx.theme}>
      {props.hideAppBar === true ? null : (
        <FxAppBar
          theme={ctx.theme}
          title={props.title}
          sub={props.sub}
          onBack={props.onBack}
          onMenu={props.onMenu}
          right={props.right}
          accent={props.accent}
          titleIcon={props.titleIcon}
          titleEmoji={props.titleEmoji}
          titleDropdown={props.titleDropdown}
          onTitlePress={props.onTitlePress}
        />
      )}
      <SyncBanner
        theme={ctx.theme}
        online={props.online ?? true}
        syncing={props.syncing ?? false}
        queueCount={props.queueCount ?? 0}
        onPress={props.onSyncPress}
      />
      <View style={{ flex: 1, backgroundColor: ctx.theme.bg }}>{props.children}</View>
      {props.tabs !== undefined ? (
        <BottomTabs
          theme={ctx.theme}
          visibleSections={props.tabs.visibleSections}
          activeRole={props.tabs.activeRole}
          activeItemId={props.tabs.activeItemId}
          onPressTab={props.tabs.onPressTab}
          maxTabs={props.tabs.maxTabs}
          badges={props.tabs.badges}
        />
      ) : null}
      {props.toast !== undefined && props.onDismissToast !== undefined ? (
        <ToastHost
          theme={ctx.theme}
          toast={props.toast}
          onDismiss={props.onDismissToast}
        />
      ) : null}
    </FxFrame>
  );
}

// ---------------------------------------------------------------------------
// Internal — returns provider context value or a safe fallback (hivis theme).
// Allows the shell to render outside a provider in early demo / preview
// surfaces without throwing.
// ---------------------------------------------------------------------------

function useMobileV2ThemeOrFallback() {
  // Lazy-import the optional hook to avoid circular import surface.
  // Provider returns frozen tokens; outside provider we synthesize a safe
  // value so the shell never crashes during boot.
  try {
    return useMobileV2Theme();
  } catch {
    // We import the same module that the hook lives in; fall back to the
    // hivis theme via direct require so that outside-provider usage remains
    // safe (e.g. early splash screen before the provider mounts).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const themesModule = require("./mobile-v2-themes") as typeof import("./mobile-v2-themes");
    const prefsModule = require("./mobile-v2-display-prefs") as typeof import("./mobile-v2-display-prefs");
    return {
      isHydrated: false,
      themeKey: themesModule.MOBILE_V2_DEFAULT_THEME,
      theme: themesModule.MOBILE_V2_THEMES[themesModule.MOBILE_V2_DEFAULT_THEME],
      prefs: prefsModule.MOBILE_V2_DEFAULT_DISPLAY_PREFS,
      locale: prefsModule.MOBILE_V2_DEFAULT_DISPLAY_PREFS.locale,
      direction: prefsModule.MOBILE_V2_DEFAULT_DISPLAY_PREFS.direction,
      density: prefsModule.MOBILE_V2_DEFAULT_DISPLAY_PREFS.density,
      setTheme: () => {
        // no-op outside provider
      },
      setLocale: () => {
        // no-op outside provider
      },
      setDensity: () => {
        // no-op outside provider
      },
      reload: async () => {
        // no-op outside provider
      },
    };
  }
}

// Avoid unused-import warning for LayoutChangeEvent in some downstream uses.
export type FxFrameLayoutEvent = LayoutChangeEvent;
export const FX_PLATFORM = Platform.OS;
