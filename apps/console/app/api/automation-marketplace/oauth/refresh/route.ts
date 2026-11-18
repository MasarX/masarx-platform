import { createOAuthRoutes, oauthMethodNotAllowed } from "../_lib/routes";
export const POST = createOAuthRoutes().refresh;
export const GET = oauthMethodNotAllowed;
