import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MainLayout } from './MainLayout';
import { useAppStore } from '../store/useAppStore';

describe('MainLayout', () => {
  beforeEach(() => {
    useAppStore.setState({
      updateProgress: null,
      updateActionPending: null,
      dismissedUpdateSessionId: null,
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({
      updateProgress: null,
      updateActionPending: null,
      dismissedUpdateSessionId: null,
    });
  });

  it('renders page content inside the shell without navigation chrome', () => {
    render(
      <MemoryRouter initialEntries={['/monitor']}>
        <MainLayout>
          <div>Page content</div>
        </MainLayout>
      </MemoryRouter>
    );

    expect(screen.getByText('Page content')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});
