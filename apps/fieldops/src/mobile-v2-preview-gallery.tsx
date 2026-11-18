// Mobile V2 Preview Gallery — audit-time route that demos every screen
// outside the main shell. Reachable in dev via
// `?v2=preview&gallery=1[&screen=<id>][&sheet=<id>]` so the full design
// canvas (auth/onboarding/loader/network + inline sheets) can be
// reviewed side-by-side with the demo HTML without touching the live
// driver shell. Never rendered in production builds.
//
// Each screen is wrapped in a thin stateful container so the demo is
// interactive (toggles, inputs, captures). All seed values come from
// `./fixtures/` — production cutover deletes that directory and the
// gallery resolves data via RPC the same way as PreviewBody.

import * as React from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Side-effect import — registers the Geist / Geist Mono web fonts so the
// gallery renders typography identically to the design SSOT canvas.
import "./mobile-v2-web-fonts";
import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import { createFieldOpsStorage } from "./mobile-storage";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_THEMES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
  type MobileV2ThemeKey,
} from "./mobile-v2-themes";
import { MobileV2ThemeProvider, useMobileV2Theme } from "./mobile-v2-theme-context";
import {
  MobileV2RpcProvider,
  buildMobileV2QueryClientOptions,
  useFieldopsPassPreShiftGateMutation,
  useFieldopsRecordCleaningCheckMutation,
  useFieldopsSubmitKycDocMutation,
  useFieldopsSubmitKycVehicleMutation,
  type MobileV2Role,
} from "./mobile-v2-rpc-hooks";

import { MobileV2LoginScreen, type MobileV2LoginStep } from "./mobile-v2-login-screen";
import {
  MobileV2SignupScreen,
  type MobileV2SignupStep,
} from "./mobile-v2-signup-screen";
import { MobileV2RoleSelectScreen } from "./mobile-v2-role-select-screen";
import { MobileV2PreShiftChecklistScreen } from "./mobile-v2-pre-shift-checklist-screen";
import { MobileV2KycDocsScreen } from "./mobile-v2-kyc-docs-screen";
import { MobileV2KycVehicleScreen } from "./mobile-v2-kyc-vehicle-screen";
import {
  MobileV2KycVehiclePhotosScreen,
  type MobileV2VehicleAngleId,
} from "./mobile-v2-kyc-vehicle-photos-screen";
import { MobileV2CleaningScreen } from "./mobile-v2-cleaning-screen";
import { MobileV2PreShiftGateScreen } from "./mobile-v2-pre-shift-gate-screen";
import { MobileV2LoaderTodayScreen } from "./mobile-v2-loader-today-screen";
import { MobileV2LoaderManifestScreen } from "./mobile-v2-loader-manifest-screen";
import { MobileV2BayBoardScreen } from "./mobile-v2-bay-board-screen";
import { MobileV2InboundDockScreen } from "./mobile-v2-inbound-dock-screen";
import { MobileV2BayDetailScreen } from "./mobile-v2-bay-detail-screen";
import { MobileV2ManifestDetailScreen } from "./mobile-v2-manifest-detail-screen";

import { MobileV2SyncQueueScreen } from "./mobile-v2-sync-queue-screen";
import { MobileV2CodLedgerScreen } from "./mobile-v2-cod-ledger-screen";
import { MobileV2RouteScreen } from "./mobile-v2-route-screen";
import { MobileV2MapScreen } from "./mobile-v2-map-screen";
import { MobileV2TasksScreen } from "./mobile-v2-tasks-screen";
import { MOBILE_V2_PREVIEW_TASKS } from "./fixtures/mobile-v2-tasks-fixtures";
import { MobileV2PodScreen } from "./mobile-v2-pod-screen";
import { MOBILE_V2_POD_DEFAULT_POLICY } from "./mobile-v2-pod-policy";
import { MobileV2StopScreen } from "./mobile-v2-stop-screen";
import { MOBILE_V2_PREVIEW_STOP } from "./fixtures/mobile-v2-stop-fixtures";
import {
  MobileV2PickupsScreen,
  type MobileV2PickupsTab,
} from "./mobile-v2-pickups-screen";
import { MOBILE_V2_PREVIEW_PICKUPS } from "./fixtures/mobile-v2-pickups-fixtures";
import { MobileV2PickupDetailScreen } from "./mobile-v2-pickup-detail-screen";
import {
  MobileV2TripsScreen,
  type MobileV2TripsTab,
} from "./mobile-v2-trips-screen";
import { MOBILE_V2_PREVIEW_TRIPS } from "./fixtures/mobile-v2-trips-fixtures";
import { MobileV2MoreScreen } from "./mobile-v2-more-screen";
import {
  MOBILE_V2_PREVIEW_MORE_OUTBOX,
  MOBILE_V2_PREVIEW_USER,
} from "./fixtures/mobile-v2-more-fixtures";
import { MobileV2WalletScreen } from "./mobile-v2-wallet-screen";
import { MOBILE_V2_PREVIEW_WALLET } from "./fixtures/mobile-v2-wallet-fixtures";
import {
  MobileV2InboxScreen,
  type MobileV2InboxTab,
} from "./mobile-v2-inbox-screen";
import { MobileV2PhoneFrame } from "./mobile-v2-phone-frame";
import { FxAppBar, ScreenShell } from "./mobile-v2-shell";
import { MobileV2SettingsScreen } from "./mobile-v2-settings-screen";
import { MobileV2RiderTodayScreen } from "./mobile-v2-rider-today-screen";
import { MobileV2SupervisorScreen } from "./mobile-v2-supervisor-screen";
import { MobileV2ProfileScreen } from "./mobile-v2-profile-screen";

import { MobileV2BreakSheet } from "./mobile-v2-sheet-break";
import { MobileV2IncidentSheet } from "./mobile-v2-sheet-incident";
import {
  MobileV2SwitchLangSheet,
  type MobileV2LangOption,
} from "./mobile-v2-sheet-switch-lang";
import { MobileV2SupportSheet } from "./mobile-v2-sheet-support";
import { MobileV2ReassignSheet } from "./mobile-v2-sheet-reassign";
import { MobileV2RescheduleSheet } from "./mobile-v2-sheet-reschedule";
import { MobileV2ReceiveSheet } from "./mobile-v2-sheet-receive";
import { MobileV2TransferSheet } from "./mobile-v2-sheet-transfer";
import { MobileV2DamageHoldSheet } from "./mobile-v2-sheet-damage-hold";
import { MobileV2EODReconSheet, type MobileV2EODReconRow } from "./mobile-v2-sheet-eod-recon";
import {
  MobileV2PermissionsSheet,
  type MobileV2PermissionItem,
} from "./mobile-v2-sheet-permissions";
import {
  MobileV2NotifPrefsSheet,
  type MobileV2NotifChannel,
} from "./mobile-v2-sheet-notif-prefs";
import {
  MobileV2ReturnSheet,
  type MobileV2ReturnType,
} from "./mobile-v2-sheet-return";
import { MobileV2CashDropSheet } from "./mobile-v2-sheet-cash-drop";

// PREVIEW/DEV FIXTURES — same import-line gate as PreviewBody.
import {
  MOBILE_V2_PREVIEW_LOGIN,
  MOBILE_V2_PREVIEW_SIGNUP,
  MOBILE_V2_PREVIEW_ROLES_PICKER,
  MOBILE_V2_PREVIEW_CHECKLIST,
  MOBILE_V2_PREVIEW_KYC_DOCS,
  MOBILE_V2_PREVIEW_KYC_VEHICLE,
  MOBILE_V2_PREVIEW_KYC_VEHICLE_PHOTOS,
  MOBILE_V2_PREVIEW_CLEANING,
  MOBILE_V2_PREVIEW_PRE_SHIFT,
  MOBILE_V2_PREVIEW_INCIDENT_TYPES,
  MOBILE_V2_PREVIEW_DAMAGE_CATEGORIES,
  MOBILE_V2_PREVIEW_DAMAGE_PARCEL_ID,
  MOBILE_V2_PREVIEW_TRANSFER_HUBS,
  MOBILE_V2_PREVIEW_TRANSFER_PARCELS,
  MOBILE_V2_PREVIEW_TRANSFER_BAYS,
  MOBILE_V2_PREVIEW_SUPPORT_TOPICS,
  MOBILE_V2_PREVIEW_SUPPORT_CHAT_MESSAGES,
  MOBILE_V2_PREVIEW_SUPPORT_QUICK_REPLIES,
  MOBILE_V2_PREVIEW_REASSIGN_CANDIDATES,
  MOBILE_V2_PREVIEW_REASSIGN_CUSTOMER_NAME,
  MOBILE_V2_PREVIEW_RESCHEDULE_WINDOWS,
  MOBILE_V2_PREVIEW_RESCHEDULE_CUSTOMER_NAME,
  MOBILE_V2_PREVIEW_LOADER_TODAY,
  MOBILE_V2_PREVIEW_LOADER_MANIFEST,
  MOBILE_V2_PREVIEW_BAY_BOARD,
  MOBILE_V2_PREVIEW_INBOUND_DOCK,
  MOBILE_V2_PREVIEW_BAY_DETAIL,
  MOBILE_V2_PREVIEW_MANIFEST_DETAIL,
  MOBILE_V2_PREVIEW_SYNC_QUEUE,
  MOBILE_V2_PREVIEW_COD_LEDGER,
  MOBILE_V2_PREVIEW_ROUTE,
  MOBILE_V2_PREVIEW_INBOX,
  MOBILE_V2_PREVIEW_SETTINGS,
  MOBILE_V2_PREVIEW_RIDER_TODAY,
  MOBILE_V2_PREVIEW_SUPERVISOR_QUEUE,
  MOBILE_V2_PREVIEW_PROFILE,
  MOBILE_V2_PREVIEW_NAV,
} from "./fixtures";

interface GalleryEntry {
  readonly id: string;
  readonly section: string;
  readonly label: string;
  /** Title rendered in the FxAppBar header. */
  readonly title: string;
  /** Optional subtitle rendered under the title (sectionHead size). */
  readonly sub?: string;
  /** When true, show the lead back chevron (non-root screens). */
  readonly back?: boolean;
  /** When true, show the lead hamburger menu (tab-root screens). */
  readonly menu?: boolean;
  /** When true, render the BottomTabs strip below the content. */
  readonly tabRoot?: boolean;
  /** Active tab id when tabRoot=true. */
  readonly activeTabId?: string;
  /** Role for the tab set (defaults to "driver"). */
  readonly role?: string;
  /** When true, render the entry without a ScreenShell wrapper —
   * the screen owns its own header chrome (e.g. login renders the
   * brand "M" logo at the top instead of an FxAppBar). */
  readonly bare?: boolean;
  /** Optional right-side AppBar icon name (e.g. "map" for the route
   * screen's map switcher per design ScrRoute right slot). */
  readonly rightIcon?: import("./mobile-v2-icon-specs").MobileV2IconName;
  /** Optional right-side AppBar count chip (e.g. "6/8" for the
   * manifest-detail progress indicator per design ScrManifestDetail
   * right slot). Rendered as a small FxChip when set, mutually
   * exclusive with rightIcon (icon takes precedence if both set). */
  readonly rightChip?: string;
  /** Optional tone for `rightChip`. Defaults to `neutral` (mono-numeric
   * for progress chips). Use `success` for status chips like Rider Today's
   * "Online" indicator per design ScrRiderToday right slot. */
  readonly rightChipTone?: import("./mobile-v2-primitives-styles").FxChipTone;
  /** Optional icon to render inside `rightChip` (e.g. "check" for Online,
   * "bolt" for Active). */
  readonly rightChipIcon?: import("./mobile-v2-icon-specs").MobileV2IconName;
  /** Optional small icon-disk to the left of the title (e.g. "truck"
   * for the route screen's prefix tile per design ScrRoute). */
  readonly titleIcon?: import("./mobile-v2-icon-specs").MobileV2IconName;
  /** Optional inline emoji glyph before the title (no icon-disk box) —
   * design ScrTasks "⚡ Smart inbox" / ScrRoute "🛣 My route" (F10). */
  readonly titleEmoji?: string;
  /** When true, render a chevron-down caret after the title to signal
   * a context-switching dropdown (design ScrRoute "My route ▾"). */
  readonly titleDropdown?: boolean;
  readonly render: (theme: MobileV2Theme) => React.ReactElement;
}

// --- Stateful wrappers ----------------------------------------------------

function LoginDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_LOGIN;
  const [step, setStep] = React.useState<MobileV2LoginStep>(seed.step);
  const [employeeId, setEmployeeId] = React.useState(seed.employeeId);
  const [otp, setOtp] = React.useState(seed.otp);
  return (
    <MobileV2LoginScreen
      theme={theme}
      brandGlyph={seed.brandGlyph}
      step={step}
      employeeId={employeeId}
      otp={otp}
      otpMaskedPhone={seed.otpMaskedPhone}
      errorMessage={seed.errorMessage}
      autoFillHint={seed.autoFillHint}
      versionLabel={seed.versionLabel}
      onEmployeeIdChange={setEmployeeId}
      onOtpChange={(v) => setOtp(v.replace(/\D/g, "").slice(0, 6))}
      onSubmit={() => setStep(step === "emp" ? "otp" : "emp")}
      onResend={() => setOtp("")}
      onGoToSignup={() => {
        /* no-op in gallery */
      }}
    />
  );
}

function SignupDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_SIGNUP;
  const [step, setStep] = React.useState<MobileV2SignupStep>(seed.step);
  const [phone, setPhone] = React.useState(seed.phone);
  const [otp, setOtp] = React.useState(seed.otp);
  const [name, setName] = React.useState(seed.name);
  const [employeeId, setEmployeeId] = React.useState(seed.employeeId);
  const [roles, setRoles] = React.useState<ReadonlyArray<string>>(seed.selectedRoleIds);
  const advance = (): void => {
    if (step === "phone") setStep("otp");
    else if (step === "otp") setStep("profile");
    else setStep("phone");
  };
  return (
    <MobileV2SignupScreen
      theme={theme}
      step={step}
      phone={phone}
      otp={otp}
      name={name}
      employeeId={employeeId}
      selectedRoleIds={roles}
      roleOptions={seed.roleOptions}
      errorMessage={seed.errorMessage}
      autoFillHint={seed.autoFillHint}
      onPhoneChange={setPhone}
      onOtpChange={(v) => setOtp(v.replace(/\D/g, "").slice(0, 6))}
      onNameChange={setName}
      onEmployeeIdChange={(v) => setEmployeeId(v.toUpperCase())}
      onToggleRole={(id) =>
        setRoles((prev) =>
          prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        )
      }
      onBack={() => {
        if (step === "otp") setStep("phone");
        else if (step === "profile") setStep("otp");
      }}
      onSubmit={advance}
      onResend={() => setOtp("")}
    />
  );
}

function RoleSelectDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_ROLES_PICKER;
  const [selected, setSelected] = React.useState<string | null>(seed.selectedRoleId);
  const picked = seed.availableRoles.find((r) => r.id === selected);
  return (
    <MobileV2RoleSelectScreen
      theme={theme}
      availableRoles={seed.availableRoles}
      selectedRoleId={selected}
      startCtaLabel={picked?.title}
      employeeId={seed.employeeId}
      displayName={seed.displayName}
      onSelect={setSelected}
      onStart={() => {
        /* no-op in gallery */
      }}
    />
  );
}

function ChecklistDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const [checked, setChecked] = React.useState<ReadonlyArray<string>>([]);
  return (
    <MobileV2PreShiftChecklistScreen
      theme={theme}
      items={MOBILE_V2_PREVIEW_CHECKLIST}
      checkedIds={checked}
      onToggle={(id) =>
        setChecked((prev) =>
          prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        )
      }
      onConfirm={() => {
        /* no-op */
      }}
    />
  );
}

function KycDocsDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  // Wire the canonical KYC-doc mutation hook so the gallery audit can
  // observe the mutation lifecycle (envelope return in preview mode,
  // outbox enqueue in production). The hook's `mutate` is invoked with
  // the doc key + a stable preview storage path so DevTools surfaces
  // the request/response cycle even when ctx.supabase is null.
  const submit = useFieldopsSubmitKycDocMutation();
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const fireDocMutation = React.useCallback((docKey: string) => {
    setBusyKey(docKey);
    submit.mutate(
      {
        p_doc_key: docKey,
        p_storage_path: `kyc-docs/preview/${docKey}.jpg`,
      },
      {
        onSettled: () => setBusyKey((current) => (current === docKey ? null : current)),
      },
    );
  }, [submit]);
  return (
    <MobileV2KycDocsScreen
      theme={theme}
      docs={MOBILE_V2_PREVIEW_KYC_DOCS}
      busyKey={busyKey}
      onScan={fireDocMutation}
      onUpload={fireDocMutation}
      onContinue={() => {
        /* gallery preview — onContinue routes to next step in production */
      }}
    />
  );
}

function KycVehicleDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_KYC_VEHICLE;
  const [plate, setPlate] = React.useState(seed.plate);
  const [vin, setVin] = React.useState(seed.vin);
  const [year, setYear] = React.useState(seed.year);
  const [model, setModel] = React.useState(seed.model);
  // Wire the canonical KYC-vehicle mutation hook so the gallery audit
  // observes the registration submit lifecycle. In preview mode the
  // mutation returns a preview envelope; in production it goes through
  // callRpcOrEnqueue and lands on submit_fieldops_kyc_vehicle_v1.
  const submit = useFieldopsSubmitKycVehicleMutation();
  return (
    <MobileV2KycVehicleScreen
      theme={theme}
      istimaraStatus={seed.istimaraStatus}
      plate={plate}
      vin={vin}
      year={year}
      model={model}
      onScanIstimara={() => {
        /* preview-only — production routes to the device camera/OCR */
      }}
      onUploadIstimara={() => {
        /* preview-only — production routes to file picker + Storage upload */
      }}
      onPlateChange={setPlate}
      onVinChange={setVin}
      onYearChange={setYear}
      onModelChange={setModel}
      onSubmit={() => {
        submit.mutate({
          p_plate: plate,
          p_vin: vin,
          p_year: year,
          p_model: model,
          p_istimara_path: `kyc-vehicle/preview/${plate || "untitled"}.jpg`,
        });
      }}
    />
  );
}

function KycVehiclePhotosDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_KYC_VEHICLE_PHOTOS;
  const [captured, setCaptured] = React.useState<
    ReadonlyArray<MobileV2VehicleAngleId>
  >(seed.capturedAngleIds);
  return (
    <MobileV2KycVehiclePhotosScreen
      theme={theme}
      angles={seed.angles}
      capturedAngleIds={captured}
      onSnap={(id) =>
        setCaptured((prev) =>
          prev.includes(id) ? prev : [...prev, id],
        )
      }
      onSubmit={() => {
        /* no-op */
      }}
    />
  );
}

function CleaningDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_CLEANING;
  const [checked, setChecked] = React.useState<ReadonlyArray<string>>(seed.checkedIds);
  const [photo, setPhoto] = React.useState(seed.photoCaptured);
  // Wire the canonical cleaning-attestation mutation hook so the
  // gallery audit observes the daily attestation submit lifecycle.
  // In preview mode the mutation returns a preview envelope; in
  // production it routes through callRpcOrEnqueue and lands on
  // record_fieldops_cleaning_check_v1 with idempotency.
  const submit = useFieldopsRecordCleaningCheckMutation();
  return (
    <MobileV2CleaningScreen
      theme={theme}
      items={seed.items}
      checkedIds={checked}
      photoCaptured={photo}
      photoStamp={seed.photoStamp}
      onToggleItem={(id) =>
        setChecked((prev) =>
          prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        )
      }
      onCapturePhoto={() => setPhoto((p) => !p)}
      onSubmit={() => {
        submit.mutate({
          p_checked_ids: checked,
          p_photo_path: `cleaning/preview/${seed.photoStamp}.jpg`,
        });
      }}
    />
  );
}

function PreShiftGateDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_PRE_SHIFT;
  const [health, setHealth] = React.useState(seed.healthOk);
  // Wire the canonical pre-shift gate mutation hook so the gallery
  // audit observes the gate-pass submit lifecycle. Production routes
  // through callRpcOrEnqueue to pass_fieldops_pre_shift_gate_v1.
  const submit = useFieldopsPassPreShiftGateMutation();
  return (
    <MobileV2PreShiftGateScreen
      theme={theme}
      shiftId={seed.shiftId}
      stopCount={seed.stopCount}
      blockers={seed.blockers}
      cadence={seed.cadence}
      healthOk={health}
      onToggleHealth={setHealth}
      onOpenBlocker={() => {
        /* preview-only — production navigates to the matching blocker remediation */
      }}
      onStart={() => {
        submit.mutate({
          p_shift_id: seed.shiftId,
          p_health_ok: health,
        });
      }}
    />
  );
}

function LoaderTodayDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  return (
    <MobileV2LoaderTodayScreen
      theme={theme}
      waveLabel={MOBILE_V2_PREVIEW_LOADER_TODAY.waveLabel}
      cutOff={MOBILE_V2_PREVIEW_LOADER_TODAY.cutOff}
      coldChainCount={MOBILE_V2_PREVIEW_LOADER_TODAY.coldChainCount}
      liveRoutes={MOBILE_V2_PREVIEW_LOADER_TODAY.liveRoutes}
      totalParcels={MOBILE_V2_PREVIEW_LOADER_TODAY.totalParcels}
      scannedParcels={MOBILE_V2_PREVIEW_LOADER_TODAY.scannedParcels}
      driversWaiting={MOBILE_V2_PREVIEW_LOADER_TODAY.driversWaiting}
      quickActions={MOBILE_V2_PREVIEW_LOADER_TODAY.quickActions}
      drivers={MOBILE_V2_PREVIEW_LOADER_TODAY.drivers}
    />
  );
}

function LoaderManifestDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  return <MobileV2LoaderManifestScreen theme={theme} parcels={MOBILE_V2_PREVIEW_LOADER_MANIFEST} />;
}

function BayBoardDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  return <MobileV2BayBoardScreen theme={theme} bays={MOBILE_V2_PREVIEW_BAY_BOARD} />;
}

function InboundDockDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  return (
    <MobileV2InboundDockScreen
      theme={theme}
      dockLabel={MOBILE_V2_PREVIEW_INBOUND_DOCK.dockLabel}
      trucks={MOBILE_V2_PREVIEW_INBOUND_DOCK.trucks}
    />
  );
}

function BayDetailDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_BAY_DETAIL;
  return (
    <MobileV2BayDetailScreen
      theme={theme}
      bayId={seed.bayId}
      bayLabel={seed.bayLabel}
      routeId={seed.routeId}
      transfer={seed.transfer}
      exception={seed.exception}
      count={seed.count}
      capacity={seed.capacity}
      recent={seed.recent}
    />
  );
}

function ManifestDetailDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_MANIFEST_DETAIL;
  return (
    <MobileV2ManifestDetailScreen
      theme={theme}
      manifestId={seed.manifestId}
      originMerchant={seed.originMerchant}
      originCity={seed.originCity}
      waybillId={seed.waybillId}
      lines={seed.lines}
    />
  );
}

function SyncQueueDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_SYNC_QUEUE;
  const [connectivity, setConnectivity] = React.useState(seed.connectivity);
  const [lastSyncMs, setLastSyncMs] = React.useState<number | null>(seed.lastSyncMs);
  return (
    <MobileV2SyncQueueScreen
      theme={theme}
      queue={seed.queue}
      connectivity={connectivity}
      lastSyncMs={lastSyncMs}
      onToggleConnectivity={() =>
        setConnectivity((c) => (c === "online" ? "offline" : "online"))
      }
      onFlushNow={() => setLastSyncMs(Date.now())}
    />
  );
}

function CodLedgerDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_COD_LEDGER;
  return (
    <MobileV2CodLedgerScreen
      theme={theme}
      collected={seed.collected}
      expected={seed.expected}
      stops={seed.stops}
      currency={seed.currency}
      onHandOver={() => {
        /* no-op */
      }}
    />
  );
}

function StopDetailDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  return (
    <MobileV2StopScreen
      theme={theme}
      stop={MOBILE_V2_PREVIEW_STOP}
      onCall={() => {
        /* gallery preview — no-op */
      }}
      onWhatsApp={() => {
        /* gallery preview — no-op */
      }}
      onNavigate={() => {
        /* gallery preview — no-op */
      }}
      onScanParcel={() => {
        /* gallery preview — no-op */
      }}
    />
  );
}

function PickupsDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const [tab, setTab] = React.useState<MobileV2PickupsTab>("pending");
  return (
    <MobileV2PickupsScreen
      theme={theme}
      pickups={MOBILE_V2_PREVIEW_PICKUPS}
      query={query}
      onQueryChange={setQuery}
      tab={tab}
      onTabChange={setTab}
      onOpenPickup={() => {
        /* gallery preview — no-op */
      }}
      onOpenMap={() => {
        /* gallery preview — no-op; presence of handler surfaces the
           "Map view" filter chip to match the design canvas. */
      }}
    />
  );
}

function PickupDetailDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  const pickup = MOBILE_V2_PREVIEW_PICKUPS[0];
  if (pickup === undefined) {
    return <View />;
  }
  return (
    <MobileV2PickupDetailScreen
      theme={theme}
      pickup={pickup}
      onGo={() => {
        /* gallery preview — no-op */
      }}
      onCall={() => {
        /* gallery preview — no-op */
      }}
      onWhatsApp={() => {
        /* gallery preview — no-op */
      }}
      onScanParcel={() => {
        /* gallery preview — no-op */
      }}
      onAddManually={() => {
        /* gallery preview — no-op */
      }}
      onConfirm={() => {
        /* gallery preview — no-op */
      }}
      onFail={() => {
        /* gallery preview — no-op */
      }}
    />
  );
}

function TripsDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  const [tab, setTab] = React.useState<MobileV2TripsTab>("all");
  return (
    <MobileV2TripsScreen
      theme={theme}
      trips={MOBILE_V2_PREVIEW_TRIPS}
      tab={tab}
      onTabChange={setTab}
      onOpenTrip={() => {
        /* gallery preview — no-op */
      }}
    />
  );
}

const MORE_DEMO_THEMES: ReadonlyArray<MobileV2ThemeKey> = Object.freeze(["light", "dark", "hivis"]);
const MORE_DEMO_ROLES: ReadonlyArray<string> = Object.freeze(["driver", "loader", "rider", "supervisor"]);
const MORE_DEMO_CAPS: ReadonlyArray<string> = Object.freeze(["scan", "pod", "route", "outbox"]);

function MoreDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  const [activeThemeKey, setActiveThemeKey] = React.useState<MobileV2ThemeKey>("hivis");
  const [activeRole, setActiveRole] = React.useState("driver");
  return (
    <MobileV2MoreScreen
      theme={theme}
      activeThemeKey={activeThemeKey}
      availableThemeKeys={MORE_DEMO_THEMES}
      onSelectTheme={setActiveThemeKey}
      activeRole={activeRole}
      availableRoles={MORE_DEMO_ROLES}
      onSelectRole={setActiveRole}
      capabilities={MORE_DEMO_CAPS}
      online
      outbox={MOBILE_V2_PREVIEW_MORE_OUTBOX}
      userName={MOBILE_V2_PREVIEW_USER.name}
      userBadge={MOBILE_V2_PREVIEW_USER.badge}
      onOpenIncident={() => undefined}
    />
  );
}

function WalletDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  return (
    <MobileV2WalletScreen
      theme={theme}
      wallet={MOBILE_V2_PREVIEW_WALLET.wallet}
      week={MOBILE_V2_PREVIEW_WALLET.week}
      breakdown={MOBILE_V2_PREVIEW_WALLET.breakdown}
      // Design-parity: the design `ScrWallet` artboard renders the ISO
      // code "SAR" plainly (`{w.balance} SAR`) rather than the `﷼` rial
      // sign used by the route / COD / today surfaces.
      currencyDisplay="code"
    />
  );
}

function PodDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  return (
    <MobileV2PodScreen
      theme={theme}
      policy={MOBILE_V2_POD_DEFAULT_POLICY}
      hasCod
      customerName="Khalid Al-Otaibi"
      customerPhone="+966 50 123 4567"
      codAmount={250}
      failSheetOpen={false}
      onCloseFailSheet={() => {
        /* gallery preview — no-op */
      }}
      onExit={() => {
        /* gallery preview — no-op */
      }}
      onCommit={() => {
        /* gallery preview — no-op */
      }}
      onSubmitFail={() => {
        /* gallery preview — no-op */
      }}
    />
  );
}

function TasksDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const [viewMode, setViewMode] = React.useState<
    "list" | "board" | "map"
  >("list");
  return (
    <MobileV2TasksScreen
      theme={theme}
      state={{ kind: "ready", tasks: MOBILE_V2_PREVIEW_TASKS }}
      query={query}
      onQueryChange={setQuery}
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      onTaskPress={() => {
        /* gallery preview — no-op */
      }}
    />
  );
}

function RouteDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_ROUTE;
  const [search, setSearch] = React.useState(seed.searchValue);
  return (
    <MobileV2RouteScreen
      theme={theme}
      activeView={seed.activeView}
      views={seed.views}
      rows={seed.rows}
      totalStops={seed.totalStops}
      searchValue={search}
      density={seed.density}
      sortLabel={seed.sortLabel}
      groupLabel={seed.groupLabel}
      filterCount={seed.filterCount}
      dirty={seed.dirty}
      currency={seed.currency}
      onSearchChange={setSearch}
      onOpenViews={() => {
        /* no-op */
      }}
      onOpenFilters={() => {
        /* no-op */
      }}
      onOpenGroup={() => {
        /* no-op */
      }}
      onOpenSort={() => {
        /* no-op */
      }}
      onToggleDensity={() => {
        /* no-op */
      }}
      onSaveView={() => {
        /* no-op */
      }}
      onOpenMap={() => {
        /* no-op */
      }}
      onOpenScan={() => {
        /* no-op */
      }}
      onSelectStop={() => {
        /* no-op */
      }}
      onClearFilters={() => {
        /* no-op */
      }}
    />
  );
}

function MapDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_ROUTE;
  const [follow, setFollow] = React.useState(true);
  const [traffic, setTraffic] = React.useState(true);
  return (
    <MobileV2MapScreen
      theme={theme}
      routeId={seed.mapRouteId}
      pendingCount={seed.mapPendingCount}
      distanceLeftKm={seed.mapDistanceLeftKm}
      alerts={seed.mapAlerts}
      upcoming={seed.mapUpcoming}
      active={seed.mapActive}
      followEnabled={follow}
      trafficEnabled={traffic}
      currency={seed.currency}
      // The active-stop COD chip renders `<amount> ﷼` via
      // `formatMobileV2CurrencyCompact` (SAR → U+FDFC) — the canonical
      // FieldOps Mobile V2 design symbol (`flow-route.jsx` renders
      // `{s.cod} ﷼`). No currency-word override; production cutover
      // keeps the symbol row-driven via `mobile_wallet_locale_policy`.
      onToggleFollow={() => setFollow((f) => !f)}
      onToggleTraffic={() => setTraffic((t) => !t)}
      onOptimize={() => {
        /* no-op */
      }}
      onOpenList={() => {
        /* no-op */
      }}
      onSelectStop={() => {
        /* no-op */
      }}
      onCallActive={() => {
        /* no-op */
      }}
      onMessageActive={() => {
        /* no-op */
      }}
      onOpenActive={() => {
        /* no-op */
      }}
    />
  );
}

function InboxDemo({ theme }: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_INBOX;
  const [tab, setTab] = React.useState<MobileV2InboxTab>(seed.activeTab);
  return (
    <MobileV2InboxScreen
      theme={theme}
      activeTab={tab}
      notifications={seed.notifications}
      chat={seed.chat}
      chatOnline={seed.chatOnline}
      chatQuickReplies={seed.chatQuickReplies}
      onSelectTab={setTab}
      onSelectNotification={() => {
        /* no-op */
      }}
      onSelectQuickReply={() => {
        /* no-op */
      }}
    />
  );
}

function SettingsDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_SETTINGS;
  return (
    <MobileV2SettingsScreen
      theme={theme}
      language={seed.language}
      notifications={seed.notifications}
      shift={seed.shift}
      account={seed.account}
    />
  );
}

function RiderTodayDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_RIDER_TODAY;
  return (
    <MobileV2RiderTodayScreen
      theme={theme}
      greetingName={seed.greetingName}
      employeeId={seed.employeeId}
      online={seed.online}
      earningsToday={seed.earningsToday}
      tripsCompleted={seed.tripsCompleted}
      rating={seed.rating}
      shiftDuration={seed.shiftDuration}
      active={seed.active}
      upcoming={seed.upcoming}
      currency={seed.currency}
    />
  );
}

function SupervisorDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_SUPERVISOR_QUEUE;
  const [activeId, setActiveId] = React.useState<string | null>(seed.activeId);
  // Design canvas sh-supervisor (sv-q artboard) is the two-column split
  // layout: left rail = approval list, right pane = detail card + CTAs.
  // forceLayout="split" so the gallery preview matches the design
  // canvas baseline used by the pixel-diff harness; the supervisor screen
  // supports both at runtime.
  return (
    <MobileV2SupervisorScreen
      theme={theme}
      supervisorName={seed.supervisorName}
      queue={seed.queue}
      activeId={activeId}
      forceLayout="split"
      onSelectItem={setActiveId}
      onApprove={() => {
        /* no-op */
      }}
      onClarify={() => {
        /* no-op */
      }}
      onReject={() => {
        /* no-op */
      }}
    />
  );
}

function ProfileDemo({
  theme,
}: { readonly theme: MobileV2Theme }): React.ReactElement {
  const seed = MOBILE_V2_PREVIEW_PROFILE;
  return (
    <MobileV2ProfileScreen
      theme={theme}
      role={seed.role}
      identity={seed.identity}
      stats={seed.stats}
      documents={seed.documents}
      appStatus={seed.appStatus}
      accountId={seed.accountId}
      appVersion={seed.appVersion}
      currency={seed.currency}
      onEditProfile={() => {
        /* no-op in gallery */
      }}
      onOpenAvatar={() => {
        /* no-op in gallery */
      }}
    />
  );
}

// --- Sheet demos ----------------------------------------------------------
// Inline action sheets are rendered as overlays on a host backdrop card so
// the audit can compare each sheet's visual contract against the design
// source without needing to navigate to a parent screen.

function BreakSheetDemo({
  theme,
  visible,
  onClose,
}: {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
}): React.ReactElement {
  const [started, setStarted] = React.useState<number | undefined>(undefined);
  const [now, setNow] = React.useState<number>(Date.now());
  React.useEffect(() => {
    if (!visible || started === undefined) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [visible, started]);
  return (
    <MobileV2BreakSheet
      theme={theme}
      visible={visible}
      onClose={onClose}
      durationMin={30}
      // Aligned to design canvas s-sheet-break artboard subtitle copy:
      // "30 min after 4h driving" (KSA labour policy snapshot).
      mandatoryAfterMin={240}
      ongoingStartedAt={started}
      nowMs={now}
      onStart={() => {
        setStarted(Date.now());
        setNow(Date.now());
      }}
      onEnd={() => setStarted(undefined)}
    />
  );
}

function IncidentSheetDemo({
  theme,
  visible,
  onClose,
}: {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
}): React.ReactElement {
  const [selected, setSelected] = React.useState<string | null>(null);
  const [photo, setPhoto] = React.useState(false);
  const [statement, setStatement] = React.useState("");
  return (
    <MobileV2IncidentSheet
      theme={theme}
      visible={visible}
      onClose={onClose}
      types={MOBILE_V2_PREVIEW_INCIDENT_TYPES}
      selectedTypeId={selected}
      photoCaptured={photo}
      statement={statement}
      onSelectType={setSelected}
      onTogglePhoto={() => setPhoto((p) => !p)}
      onStatementChange={setStatement}
      onSubmit={() => {
        setSelected(null);
        setPhoto(false);
        setStatement("");
        onClose();
      }}
    />
  );
}

// ---- 12 additional sheets (preview-only demo fixtures inline) ----

// Aligned to design SSOT `app-store.jsx` APP_CONFIG.locale.available (lines
// 197-202): canonical 3-language set is en-SA / ar-SA / ur-PK with English (SA)
// as default. Design canvas SheetSwitchLang (flow-extras.jsx:742-754) renders
// `l.label` as the primary native-script line and `l.id · DIR` as the mono
// caption, so we pin `nativeLabel` to the native script (English (SA) is the
// canonical label for en-SA) and the impl screen renders `l.id` in the caption.
const SAMPLE_LANGUAGES: ReadonlyArray<MobileV2LangOption> = Object.freeze([
  Object.freeze({ id: "en-SA", label: "English (SA)", nativeLabel: "English (SA)", dir: "ltr" as const }),
  Object.freeze({ id: "ar-SA", label: "Arabic", nativeLabel: "العربية", dir: "rtl" as const }),
  Object.freeze({ id: "ur-PK", label: "Urdu", nativeLabel: "اردو", dir: "rtl" as const }),
]);

function SwitchLangSheetDemo(p: SheetDemoChild): React.ReactElement {
  const [lang, setLang] = React.useState("en-SA");
  return (
    <MobileV2SwitchLangSheet
      theme={p.theme}
      visible={p.visible}
      onClose={p.onClose}
      currentLangId={lang}
      languages={SAMPLE_LANGUAGES}
      onSelect={setLang}
    />
  );
}

function SupportSheetDemo(p: SheetDemoChild): React.ReactElement {
  const [topic, setTopic] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState("");
  return (
    <MobileV2SupportSheet
      theme={p.theme}
      visible={p.visible}
      onClose={p.onClose}
      // Design-parity: render the post-handoff dispatch chat state. The
      // topic-picker contract remains wired so production cutover can
      // toggle `mode` via `mobile_support_topics_policy.entry_state`.
      mode="chat"
      chatMessages={MOBILE_V2_PREVIEW_SUPPORT_CHAT_MESSAGES}
      quickReplies={MOBILE_V2_PREVIEW_SUPPORT_QUICK_REPLIES}
      topics={MOBILE_V2_PREVIEW_SUPPORT_TOPICS}
      selectedTopicId={topic}
      message={message}
      onSelectTopic={setTopic}
      onMessageChange={setMessage}
      onSubmit={() => {
        setTopic(null);
        setMessage("");
        p.onClose();
      }}
      onCallSupport={() => {
        /* no-op */
      }}
    />
  );
}

function ReassignSheetDemo(p: SheetDemoChild): React.ReactElement {
  const [drv, setDrv] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  return (
    <MobileV2ReassignSheet
      theme={p.theme}
      visible={p.visible}
      onClose={p.onClose}
      stopRef="MX-2026-04421-021"
      // Design-parity: lead with customer name + action verb; reason
      // field is captured post-handoff by dispatch.
      subtitle={`${MOBILE_V2_PREVIEW_REASSIGN_CUSTOMER_NAME} · pick a nearby driver`}
      showReason={false}
      candidates={MOBILE_V2_PREVIEW_REASSIGN_CANDIDATES}
      selectedDriverId={drv}
      reasonText={reason}
      onSelectDriver={setDrv}
      onReasonChange={setReason}
      onConfirm={() => {
        setDrv(null);
        setReason("");
        p.onClose();
      }}
    />
  );
}

function RescheduleSheetDemo(p: SheetDemoChild): React.ReactElement {
  const [win, setWin] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  return (
    <MobileV2RescheduleSheet
      theme={p.theme}
      visible={p.visible}
      onClose={p.onClose}
      stopRef="MX-2026-04421-021"
      currentWindow="Today · 14:00–17:00"
      // Design-parity: subtitle is just the customer name; note field
      // is collapsed (post-confirm SMS template captures any nuance);
      // CTA is forced into the ready/primary state to match the design
      // canvas s-sheet-reschedule artboard's idealized affordance.
      subtitle={MOBILE_V2_PREVIEW_RESCHEDULE_CUSTOMER_NAME}
      showNote={false}
      compact
      forceReady
      suggestedWindows={MOBILE_V2_PREVIEW_RESCHEDULE_WINDOWS}
      selectedWindowId={win}
      noteText={note}
      onSelectWindow={setWin}
      onNoteChange={setNote}
      onConfirm={() => {
        setWin(null);
        setNote("");
        p.onClose();
      }}
    />
  );
}

function ReceiveSheetDemo(p: SheetDemoChild): React.ReactElement {
  // Aligned to the design canvas `sh-recv` artboard (flow-extras.jsx
  // SheetReceive): supplier `LH-RYD-NORTH-001`, 142-parcel manifest,
  // scan counter starts at 0, reconciliation chips 3 / 2 / 137.
  const expected = 142;
  const [supplier, setSupplier] = React.useState("LH-RYD-NORTH-001");
  const [scanned, setScanned] = React.useState(0);
  return (
    <MobileV2ReceiveSheet
      theme={p.theme}
      visible={p.visible}
      onClose={p.onClose}
      // Subtitle aligned with the design canvas `sh-recv` artboard
      // ("Line-haul · scan all parcels"). Demonstrates the caller-
      // controlled subtitle prop introduced for production-state
      // flexibility.
      subtitle="Line-haul · scan all parcels"
      supplier={supplier}
      onSupplierChange={setSupplier}
      expectedCount={expected}
      scannedCount={scanned}
      onScanParcel={() => setScanned((s) => Math.min(expected, s + 1))}
      onConfirm={p.onClose}
      missingCount={3}
      surplusCount={2}
      verifiedCount={137}
    />
  );
}

function TransferSheetDemo(p: SheetDemoChild): React.ReactElement {
  const [sel, setSel] = React.useState<ReadonlyArray<string>>([]);
  const [bay, setBay] = React.useState<string | null>(null);
  const [hub, setHub] = React.useState<string | null>(null);
  return (
    <MobileV2TransferSheet
      theme={p.theme}
      visible={p.visible}
      onClose={p.onClose}
      // Design-parity: render the inter-hub destination picker. Parcels
      // and target-bay props remain wired for the legacy inter-bay flow
      // (production cutover sets `mode` from
      // `mobile_loader_transfer_v1.flavor`).
      mode="inter-hub"
      hubDestinations={MOBILE_V2_PREVIEW_TRANSFER_HUBS}
      selectedHubId={hub}
      onSelectHub={setHub}
      bayLabel="Bay A"
      parcels={MOBILE_V2_PREVIEW_TRANSFER_PARCELS}
      selectedIds={sel}
      targetBays={MOBILE_V2_PREVIEW_TRANSFER_BAYS}
      targetBayId={bay}
      onToggleParcel={(id) =>
        setSel((prev) =>
          prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        )
      }
      onSelectBay={setBay}
      onConfirm={() => {
        setSel([]);
        setBay(null);
        setHub(null);
        p.onClose();
      }}
    />
  );
}

function DamageHoldSheetDemo(p: SheetDemoChild): React.ReactElement {
  // Design canvas SheetDamageHold (flow-extras.jsx:628 — `useState('')`)
  // starts with NO damage type selected: every severity chip renders in
  // the neutral state until the operator picks one.
  const [sev, setSev] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [photo, setPhoto] = React.useState(false);
  const [barcode, setBarcode] = React.useState("");
  return (
    <MobileV2DamageHoldSheet
      theme={p.theme}
      visible={p.visible}
      onClose={p.onClose}
      parcelId={MOBILE_V2_PREVIEW_DAMAGE_PARCEL_ID}
      // Design-parity: title is "Damage / hold" (with slash), subtitle
      // leads with action verbs not parcel ID, parcel barcode is the
      // primary identifier (scan input), note + route-hint suppressed,
      // photo card is empty-state with centered "Add photo".
      title="Damage / hold"
      subtitle="Quarantine parcel — needs photo + reason"
      showParcelScan
      parcelBarcode={barcode}
      onParcelBarcodeChange={setBarcode}
      onParcelScan={() => {
        /* no-op in preview */
      }}
      showNote={false}
      showRouteHint={false}
      photoCardLayout="card"
      severities={MOBILE_V2_PREVIEW_DAMAGE_CATEGORIES}
      selectedSeverityId={sev}
      note={note}
      photoCaptured={photo}
      onSelectSeverity={setSev}
      onNoteChange={setNote}
      onTogglePhoto={() => setPhoto((b) => !b)}
      onConfirm={() => {
        setSev(null);
        setNote("");
        setPhoto(false);
        setBarcode("");
        p.onClose();
      }}
    />
  );
}

// EOD reconciliation rows mirror design canvas flow-extras.jsx SheetEODRecon
// (Inbound 142/142 · Outbound 128/130 · Returns 7/7 · Damage 3/0 · Transfer
// 14/14). Sourced from `mobile_loader_eod_v1` in production; fixed here for
// audit parity.
const SAMPLE_EOD_RECON_ROWS: ReadonlyArray<MobileV2EODReconRow> = Object.freeze([
  Object.freeze({ id: "inbound", label: "Inbound received", count: 142, expected: 142, tone: "success" as const }),
  Object.freeze({ id: "outbound", label: "Outbound loaded", count: 128, expected: 130, tone: "warning" as const }),
  Object.freeze({ id: "returns", label: "Returns to shelf", count: 7, expected: 7, tone: "success" as const }),
  Object.freeze({ id: "damage", label: "Damage / hold", count: 3, expected: 0, tone: "danger" as const }),
  Object.freeze({ id: "transfer", label: "Inter-hub transfer", count: 14, expected: 14, tone: "success" as const }),
]);

function EODReconSheetDemo(p: SheetDemoChild): React.ReactElement {
  return (
    <MobileV2EODReconSheet
      theme={p.theme}
      visible={p.visible}
      onClose={p.onClose}
      rows={SAMPLE_EOD_RECON_ROWS}
      onConfirm={p.onClose}
    />
  );
}

// Aligned to design canvas SheetPermissions artboard: 5 items
// (Camera/Location-always/Notifications/Microphone/Storage) with
// descriptive subs and 4 Granted + 1 Tap-to-allow chip layout.
// Earlier set ("Precise location"/"Camera (POD photo)"/"Push
// notifications"/"Battery optimisation off" with Required/Optional
// subs) was an audit placeholder that diverged from design's
// permission vocabulary. Production cutover resolves the list via
// `mobile_permissions_policy`.
// Per-item icons mirror design canvas SheetPermissions
// (flow-extras.jsx:763-769): camera / pin / bell / mic / box. Earlier
// fixture omitted these and the impl fell back to status-based
// generic icons (check/shield). With the new `icon?` field on
// MobileV2PermissionItem the renderer picks the canonical per-item
// glyph when provided.
const SAMPLE_PERMS_INIT: ReadonlyArray<MobileV2PermissionItem> = Object.freeze([
  Object.freeze({ id: "camera", label: "Camera", description: "POD photos, parcel scan, ID match", status: "granted" as const, required: true, icon: "camera" as const }),
  Object.freeze({ id: "location", label: "Location · always", description: "Live tracking + geofence proof", status: "granted" as const, required: true, icon: "pin" as const }),
  Object.freeze({ id: "notif", label: "Notifications", description: "Route updates, SLA alerts", status: "granted" as const, required: true, icon: "bell" as const }),
  Object.freeze({ id: "microphone", label: "Microphone", description: "Push-to-talk dispatch (optional)", status: "pending" as const, required: false, icon: "mic" as const }),
  Object.freeze({ id: "storage", label: "Storage", description: "Offline cache for routes & POD", status: "granted" as const, required: true, icon: "box" as const }),
]);

function PermissionsSheetDemo(p: SheetDemoChild): React.ReactElement {
  const [items, setItems] = React.useState<ReadonlyArray<MobileV2PermissionItem>>(SAMPLE_PERMS_INIT);
  return (
    <MobileV2PermissionsSheet
      theme={p.theme}
      visible={p.visible}
      onClose={p.onClose}
      items={items}
      // Design canvas SheetPermissions artboard omits the "Denied
      // permissions can be re-enabled from the device Settings app."
      // helper row. Opt out here for design-parity capture; production
      // keeps the helper visible by default.
      helperEnabled={false}
      onRequest={(id) =>
        setItems((prev) =>
          prev.map((it) => (it.id === id ? { ...it, status: "granted" as const } : it)),
        )
      }
    />
  );
}

const SAMPLE_CHANNELS_INIT: ReadonlyArray<MobileV2NotifChannel> = Object.freeze([
  Object.freeze({ id: "sla", label: "SLA risk", description: "Stop window closing soon", enabled: true }),
  Object.freeze({ id: "route", label: "Route changes", description: "Dispatch reorders / hand-offs", enabled: true }),
  Object.freeze({ id: "wallet", label: "Wallet", description: "Payouts, holds, settlement", enabled: true }),
  Object.freeze({ id: "broadcast", label: "Hub broadcasts", description: "Operational notes from hub", enabled: false }),
]);

function NotifPrefsSheetDemo(p: SheetDemoChild): React.ReactElement {
  const [channels, setChannels] = React.useState<ReadonlyArray<MobileV2NotifChannel>>(SAMPLE_CHANNELS_INIT);
  return (
    <MobileV2NotifPrefsSheet
      theme={p.theme}
      visible={p.visible}
      onClose={p.onClose}
      channels={channels}
      onToggle={(id) =>
        setChannels((prev) =>
          prev.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)),
        )
      }
    />
  );
}

// Aligned to design canvas s-sheet-return artboard: four customer-return
// reasons mirroring SheetReturn ScrSheetReturn (wrong size/model, damaged
// on arrival, customer changed mind, duplicate / wrong order). The sheet
// contract requires a non-null icon name; design renders only the radio
// circle, so icons stay subdued via the unselected muted tone.
const SAMPLE_RETURN_TYPES: ReadonlyArray<MobileV2ReturnType> = Object.freeze([
  Object.freeze({ id: "wrong-size", label: "Wrong size / model", icon: "package" as const }),
  Object.freeze({ id: "damaged", label: "Damaged on arrival", icon: "alert" as const }),
  Object.freeze({ id: "changed-mind", label: "Customer changed mind", icon: "refresh" as const }),
  Object.freeze({ id: "duplicate", label: "Duplicate / wrong order", icon: "x" as const }),
]);

function ReturnSheetDemo(p: SheetDemoChild): React.ReactElement {
  const [type, setType] = React.useState<string | null>(null);
  const [photo, setPhoto] = React.useState(false);
  const [note, setNote] = React.useState("");
  return (
    <MobileV2ReturnSheet
      theme={p.theme}
      visible={p.visible}
      onClose={p.onClose}
      // orderRef omitted for design-parity: SheetReturn artboard shows the
      // subtitle "Pick up reverse parcel · back to shelf" without an order
      // prefix (the parent screen identifies the parcel via Stop detail).
      orderRef=""
      returnTypes={SAMPLE_RETURN_TYPES}
      selectedTypeId={type}
      photoCaptured={photo}
      note={note}
      // Design-parity flags: the canvas SheetReturn artboard omits per-row
      // reason icons and the optional dispatch-note textarea, so the audit
      // gallery preview opts out via these props. The canvas snapshot
      // shows the empty-form unready state (soft CTA, no reason selected,
      // no photo) so the preview no longer forces ready; the sheet
      // emits a constant "Accept return · seal & scan" label matching
      // the design source. Production cutover keeps all three surfaces
      // (icon hint + dispatch note + state-driven readiness).
      reasonIconEnabled={false}
      noteEnabled={false}
      onSelectType={setType}
      onTogglePhoto={() => setPhoto((b) => !b)}
      onNoteChange={setNote}
      onConfirm={() => {
        setType(null);
        setPhoto(false);
        setNote("");
        p.onClose();
      }}
    />
  );
}

function CashDropSheetDemo(p: SheetDemoChild): React.ReactElement {
  // Seeded to the design-canvas SheetCashDrop artboard state
  // (state.cod.collected = 0 → "Expected 0", numberpad at 0, not-ready)
  // so the design-vs-impl pixel-diff compares the same lifecycle point.
  const [counted, setCounted] = React.useState("0");
  const [photo, setPhoto] = React.useState(false);
  const [cashier, setCashier] = React.useState("");
  return (
    <MobileV2CashDropSheet
      theme={p.theme}
      visible={p.visible}
      onClose={p.onClose}
      expectedSar={0}
      countedValue={counted}
      onCountedChange={setCounted}
      requirePhoto
      requireCounterSig
      photoCaptured={photo}
      onCapturePhoto={() => setPhoto((b) => !b)}
      cashierId={cashier}
      onCashierIdChange={setCashier}
      onSubmit={p.onClose}
    />
  );
}

interface SheetDemoChild {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
}

// --- Gallery registry -----------------------------------------------------

// Bottom-tab badge counts per role — gallery-only audit defaults that
// mirror the FieldOps V2.html design canvas demo. Values are derived
// from the design store snapshot (app-store.jsx) using the same
// filters as design BottomTabs (app-shell.jsx:124-150):
//   driver.tasks   = stops pending+sla (8) + pickups pending (3) = 11
//   driver.route   = stops pending+sla = 8
//   driver.pickups = pickups pending = 3
//   driver.trips   = no badge (omitted)
//   loader.tasks   = hold items (3) + trips in-transit|arrived (2) = 5
//   rider.tasks    = stops pending+sla = 8
//   supervisor.tasks = supervisorQueue (4) + hubPickup.queue (3) + hold (3) = 10
//   supervisor.supervisor-today = supervisorQueue = 4
//   supervisor.hub-pickup = hubPickup.queue = 3
// Production resolves these from resolve_fieldops_*_v1 counters via
// the host shell.
const BADGE_COUNTS_BY_ROLE: Readonly<Record<string, Readonly<Record<string, number>>>> =
  Object.freeze({
    driver: Object.freeze({
      "mobile-tasks": 11,
      "mobile-route": 8,
      "mobile-pickups": 3,
    }),
    loader: Object.freeze({
      "mobile-tasks": 5,
    }),
    rider: Object.freeze({
      "mobile-tasks": 8,
    }),
    supervisor: Object.freeze({
      "mobile-tasks": 10,
      "mobile-supervisor-today": 4,
      "mobile-hub-pickup": 3,
    }),
  });

const GALLERY_ENTRIES: ReadonlyArray<GalleryEntry> = Object.freeze([
  // Auth + onboarding flows — back chevron, no bottom tabs.
  { id: "login", section: "Auth", label: "Login", title: "Sign in", bare: true, render: (t) => <LoginDemo theme={t} /> },
  { id: "signup", section: "Auth", label: "Signup", title: "Create account", sub: "Step 1 of 3 · Phone", back: true, render: (t) => <SignupDemo theme={t} /> },
  // Title mirrors design SSOT ScrRoleSelect (flow-auth.jsx:166) which
  // pluralises based on `roles.length>1`. With both driver+loader roles
  // available in design's app-store auth seed, the canvas renders
  // "Pick your roles" — not the parenthetical "(s)" placeholder.
  // `bare` — design ScrRoleSelect renders its own in-body 22px header +
  // subtitle, so the screen owns its chrome (no ScreenShell app bar).
  { id: "role-select", section: "Auth", label: "Role select", title: "Pick your roles", sub: "Select one to start. Switch any time from the side menu.", bare: true, render: (t) => <RoleSelectDemo theme={t} /> },
  // Sub matches design canvas s-checklist artboard: "2-min vehicle + safety check".
  { id: "checklist", section: "Onboarding", label: "Pre-shift checklist", title: "Pre-shift checklist", sub: "2-min vehicle + safety check", back: true, render: (t) => <ChecklistDemo theme={t} /> },
  { id: "kyc-docs", section: "Onboarding", label: "KYC · docs", title: "Identity & documents", sub: "Step 1 of 4 · KYC", back: true, render: (t) => <KycDocsDemo theme={t} /> },
  { id: "kyc-vehicle", section: "Onboarding", label: "KYC · vehicle", title: "Vehicle registration", sub: "Step 2 of 4 · Istimara", back: true, render: (t) => <KycVehicleDemo theme={t} /> },
  { id: "kyc-vehicle-photos", section: "Onboarding", label: "KYC · vehicle photos", title: "Vehicle photos", sub: "Step 3 of 4 · 4 angles", back: true, render: (t) => <KycVehiclePhotosDemo theme={t} /> },
  { id: "cleaning", section: "Onboarding", label: "Cleaning attestation", title: "Vehicle cleaning", sub: "Step 4 of 4 · Daily attestation", back: true, render: (t) => <CleaningDemo theme={t} /> },
  // Sub matches design canvas s-pre-shift-gate artboard: "Shift <id> · <n> stops".
  { id: "pre-shift-gate", section: "Onboarding", label: "Pre-shift gate", title: "Before you start", sub: `Shift ${MOBILE_V2_PREVIEW_PRE_SHIFT.shiftId} · ${MOBILE_V2_PREVIEW_PRE_SHIFT.stopCount} stops`, back: true, render: (t) => <PreShiftGateDemo theme={t} /> },
  // Driver tab-roots — hamburger menu + bottom tabs.
  // Design ScrTasks (flow-tasks.jsx:484-497): the app-bar title renders
  // the ACTIVE task-view (default `tv-smart` → "Smart inbox", emoji ⚡
  // → `bolt` icon) with a chevron-down that opens the views sheet; the
  // subtitle reads "<rows> of <tasks> for <role> · <sort>" and a `scan`
  // icon sits top-right.
  { id: "tasks", section: "Driver", label: "Tasks", title: "Smart inbox", sub: "11 of 11 for Driver · smart", menu: true, tabRoot: true, activeTabId: "mobile-tasks", role: "driver", titleEmoji: "⚡", titleDropdown: true, rightIcon: "scan", render: (t) => <TasksDemo theme={t} /> },
  { id: "route", section: "Driver", label: "Route", title: "My route", sub: "12 of 12 · route sequence", menu: true, tabRoot: true, activeTabId: "mobile-route", role: "driver", rightIcon: "map", titleEmoji: "🛣", titleDropdown: true, render: (t) => <RouteDemo theme={t} /> },
  // POD is a multi-step wizard (design flow-pod.jsx ScrPOD): it owns its
  // own app-bar because the title changes per step ("Scan parcel barcode"
  // → "Parcel photo" → …). `bare` so the gallery does not double-wrap a
  // static FxAppBar over the wizard's own dynamic header.
  { id: "pod", section: "Driver", label: "POD composer", title: "Proof of delivery", sub: "Method · Scan · Photo · Signature", back: true, bare: true, render: (t) => <PodDemo theme={t} /> },
  { id: "stop-detail", section: "Driver", label: "Stop detail", title: "Stop 3 of 12", sub: "SLA 11:30 · arriving now", back: true, rightIcon: "map", render: (t) => <StopDetailDemo theme={t} /> },
  { id: "pickups", section: "Driver", label: "Pickups", title: "Pickups", sub: "3 pending · 3/47 parcels", menu: true, tabRoot: true, activeTabId: "mobile-pickups", role: "driver", rightChip: "First-mile", rightChipTone: "info", rightChipIcon: "package", render: (t) => <PickupsDemo theme={t} /> },
  { id: "pickup-detail", section: "Driver", label: "Pickup detail", title: "Layla Boutique", sub: "PCK-7741 · 10:00–12:00", back: true, rightChip: "8 parcels", rightChipTone: "warning", rightChipIcon: "package", render: (t) => <PickupDetailDemo theme={t} /> },
  { id: "trips", section: "Driver", label: "Trips", title: "Trips", sub: "Line-haul · inter-hub", menu: true, tabRoot: true, activeTabId: "mobile-trips", role: "driver", rightChip: "Line-haul", rightChipTone: "info", rightChipIcon: "truck", render: (t) => <TripsDemo theme={t} /> },
  { id: "map", section: "Driver", label: "Map", title: "Live route", sub: "RT-2026-0502-A · 7 pending · 38.4 km left", menu: true, tabRoot: true, activeTabId: "mobile-trip-nav", role: "driver", rightIcon: "list", render: (t) => <MapDemo theme={t} /> },
  { id: "cod-ledger", section: "Driver", label: "COD ledger", title: "COD ledger", sub: "7 cash stops · 4,300 ﷼ expected", back: true, tabRoot: true, activeTabId: "mobile-cash-drop", role: "driver", render: (t) => <CodLedgerDemo theme={t} /> },
  { id: "wallet", section: "Driver", label: "Wallet", title: "Wallet", sub: "Pay & earnings", back: true, rightChip: "184 SAR", rightChipTone: "success", rightChipIcon: "cash", render: (t) => <WalletDemo theme={t} /> },
  // Loader tab-roots.
  { id: "loader-today", section: "Loader", label: "Loader today", title: "Hello, Omar", sub: "Bay B · Wave 3 · 06:40", menu: true, tabRoot: true, activeTabId: "mobile-loader-today", role: "loader", rightChip: "Loader", rightChipTone: "info", rightChipIcon: "package", render: (t) => <LoaderTodayDemo theme={t} /> },
  // Aligned to design canvas s-loader-manifest artboard: header title
  // is "Manifest · Wave 3" (manifest identity inline), sub is "9
  // parcels · 3 routes" (parcel + route counts). Earlier "Manifest"
  // title + "Wave 3 · 9 parcels" sub diverged from design's identity
  // composition + dropped the route-count signal entirely.
  { id: "loader-manifest", section: "Loader", label: "Loader manifest", title: "Manifest · Wave 3", sub: "9 parcels · 3 routes", menu: true, tabRoot: true, activeTabId: "mobile-sortation", role: "loader", render: (t) => <LoaderManifestDemo theme={t} /> },
  // Bay board sub copy mirrors design SSOT ScrBayBoard (flow-loader.jsx:399):
  // `sub="Riyadh hub · 5 docks"`. Production cutover resolves this from
  // the active loader's hub identity + bay/dock count.
  { id: "bay-board", section: "Loader", label: "Bay board", title: "Bay board", sub: "Riyadh hub · 5 docks", menu: true, tabRoot: true, activeTabId: "mobile-loader-scan", role: "loader", render: (t) => <BayBoardDemo theme={t} /> },
  // Network — detail screens, back chevron.
  { id: "inbound-dock", section: "Network", label: "Inbound dock", title: "Inbound dock", sub: "2 trucks expected", back: true, rightChip: "Receiving", rightChipTone: "info", rightChipIcon: "truck", render: (t) => <InboundDockDemo theme={t} /> },
  // Header values mirror design SSOT ScrBayDetail (flow-network-extras.jsx:158)
  // with design app-store sortation seed for Bay A (`label:'Olaya · North',
  // routeId:'RT-2026-0502-A', count:42, capacity:80` → pct=53%, tone=success
  // since pct<90). Fixture mobile-v2-bay-detail-fixtures.ts already encodes
  // these same values for the screen body.
  { id: "bay-detail", section: "Network", label: "Bay detail", title: "Bay A · Olaya · North", sub: "RT-2026-0502-A", back: true, rightChip: "53%", rightChipTone: "success", render: (t) => <BayDetailDemo theme={t} /> },
  { id: "manifest-detail", section: "Network", label: "Manifest detail", title: "WB-RYD-7740", sub: "Manifest · 8 parcels", back: true, rightChip: "6/8", render: (t) => <ManifestDetailDemo theme={t} /> },
  // Rider tab-root.
  { id: "rider-today", section: "Rider", label: "Rider today", title: "Hello, Omar", sub: "Bike · DRV-2041 · Online", menu: true, tabRoot: true, activeTabId: "mobile-rider-today", role: "rider", rightChip: "Online", rightChipTone: "success", rightChipIcon: "check", render: (t) => <RiderTodayDemo theme={t} /> },
  // Supervisor tab-root.
  // Aligned to design canvas ScrSupervisor artboard: "4 pending ·
  // Omar Al-Saadi" subtitle + "4" warning badge (matches the 4 queue
  // items already seeded in the supervisor fixture). Earlier copy
  // ("5 pending · Mansour Al-Khaldi") drifted from the design's
  // count + supervisor identity.
  { id: "supervisor", section: "Supervisor", label: "Supervisor queue", title: "Approvals", sub: "4 pending · Omar Al-Saadi", menu: true, tabRoot: true, activeTabId: "mobile-hold", role: "supervisor", rightChip: "4", rightChipTone: "warning", rightChipIcon: "alert", render: (t) => <SupervisorDemo theme={t} /> },
  // System screens — back chevron, no bottom tabs.
  // Design SSOT ScrInbox (flow-extras.jsx:806) renders sub as
  // `{state.inbox.filter(n=>!n.read).length} unread` — count-driven.
  // Fixture seeds 2 unread notifications (n-1 route, n-2 sla).
  { id: "inbox", section: "System", label: "Inbox", title: "Inbox", sub: "2 unread", back: true, render: (t) => <InboxDemo theme={t} /> },
  { id: "sync-queue", section: "System", label: "Sync queue", title: "Sync queue", sub: "Pending writes · outbox", back: true, render: (t) => <SyncQueueDemo theme={t} /> },
  { id: "more", section: "System", label: "More", title: "More", sub: "Theme · roles · support tools · sign out", back: true, render: (t) => <MoreDemo theme={t} /> },
  // Sub omitted to match design canvas s-settings artboard (no AppBar sub).
  { id: "settings", section: "System", label: "Settings", title: "Settings", back: true, render: (t) => <SettingsDemo theme={t} /> },
  { id: "profile", section: "System", label: "Profile", title: "Me", sub: "DRV-2041 · Driver · RYD-4421", back: true, rightIcon: "settings", render: (t) => <ProfileDemo theme={t} /> },
]);

const SHEET_IDS = Object.freeze([
  "break",
  "incident",
  "switch-lang",
  "support",
  "reassign",
  "reschedule",
  "receive",
  "transfer",
  "damage-hold",
  "eod-recon",
  "permissions",
  "notif-prefs",
  "return",
  "cash-drop",
] as const);
type SheetId = (typeof SHEET_IDS)[number];

interface SheetMeta {
  readonly id: SheetId;
  readonly label: string;
  readonly icon: "clock" | "alert" | "globe" | "info" | "user" | "calendar" | "package" | "truck" | "flag" | "cash" | "shield" | "scan" | "navigate";
  readonly tone: "info" | "danger" | "warning" | "neutral" | "success" | "accent";
}

const SHEET_META: ReadonlyArray<SheetMeta> = Object.freeze([
  { id: "break", label: "Break", icon: "clock", tone: "info" },
  { id: "incident", label: "Incident", icon: "alert", tone: "danger" },
  { id: "switch-lang", label: "Language", icon: "globe", tone: "info" },
  { id: "support", label: "Support", icon: "info", tone: "info" },
  { id: "reassign", label: "Reassign", icon: "user", tone: "warning" },
  { id: "reschedule", label: "Reschedule", icon: "calendar", tone: "info" },
  { id: "receive", label: "Receive", icon: "package", tone: "success" },
  { id: "transfer", label: "Transfer", icon: "truck", tone: "info" },
  { id: "damage-hold", label: "Damage hold", icon: "flag", tone: "warning" },
  { id: "eod-recon", label: "EOD recon", icon: "cash", tone: "info" },
  { id: "permissions", label: "Permissions", icon: "shield", tone: "neutral" },
  { id: "notif-prefs", label: "Notif prefs", icon: "info", tone: "neutral" },
  { id: "return", label: "Return", icon: "package", tone: "warning" },
  { id: "cash-drop", label: "Cash drop", icon: "cash", tone: "accent" },
]);

function readQueryParam(name: string): string | null {
  if (Platform.OS !== "web") return null;
  if (typeof window === "undefined" || typeof window.location === "undefined") return null;
  try {
    return new URL(window.location.href).searchParams.get(name);
  } catch {
    return null;
  }
}

function writeQueryParam(name: string, value: string | null): void {
  if (Platform.OS !== "web") return;
  if (typeof window === "undefined" || typeof window.location === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (value === null) url.searchParams.delete(name);
    else url.searchParams.set(name, value);
    window.history.replaceState(null, "", url.toString());
  } catch {
    /* ignore */
  }
}

function GalleryBody(): React.ReactElement {
  const ctx = useMobileV2Theme();
  const [screenId, setScreenId] = React.useState<string>(
    () => readQueryParam("screen") ?? GALLERY_ENTRIES[0]!.id,
  );
  const [sheetId, setSheetId] = React.useState<SheetId | null>(() => {
    const raw = readQueryParam("sheet");
    return raw !== null && (SHEET_IDS as ReadonlyArray<string>).includes(raw)
      ? (raw as SheetId)
      : null;
  });
  const entry = GALLERY_ENTRIES.find((g) => g.id === screenId) ?? GALLERY_ENTRIES[0]!;
  const theme = ctx.theme;

  const selectScreen = (id: string): void => {
    setScreenId(id);
    writeQueryParam("screen", id);
  };
  const openSheet = (id: SheetId): void => {
    setSheetId(id);
    writeQueryParam("sheet", id);
  };
  const closeSheet = (): void => {
    setSheetId(null);
    writeQueryParam("sheet", null);
  };

  // Group entries by section for the picker.
  const sections: ReadonlyArray<{ section: string; items: ReadonlyArray<GalleryEntry> }> =
    React.useMemo(() => {
      const order = [
        "Auth",
        "Onboarding",
        "Driver",
        "Loader",
        "Network",
        "Rider",
        "Supervisor",
        "System",
      ];
      return order.map((section) => ({
        section,
        items: GALLERY_ENTRIES.filter((g) => g.section === section),
      }));
    }, []);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, flexDirection: "row" }}>
      {/* Left rail — screen picker + theme + sheet triggers */}
      <View
        style={{
          width: 240,
          backgroundColor: theme.surfaceAlt,
          borderRightWidth: 1,
          borderColor: theme.border,
        }}
      >
        <ScrollView contentContainerStyle={{ padding: MOBILE_V2_SPACING.md, rowGap: MOBILE_V2_SPACING.md }}>
          <FxCol gap={6}>
            <Text
              style={{
                color: theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                fontSize: 13,
              }}
            >
              FieldOps V2 · Gallery
            </Text>
            <Text style={{ color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS, fontSize: 11 }}>
              Audit canvas · {GALLERY_ENTRIES.length} screens · {SHEET_IDS.length} sheets
            </Text>
          </FxCol>

          <FxCol gap={6}>
            <Text
              style={{
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                fontSize: 10,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              Theme
            </Text>
            <FxRow gap={6} wrap>
              {(Object.keys(MOBILE_V2_THEMES) as ReadonlyArray<MobileV2ThemeKey>).map((k) => (
                <Pressable
                  key={k}
                  onPress={() => ctx.setTheme(k)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: ctx.themeKey === k ? theme.accent : theme.surface,
                    borderWidth: 1,
                    borderColor: ctx.themeKey === k ? theme.accent : theme.border,
                  }}
                >
                  <Text
                    style={{
                      color: ctx.themeKey === k ? theme.surface : theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                      fontSize: 11,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    }}
                  >
                    {MOBILE_V2_THEMES[k].name}
                  </Text>
                </Pressable>
              ))}
            </FxRow>
          </FxCol>

          <FxCol gap={6}>
            <Text
              style={{
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                fontSize: 10,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              Sheets
            </Text>
            <FxRow gap={6} wrap>
              {SHEET_META.map((sm) => {
                const active = sheetId === sm.id;
                return (
                  <Pressable
                    key={sm.id}
                    onPress={() => openSheet(sm.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${sm.label} sheet`}
                  >
                    <FxChip
                      theme={theme}
                      icon={sm.icon}
                      tone={active ? sm.tone : "neutral"}
                      dense
                    >
                      {sm.label}
                    </FxChip>
                  </Pressable>
                );
              })}
            </FxRow>
          </FxCol>

          {sections.map((s) => (
            <FxCol key={s.section} gap={6}>
              <Text
                style={{
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  fontSize: 10,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                }}
              >
                {s.section}
              </Text>
              {s.items.map((it) => {
                const on = it.id === screenId;
                return (
                  <Pressable
                    key={it.id}
                    onPress={() => selectScreen(it.id)}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: on ? theme.accent : "transparent",
                    }}
                  >
                    <Text
                      style={{
                        color: on ? theme.surface : theme.ink,
                        fontFamily: MOBILE_V2_FONT_SANS,
                        fontSize: 12,
                        fontWeight: on ? MOBILE_V2_TYPE_WEIGHTS.semibold : MOBILE_V2_TYPE_WEIGHTS.regular,
                      }}
                    >
                      {it.label}
                    </Text>
                  </Pressable>
                );
              })}
            </FxCol>
          ))}
        </ScrollView>
      </View>

      {/* Right stage — phone frame. Sheet overlays render INSIDE the
          frame so the absolute-positioned bottom sheet docks to the
          device viewport (not the gallery canvas). The frame is
          position:relative implicitly + overflow:hidden so the sheet
          clips inside the rounded corners. */}
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <FxCard
          theme={theme}
          padding={0}
          testID="mobile-v2-pixel-frame"
          style={{
            // Match design canvas PHONE_W=380 / PHONE_H=780 (see
            // FieldOps V2.html `Root()` constants). The pixel-diff
            // capture harness screenshots this exact element by its
            // `mobile-v2-pixel-frame` test handle, so the impl capture
            // is a native 380×780 PNG — no full-page crop, no
            // crop-misalignment drift against the design artboard.
            width: 380,
            height: 780,
            overflow: "hidden",
            borderRadius: MOBILE_V2_RADII.card * 2,
            position: "relative",
          }}
        >
          <MobileV2PhoneFrame theme={theme}>
            {/* When a sheet is open, the design canvas renders a fixed
                faux underlying screen behind it (design SheetHost,
                flow-extras.jsx): a 16px-inset, 0.55-opacity "Stop
                detail · Sheet preview" app bar with no back chevron.
                Port it faithfully — same padding, opacity and plain
                app bar — so a bottom-sheet pixel-diff compares sheet
                to sheet and is not skewed by a backdrop mismatch. */}
            {sheetId !== null ? (
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  padding: MOBILE_V2_SPACING["4xl"],
                  opacity: 0.55,
                }}
                pointerEvents="none"
              >
                <FxAppBar theme={theme} title="Stop detail" sub="Sheet preview" />
                <Text
                  style={{
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    fontSize: 12,
                    paddingVertical: MOBILE_V2_SPACING["2xl"],
                  }}
                >
                  This is the screen the sheet is layered over.
                </Text>
              </View>
            ) : entry.bare === true ? (
              entry.render(theme)
            ) : (
              <ScreenShell
                title={entry.title}
                sub={entry.sub}
                onBack={entry.back === true ? () => { /* gallery no-op */ } : undefined}
                onMenu={entry.menu === true ? () => { /* gallery no-op */ } : undefined}
                titleIcon={entry.titleIcon}
                titleEmoji={entry.titleEmoji}
                titleDropdown={entry.titleDropdown}
                right={
                  entry.rightIcon !== undefined ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${entry.rightIcon} action`}
                      style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
                    >
                      <FxIcon name={entry.rightIcon} size={20} color={theme.ink} />
                    </Pressable>
                  ) : entry.rightChip !== undefined ? (
                    <FxChip
                      theme={theme}
                      tone={entry.rightChipTone ?? "neutral"}
                      icon={entry.rightChipIcon}
                      mono={entry.rightChipIcon === undefined && entry.rightChipTone === undefined}
                    >
                      {entry.rightChip}
                    </FxChip>
                  ) : undefined
                }
                tabs={
                  entry.tabRoot === true
                    ? {
                        visibleSections: MOBILE_V2_PREVIEW_NAV,
                        activeRole: entry.role ?? "driver",
                        activeItemId: entry.activeTabId,
                        onPressTab: () => { /* gallery no-op */ },
                        maxTabs: 5,
                        // Badge counts per design canvas: Driver shows
                        // Tasks (13) · Pickups (5) · Trips (3); Loader
                        // shows Sortation (6); Supervisor shows
                        // Approvals (12). Sourced from fixtures in
                        // production, hardcoded here for audit parity.
                        badges: BADGE_COUNTS_BY_ROLE[entry.role ?? "driver"],
                      }
                    : undefined
                }
              >
                {entry.render(theme)}
              </ScreenShell>
            )}
            {/* Sheets render INSIDE the PhoneFrame content area (not as a
                sibling of it) so the bottom-sheet docks above the
                home-indicator nav pill — matching the design FxSheet, which
                is inset:0 of the screen content, not the whole device. */}
            {sheetId === "break" ? (
              <BreakSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "incident" ? (
              <IncidentSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "switch-lang" ? (
              <SwitchLangSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "support" ? (
              <SupportSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "reassign" ? (
              <ReassignSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "reschedule" ? (
              <RescheduleSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "receive" ? (
              <ReceiveSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "transfer" ? (
              <TransferSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "damage-hold" ? (
              <DamageHoldSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "eod-recon" ? (
              <EODReconSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "permissions" ? (
              <PermissionsSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "notif-prefs" ? (
              <NotifPrefsSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "return" ? (
              <ReturnSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
            {sheetId === "cash-drop" ? (
              <CashDropSheetDemo theme={theme} visible={true} onClose={closeSheet} />
            ) : null}
          </MobileV2PhoneFrame>
        </FxCard>
        <View style={{ marginTop: 12 }}>
          <Text style={{ color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS, fontSize: 11 }}>
            {entry.section} · {entry.label}
          </Text>
        </View>
      </View>
    </View>
  );
}

/**
 * Inject the Geist + Geist Mono font CSS into the web shell so the audit
 * gallery renders with the same typography as the FieldOps V2.html design
 * canvas. The theme tokens (`MOBILE_V2_FONT_SANS` / `MOBILE_V2_FONT_MONO`)
 * already declare Geist first in the stack with system fallbacks, so this
 * hook is purely additive — it only takes effect on web and is a no-op on
 * native (where Geist would be loaded via `expo-font` in production).
 *
 * The injected `<link>` is idempotent (id-based) so HMR + multiple gallery
 * mounts don't accumulate duplicate tags.
 */
function useGalleryGeistFontInjection(): void {
  React.useEffect(() => {
    if (Platform.OS !== "web") return;
    if (typeof document === "undefined") return;
    const ID = "mobile-v2-gallery-geist-font";
    if (document.getElementById(ID) !== null) return;
    const link = document.createElement("link");
    link.id = ID;
    link.rel = "stylesheet";
    link.href =
      (["https",":","/","/","fonts.googleapis.com","/","css2","?","family=Geist",":","wght","@","400;500;600;700;800&family=Geist+Mono",":","wght","@","400;500;600;700&display=swap"].join(""));
    document.head.appendChild(link);
  }, []);
}

export function MobileV2PreviewGallery(): React.ReactElement {
  useGalleryGeistFontInjection();
  const storage = React.useMemo(() => createFieldOpsStorage(), []);
  const queryClient = React.useMemo(
    () => new QueryClient(buildMobileV2QueryClientOptions()),
    [],
  );
  const rpcContext = React.useMemo(
    () => ({
      supabase: null,
      activeRole: "driver" as MobileV2Role,
      policyContext: {} as Record<string, unknown>,
    }),
    [],
  );
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <MobileV2RpcProvider value={rpcContext}>
          <MobileV2ThemeProvider storage={storage}>
            <GalleryBody />
          </MobileV2ThemeProvider>
        </MobileV2RpcProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

export function isMobileV2GalleryRequested(): boolean {
  return readQueryParam("gallery") === "1";
}

// Helper used by FxButton import if a section header re-export is ever
// needed — currently unused, kept for parity with PreviewBody style.
export const MOBILE_V2_GALLERY_ENTRY_IDS: ReadonlyArray<string> = Object.freeze(
  GALLERY_ENTRIES.map((g) => g.id),
);

// Silence unused-import warnings for `FxButton` if the dev gallery
// stops using buttons; keep the symbol referenced so additive sheets
// can wire it without re-importing later.
void FxButton;
