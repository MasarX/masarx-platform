// TenantPicker.tsx — platform-only tenant switcher.
//
// VISIBILITY: only platform users (`useIdentity().isPlatformUser()`) see the
// picker. The 4-tier access scope contract means a tenant-bound user
// (`access_scope_type === 'tenant'`) cannot leave their org via the UI; their
// `current_user_org_id()` is RLS-enforced server-side. Portal users
// (client/sender) never reach the shell at all (see `AppGuard`).
//
// DATA: organizations come from the canonical reads contract via
// `useResourceList<OrganizationRow>('organizations')` so the production swap
// is `supabase.rpc('ui_list_resource_v1', { p_resource: 'organizations' })`
// without touching this component. The seed file ships at least 2 orgs
// (`org_rashed` Rashed Logistics + `org_swift` Swift Express KSA) so the
// picker has meaningful entries in the demo.
//
// SELECTION: writes the chosen tenant into the legacy UI `Scope` ladder via
// `switchScope({ tenant })`. The user's own `access_scope_type` stays
// `platform` — only the *active* lens changes. This mirrors how a real
// platform admin browsing one tenant's data still has cross-tenant RLS reach.
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useIdentity } from '@/lib/identity';
import { useCompleteResourceList } from '@/lib/queries';
import { Chip } from '@/components/Chip';
import { Icon } from '@/components/Icon';

/**
 * Mirrors `public.organizations` (id + display name suffices for the picker).
 * Phase G1 schema-drift fix: renamed `status` → `billing_status` to match the
 * canonical column. See __audit__/SCHEMA-DRIFT/IDENTITY.md §1.
 */
export interface OrganizationRow extends Record<string, unknown> {
  id: string;
  name: string;
  billing_status?: string;
}

export interface TenantPickerProps {
  /** Optional className to compose with parent topbar layout. */
  className?: string;
}

/**
 * Platform-only tenant switcher. Returns `null` for non-platform users so the
 * topbar layout is unaffected for tenant/portal sessions.
 */
export function TenantPicker({ className }: TenantPickerProps) {
  const { isPlatformUser, scope, switchScope } = useIdentity();
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        popRef.current?.contains(t) ||
        btnRef.current?.contains(t)
      )
        return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Always call hooks unconditionally to satisfy rules-of-hooks; bail-out
  // happens AFTER the hooks are wired so React never sees a hook order swap.
  const platform = isPlatformUser();
  const orgsQuery = useCompleteResourceList<OrganizationRow>(
    'organizations',
    { sort: { key: 'name', dir: 'asc' } },
    { enabled: platform },
  );
  const [search, setSearch] = useState('');

  const handlePick = useCallback(
    (org: OrganizationRow) => {
      // Mirror the existing scope ladder shape (rank 2 = tenant in the
      // existing demo Scope; the access_scope_type tier on the user is
      // independent and stays 'platform' for cross-tenant reach).
      switchScope({ tenant: { id: org.id, label: org.name, rank: 2 } });
      setOpen(false);
      btnRef.current?.focus();
    },
    [switchScope],
  );

  const activeId = scope?.tenant?.id ?? null;
  const activeLabel = scope?.tenant?.label ?? '—';
  const orgs = useMemo(() => orgsQuery.data?.rows ?? [], [orgsQuery.data?.rows]);
  const filteredOrgs = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return orgs;
    return orgs.filter((org) =>
      `${org.name} ${org.id}`.toLowerCase().includes(needle),
    );
  }, [orgs, search]);
  const wrapperClass = ['tenant-picker', className].filter(Boolean).join(' ');

  if (!platform) return null;

  return (
    <div className={wrapperClass} data-testid="tenant-picker">
      <Chip
        label="Platform"
        kind="info"
        size="xs"
        className="tenant-picker__badge"
        title="Platform user — cross-tenant reach"
      />
      <button
        ref={btnRef}
        type="button"
        className="tenant-picker__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Active tenant: ${activeLabel}. Click to switch tenant.`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="building" size={12} />
        <span className="tenant-picker__name">{activeLabel}</span>
        <span className="tenant-picker__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div
          ref={popRef}
          className="tenant-picker__pop"
          role="listbox"
          aria-label="Switch tenant"
        >
          <div className="tenant-picker__head">
            <span className="tenant-picker__heading">Switch tenant</span>
            <span className="tenant-picker__hint">
              Cross-tenant reads stay in effect.
            </span>
          </div>
          <label className="tenant-picker__search-label" htmlFor="tenant-picker-search">
            Search tenants
          </label>
          <input
            id="tenant-picker-search"
            className="tenant-picker__search"
            type="search"
            value={search}
            placeholder="Name or organization ID"
            onChange={(event) => setSearch(event.target.value)}
          />
          <ul className="tenant-picker__list">
            {orgsQuery.isLoading ? (
              <li className="tenant-picker__empty">Loading organizations…</li>
            ) : orgs.length === 0 ? (
              <li className="tenant-picker__empty">No organizations available.</li>
            ) : filteredOrgs.length === 0 ? (
              <li className="tenant-picker__empty">No tenants match this search.</li>
            ) : (
              filteredOrgs.map((org) => {
                const isActive = org.id === activeId;
                return (
                  <li key={org.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={
                        isActive
                          ? 'tenant-picker__item tenant-picker__item--active'
                          : 'tenant-picker__item'
                      }
                      onClick={() => handlePick(org)}
                    >
                      <span className="tenant-picker__item-name">{org.name}</span>
                      <span className="tenant-picker__item-id mono">{org.id}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
