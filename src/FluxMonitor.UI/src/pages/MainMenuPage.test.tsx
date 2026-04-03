import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { MainMenuPage } from './MainMenuPage';

describe('MainMenuPage', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the main menu with top-level navigation actions', () => {
    render(
      <MemoryRouter>
        <MainMenuPage />
      </MemoryRouter>
    );

    expect(screen.getByText('Main menu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /system/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /monitor/i })).toBeInTheDocument();
  });
});
