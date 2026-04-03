import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { MainMenuPage } from './MainMenuPage';

describe('MainMenuPage', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the main menu with top-level navigation links', () => {
    render(
      <MemoryRouter>
        <MainMenuPage />
      </MemoryRouter>
    );

    expect(screen.getByText('Main menu')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /system/i })).toHaveAttribute('href', '/system');
    expect(screen.getByRole('link', { name: /monitor/i })).toHaveAttribute('href', '/monitor');
  });
});
