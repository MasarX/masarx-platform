// WCAG 2.5.7 (#301): a scope variable reaches the expression field from the
// keyboard, not only by dragging the pill onto it.
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { TemplatesModule } from '@/modules/workflows/templates';

describe('TemplatesModule variable pill without dragging', () => {
  it('Enter on a variable pill puts it in the expression field', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
    await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Inputs' }));

    const pill = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>('.wf-var-pill');
      expect(el).not.toBeNull();
      return el!;
    });
    const group = pill
      .closest('.wf-scope-tree__group')
      ?.querySelector('.wf-scope-tree__group-name')?.textContent;
    pill.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByPlaceholderText('Drop variable here or type {{ expression }}')).toHaveValue(
      `{{ ${group}.${pill.textContent} }}`
    );
  });
});
