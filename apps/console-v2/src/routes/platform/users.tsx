import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { UsersModule } from '@/modules/platform/users';

// CLAIM-PLATFORM-USERS (Phase D4) — operator users admin route. The IDENTITY
// cross-walk audit flagged the absence of this surface as a P0 gap (no UI
// path to grant/revoke roles, suspend/reactivate users, force password
// reset, or list/revoke sessions). The module body is mounted directly so
// route-level rendering stays consistent with the other /platform/* routes
// (access.tsx / alerts.tsx / organizations.tsx).
export const Route = createFileRoute('/platform/users')({
  component: UsersModule,
  head: () => buildRouteHead('/platform/users'),
});
