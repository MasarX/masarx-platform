import { createOAuthRoutes, oauthMethodNotAllowed } from "../_lib/routes";
export const POST = createOAuthRoutes().start;
export const GET = oauthMethodNotAllowed;
