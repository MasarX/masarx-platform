// i18n-fill-nodes.test.tsx: fillNodes keeps a translated sentence whole while its data values stay isolated nodes.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { fillNodes } from '@/lib/i18n';

describe('fillNodes', () => {
  it('places node values into the template in order', () => {
    const { container } = render(
      <p>{fillNodes('تم حفظ الدعوة إلى {email} · {count}', { email: <bdi>user@example.test</bdi>, count: 2 })}</p>,
    );
    expect(container.textContent).toBe('تم حفظ الدعوة إلى user@example.test · 2');
    expect(container.querySelector('bdi')?.textContent).toBe('user@example.test');
  });

  it('leaves an unknown placeholder visible instead of dropping it', () => {
    const { container } = render(<p>{fillNodes('Ref {ref}', {})}</p>);
    expect(container.textContent).toBe('Ref {ref}');
  });
});
