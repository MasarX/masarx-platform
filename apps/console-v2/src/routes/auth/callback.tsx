import { createFileRoute } from '@tanstack/react-router';
import { AuthCallbackModule } from '@/modules/auth/AuthCallbackModule';

export const Route = createFileRoute('/auth/callback')({
  component: AuthCallbackModule,
});
