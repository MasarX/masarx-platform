// participant-applications.arabic.test.tsx: the participant pre-approval queue renders its own copy in Arabic; applicant values stay as data (#302).
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/marketplace-geocoding';
import { ParticipantApplicationsModule } from '@/modules/network/participant-applications';

const FULL_CAPS = [
  'marketplace_participant_requests.read',
  'marketplace_participant_requests.review',
];

// Header title, KPI labels and deltas and table headers are module copy; table cells hold seeded data.
const chrome = () => [...document.querySelectorAll('.page-header__title-block, .kpi__label, .kpi__delta, .dt__table thead')];
// Drawer key labels and section eyebrows are module copy; the drawer title and key values are applicant data.
const drawerChrome = () => [...document.querySelectorAll('.drawer .kvgrid__key, .drawer .section-eyebrow')];

describe('ParticipantApplicationsModule in Arabic', () => {
  it('renders the header, KPIs, table headers and request drawer in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ParticipantApplicationsModule />, { locale: 'ar', capabilities: FULL_CAPS });
    expect(await screen.findByTestId('participant-applications-kpi-strip')).toBeInTheDocument();
    const swift = await screen.findByText(/Swift Logistics/i);
    expect(screen.getByText(ar.participantApplications.kpi.pending)).toBeInTheDocument();
    expect(chrome().length).toBeGreaterThan(0);
    expect(chrome().flatMap((element) => findUntranslated(element))).toEqual([]);

    await user.click(swift);
    await waitFor(() => {
      expect(screen.getByText(ar.participantApplications.section.reviewActions)).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(drawerChrome().length).toBeGreaterThan(0);
    expect(drawerChrome().flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English copy the queue showed before', () => {
    expect(englishT('participantApplications.kpi.pending')).toBe('Pending');
    expect(englishT('participantApplications.drawer.title')).toBe('Application · {id}');
    expect(englishT('participantApplications.section.reviewActions')).toBe('Review actions');
    expect(englishT('participantApplications.chip.status')).toBe('status: {status}');
    expect(ar.participantApplications.kpi.approved).toBe('معتمدة');
    expect(ar.participantApplications.section.reviewActions).toBe('إجراءات المراجعة');
  });
});
