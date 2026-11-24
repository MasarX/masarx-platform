import {
  type DriverHoursOfServiceRecord,
  liveBackendUnavailableError,
  liveMetadataCache,
  loadLiveDriverHoursOfService,
  seed,
} from '../data-source';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { getSupabaseClient } from '../supabase';

export async function read_driver_hours_of_service_v1(
  driver_id: string,
): Promise<DriverHoursOfServiceRecord | null> {
  const map = ((seed as Record<string, unknown>).driver_hours_of_service ?? {}) as Record<
    string,
    DriverHoursOfServiceRecord | undefined
  >;
  if (getSupabaseClient()) {
    const live = await loadLiveDriverHoursOfService(driver_id);
    liveMetadataCache.driverHoursOfService[driver_id] = live;
    return SEED_MODE_ENABLED ? live ?? map[driver_id] ?? null : live;
  }
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC resolve_driver_hours_of_service_v1');
  const value = map[driver_id] ?? null;
  liveMetadataCache.driverHoursOfService[driver_id] = value;
  return value;
}
