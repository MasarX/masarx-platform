// planning-os.test.tsx — verifies the kanban renders current Project 6 stages, project items
// are clickable to open a drawer, and read-only chip is present.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { PlanningOsModule } from '@/modules/platform/planning-os';
import * as api from '@/lib/api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlanningOsModule', () => {
  it('renders the read-only chip and the github project link', async () => {
    renderWithProviders(<PlanningOsModule />);
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByText(/projects\/6/i)).toBeInTheDocument();
  });

  it('renders all kanban stages', async () => {
    renderWithProviders(<PlanningOsModule />);
    const stages = [
      'Inbox',
      'Needs Detail',
      'Structured',
      'Triaged',
      'Ready for Execution',
      'Assigned',
      'In PR',
      'Blocked',
      'Done',
      'Deferred',
      'Cancelled',
    ];
    for (const s of stages) {
      expect(await screen.findByText(s)).toBeInTheDocument();
    }
  });

  it('clicking a project item opens the drawer with a copy button for issue refs', async () => {
    renderWithProviders(<PlanningOsModule />);
    const card = await screen.findByTestId('planning-card-pi_8821');
    fireEvent.click(card);
    expect(await screen.findByTestId('planning-os-drawer')).toBeInTheDocument();
    // Spec issue has copy button
    expect(screen.getByTestId('copy-issue-3072')).toBeInTheDocument();
  });

  it('renders backend-projected Planning OS rows instead of the demo seed when resource data is live', async () => {
    const originalList = api.ui_list_resource_v1;
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((async (resource, opts) => {
      if (resource === 'planning_os_project_items') {
        return {
          rows: [{
            id: 'pvti_live_1',
            title: 'Live backend projected work item',
            status: 'Assigned',
            kind: 'work_item',
            priority: 'priority:p1',
            spec_issue: 4101,
            execution_card: 4102,
            pr: 4103,
            worker_id: 'worker-live-1',
            worktree: 'codex/live-planning-os',
            audit_verdict: 'pass',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'planning_os_execution_cards') {
        return {
          rows: [{
            id: 'execution-card-live-4102',
            issue_number: 4102,
            title: 'Live backend execution card',
            status: 'in_progress',
            priority: 'priority:p1',
            spec_issue: 4101,
            work_key: 'WK-20260504-live-planning-os',
            worker_id: 'worker-live-1',
            worktree: 'codex/live-planning-os',
            step: 'E05',
            review_policy: 'required',
          }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return originalList(resource, opts);
    }) as typeof api.ui_list_resource_v1);

    renderWithProviders(<PlanningOsModule />);

    const liveCard = await screen.findByTestId('planning-card-pvti_live_1');
    expect(screen.queryByTestId('planning-card-pi_8821')).not.toBeInTheDocument();
    expect(liveCard).toHaveTextContent('Live backend projected work item');
    expect(listSpy.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      'planning_os_project_items',
      'planning_os_execution_cards',
    ]));

    fireEvent.click(liveCard);
    expect(await screen.findByTestId('planning-os-drawer')).toHaveTextContent('WK-20260504-live-planning-os');
    expect(screen.getByTestId('copy-issue-4101')).toBeInTheDocument();
    expect(screen.getByTestId('copy-pr-4103')).toBeInTheDocument();
  });
});
