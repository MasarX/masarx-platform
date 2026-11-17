import { redirect } from "next/navigation";

// Preserve the historical entry point without a second reporting implementation.
export default function ConsoleReportingAliasPage() {
  redirect("/#shipment-reporting");
}
