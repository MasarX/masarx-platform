import { Button } from '@/components/Button';
import { CAP } from '@/lib/capabilities';
import type { ExternalIntakeTokenTarget } from '@/lib/external-intake-token-handoff';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';

export function externalIntakeTargetPath(target: ExternalIntakeTokenTarget): string {
  return target === 'api-gateway' ? '/insights/api-gateway' : '/integrations/webhook-tester';
}

const EXTERNAL_INTAKE_WORKSPACE_GROUPS = [
  {
    label: 'Setup',
    actions: [
      {
        label: 'Sources & tokens',
        iconName: 'plug',
        href: '/integrations/sources',
        capability: CAP.WEBHOOKS_READ,
      },
      {
        label: 'Provider credentials',
        iconName: 'key',
        href: '/integrations/credentials',
        capability: CAP.PROVIDER_AUTH_READ,
      },
      {
        label: 'Intake mappings',
        iconName: 'git',
        href: '/integrations/mapping',
        capability: CAP.MAPPINGS_READ,
      },
      {
        label: 'Routing rules',
        iconName: 'route',
        href: '/integrations/rules',
        capability: CAP.WEBHOOKS_READ,
      },
    ],
  },
  {
    label: 'Test',
    actions: [
      {
        label: 'Test webhook intake',
        iconName: 'webhook',
        href: '/integrations/webhook-tester',
        capability: CAP.WEBHOOKS_READ,
      },
      {
        label: 'API request intake',
        iconName: 'gauge',
        href: '/insights/api-gateway',
        capability: CAP.API_GATEWAY_READ,
      },
    ],
  },
  {
    label: 'Review',
    actions: [
      {
        label: 'Inbox failures & replay',
        iconName: 'download',
        href: '/integrations/intake',
        capability: CAP.WEBHOOKS_READ,
      },
      {
        label: 'API requests & replay',
        iconName: 'list',
        href: '/insights/api-gateway?view=requests',
        capability: CAP.API_GATEWAY_READ,
      },
      {
        label: 'API auth failures',
        iconName: 'shield',
        href: '/insights/api-gateway?view=auth',
        capability: CAP.API_GATEWAY_READ,
      },
    ],
  },
] as const;

export function ExternalIntakeWorkspaceToolbar({ activePath }: { activePath?: string }) {
  const go = useConsoleNavigator();
  const navigateToWorkspaceTarget = (href: string) => {
    go(href);
  };
  const isActiveAction = (href: string) => activePath === href;

  return (
    <>
      <div className="section-eyebrow">External Intake workspace</div>
      <div className="dash-toolbar" role="toolbar" aria-label="External Intake workspace">
        {EXTERNAL_INTAKE_WORKSPACE_GROUPS.map((group) => (
          <div
            key={group.label}
            className="dash-toolbar__group external-intake-toolbar__group"
            role="group"
            aria-label={`${group.label} intake actions`}
          >
            <span className="external-intake-toolbar__group-label">{group.label}</span>
            {group.actions.map((action) => (
              <Button
                key={action.href}
                kind={isActiveAction(action.href) ? 'primary' : 'ghost'}
                size="sm"
                iconName={action.iconName}
                label={action.label}
                capability={action.capability}
                ariaLabel={`Open ${action.label}`}
                onClick={() => navigateToWorkspaceTarget(action.href)}
              />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
