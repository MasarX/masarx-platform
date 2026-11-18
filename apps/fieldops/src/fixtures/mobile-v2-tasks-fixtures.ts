// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Production loads tasks from `public.resolve_fieldops_tasks_v1` via
// the @tanstack/react-query hook in mobile-v2-rpc-hooks.ts; this file
// is only used as `fallback:` so the preview renders without a
// supabase connection.

import { parseMobileV2TaskList, type MobileV2Task } from "../mobile-v2-tasks-types";

export const MOBILE_V2_PREVIEW_TASKS: ReadonlyArray<MobileV2Task> = parseMobileV2TaskList([
  {
    task_id: "stop:1",
    type: "delivery",
    // Design ScrTasks delivery `sub` is `Stop N · Area · SLA HH:MM`
    // (flow-tasks.jsx:32); the COD amount renders as a SEPARATE meta
    // chip (`${cod} ﷼ COD`, flow-tasks.jsx:35) — never inline in the
    // subtitle. The COD figure + currency live in structured `meta`
    // (`cod_amount` / `cod_currency`) so `deriveMobileV2TaskMetaLabel`
    // renders the rial-symbol chip; the "SAR" literal is no longer
    // hardcoded into copy.
    title: "DLX-784521",
    sub: "Premium · Olaya · SLA 17:30",
    urgency: "now",
    cta: "Start",
    route: "/mobile/stop/1",
    eta_iso: new Date(Date.now() + 22 * 60 * 1000).toISOString(),
    priority: 88,
    area: "Olaya",
    code: "DLX-784521",
    action: "delivery",
    tone: "warning",
    meta: {
      box_count: 2,
      customer: "Khalid Al-Hashimi",
      cod_amount: 250,
      cod_currency: "SAR",
    },
  },
  {
    task_id: "stop:2",
    type: "delivery",
    title: "DLX-784583",
    sub: "Standard · 1 box",
    urgency: "now",
    cta: "Start",
    route: "/mobile/stop/2",
    eta_iso: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    priority: 65,
    area: "Riyadh",
    code: "DLX-784583",
    action: "delivery",
    tone: "accent",
    meta: { box_count: 1, customer: "Sara Faisal" },
  },
  {
    task_id: "stop:3",
    type: "pickup",
    title: "PU-200118",
    sub: "Merchant pickup · 4 boxes",
    urgency: "today",
    cta: "Open",
    route: "/mobile/pickup/3",
    eta_iso: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    priority: 55,
    area: "Diplomatic Quarter",
    code: "PU-200118",
    action: "pickup",
    tone: "info",
    meta: { box_count: 4, merchant: "Examplemerchant Markets" },
  },
  {
    task_id: "stop:4",
    type: "delivery",
    title: "DLX-783012",
    sub: "Express · 1 box",
    urgency: "today",
    cta: "Open",
    route: "/mobile/stop/4",
    eta_iso: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    priority: 70,
    area: "Al Malaz",
    code: "DLX-783012",
    action: "delivery",
    tone: "info",
    meta: { box_count: 1, customer: "Ahmed Saud" },
  },
  {
    task_id: "stop:5",
    type: "rto",
    title: "RTO-9919",
    sub: "Recipient unavailable · return to hub",
    urgency: "later",
    cta: "Open",
    route: "/mobile/return/5",
    eta_iso: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    priority: 30,
    area: "Hub-RUH-01",
    code: "RTO-9919",
    action: "rto",
    tone: "neutral",
    meta: { reason: "recipient_unavailable" },
  },
  {
    task_id: "sync:outbox",
    type: "sortation",
    title: "Sync outbox",
    sub: "3 queued · last attempt 4 min ago",
    urgency: "now",
    cta: "Sync",
    route: "/mobile/outbox",
    eta_iso: null,
    priority: 95,
    area: null,
    code: null,
    action: "sync",
    tone: "warning",
    meta: { queued: 3 },
  },
]);
