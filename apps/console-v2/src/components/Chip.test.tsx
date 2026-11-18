import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Chip } from './Chip';

describe('Chip', () => {
  it('renders the label', () => {
    render(<Chip label="active" />);
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('applies tone class', () => {
    render(<Chip label="ok" kind="good" />);
    const node = screen.getByText('ok');
    expect(node.className).toMatch(/chip--good/);
  });

  it('applies xs size class', () => {
    render(<Chip label="xs" size="xs" />);
    const node = screen.getByText('xs');
    expect(node.className).toMatch(/chip--xs/);
  });
});
