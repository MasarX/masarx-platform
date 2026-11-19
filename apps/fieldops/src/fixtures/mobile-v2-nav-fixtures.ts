// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Production loads navigation from `ui_navigation.apps.mobile` (the SSOT
// per AGENTS.md Mobile Field Ops policy contract). This file mirrors
// the post-migration registration shape exactly so the preview shell
// can render without an RPC connection.

import { parseMobileV2NavigationPayload } from "../mobile-v2-navigation";

export const MOBILE_V2_PREVIEW_NAV_PAYLOAD = {
  apps: {
    mobile: {
      sections: [
        {
          id: "v2-home",
          label: "Home",
          items: [
            { id: "mobile-tasks", label: "Tasks", href: "/mobile/tasks", capability: "tasks.read", icon: "list", default_home: true },
            { id: "mobile-loader-today", label: "Loader Home", href: "/mobile/loader-today", capability: "loader.home.read", icon: "package", roles: ["loader"] },
            { id: "mobile-rider-today", label: "Rider Home", href: "/mobile/rider-today", capability: "rider.home.read", icon: "bike", roles: ["rider"] },
            { id: "mobile-supervisor-today", label: "Supervisor Home", href: "/mobile/supervisor-today", capability: "supervisor.home.read", icon: "shield", roles: ["supervisor"] },
          ],
        },
        {
          id: "v2-network-ops",
          label: "Network Operations",
          items: [
            { id: "mobile-pickups", label: "Pickups", href: "/mobile/pickups", capability: "pickups.read", icon: "box" },
            { id: "mobile-trips", label: "Trips", href: "/mobile/trips", capability: "trips.read", icon: "truck" },
            { id: "mobile-sortation", label: "Sortation", href: "/mobile/sortation", capability: "sortation.read", icon: "split" },
            { id: "mobile-lookup", label: "Lookup", href: "/mobile/lookup", capability: "shipments.read", icon: "search" },
            { id: "mobile-cash-drop", label: "Cash Drop", href: "/mobile/cash-drop", capability: "cash_drop.write", icon: "cash" },
            { id: "mobile-cod-ledger", label: "COD Ledger", href: "/mobile/cod-ledger", capability: "cash_drop.write", icon: "cash" },
            { id: "mobile-wallet", label: "Wallet", href: "/mobile/wallet", capability: "wallet.read", icon: "cash" },
            { id: "mobile-returns", label: "Returns to hub", href: "/mobile/returns", capability: "returns.write", icon: "package" },
            { id: "mobile-hub-pickup", label: "Hub pickup", href: "/mobile/hub-pickup", capability: "hub_pickup.write", icon: "user" },
            { id: "mobile-hold", label: "Hold queue", href: "/mobile/hold", capability: "hold.write", icon: "flag" },
            { id: "mobile-eor", label: "End of route", href: "/mobile/eor", capability: "shift.end", icon: "check-double" },
          ],
        },
        {
          id: "tools",
          label: "Tools",
          items: [
            { id: "mobile-route", label: "Route", href: "/mobile/route", capability: "tasks.read", icon: "route" },
            { id: "mobile-scan", label: "Scan", href: "/mobile/scan", capability: "scan_events.write", icon: "scan" },
            { id: "mobile-more", label: "More", href: "/mobile/more", capability: "tasks.read", icon: "settings" },
          ],
        },
      ],
    },
  },
};

export const MOBILE_V2_PREVIEW_NAV = parseMobileV2NavigationPayload(MOBILE_V2_PREVIEW_NAV_PAYLOAD);

export const MOBILE_V2_PREVIEW_CAPS: ReadonlyArray<string> = Object.freeze([
  "tasks.read",
  "loader.home.read",
  "rider.home.read",
  "supervisor.home.read",
  "pickups.read",
  "trips.read",
  "sortation.read",
  "shipments.read",
  "cash_drop.write",
  "wallet.read",
  "returns.write",
  "hub_pickup.write",
  "hold.write",
  "shift.end",
  "scan_events.write",
]);

export const MOBILE_V2_PREVIEW_ROLES: ReadonlyArray<string> = Object.freeze([
  "driver",
  "loader",
  "rider",
  "supervisor",
]);
