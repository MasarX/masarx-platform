import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { GeocodingModule } from '@/modules/network/geocoding';

export const Route = createFileRoute('/network/geocoding')({
  component: GeocodingModule,
  head: () => buildRouteHead('/network/geocoding'),
});
