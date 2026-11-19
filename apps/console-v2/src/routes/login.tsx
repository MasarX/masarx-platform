import { createFileRoute } from '@tanstack/react-router';
import { LoginModule } from '@/modules/auth/LoginModule';

export const Route = createFileRoute('/login')({
  component: LoginModule,
});
