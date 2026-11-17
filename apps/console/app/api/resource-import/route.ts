import type { NextRequest } from "next/server";
import { handleResourceImportRequest } from "../../../../shared/resource-import-route";

export async function POST(request: NextRequest) {
  return handleResourceImportRequest(request);
}
