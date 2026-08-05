import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

function Hello() {
  return <p>hello prevue</p>;
}

describe('client test infrastructure', () => {
  it('renders a component into jsdom', () => {
    render(<Hello />);
    expect(screen.getByText('hello prevue')).toBeInTheDocument();
  });

  it('exposes localStorage', () => {
    localStorage.setItem('probe', 'value');
    expect(localStorage.getItem('probe')).toBe('value');
  });
});
