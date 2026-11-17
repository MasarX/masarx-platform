import { handleUiEventRequest } from "../../../../shared/ui-event-route";
import type { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  return handleUiEventRequest("console", request);
}
