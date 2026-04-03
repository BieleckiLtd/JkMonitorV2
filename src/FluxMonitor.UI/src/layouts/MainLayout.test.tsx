import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MainLayout } from './MainLayout';
import { useAppStore } from '../store/useAppStore';

function TestPage({
  label,
  navigateTo,
  buttonLabel,
}: {
  label: string;
  navigateTo: string;
  buttonLabel: string;
}) {
  const navigate = useNavigate();

  return (
    <div>
      <button type='button' onClick={() => navigate(navigateTo)}>
        {buttonLabel}
      </button>
      <div>{label}</div>
    </div>
  );
}

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

  it('restores scroll position independently for each route in the shared scroll container', async () => {
    render(
      <MemoryRouter initialEntries={['/system']}>
        <MainLayout>
          <Routes>
            <Route
              path='/system'
              element={(
                <TestPage
                  label='System menu'
                  navigateTo='/system/resource-usage'
                  buttonLabel='Open resource usage'
                />
              )}
            />
            <Route
              path='/system/resource-usage'
              element={(
                <TestPage
                  label='Resource usage'
                  navigateTo='/system'
                  buttonLabel='Back to system menu'
                />
              )}
            />
          </Routes>
        </MainLayout>
      </MemoryRouter>
    );

    const scrollContainer = document.querySelector('main');
    expect(scrollContainer).not.toBeNull();

    if (!scrollContainer) {
      throw new Error('Expected the shared main scroll container to be rendered.');
    }

    scrollContainer.scrollTop = 240;
    fireEvent.scroll(scrollContainer);

    fireEvent.click(screen.getByRole('button', { name: 'Open resource usage' }));

    await waitFor(() => {
      expect(screen.getByText('Resource usage')).toBeInTheDocument();
      expect(scrollContainer.scrollTop).toBe(0);
    });

    scrollContainer.scrollTop = 96;
    fireEvent.scroll(scrollContainer);

    fireEvent.click(screen.getByRole('button', { name: 'Back to system menu' }));

    await waitFor(() => {
      expect(screen.getByText('System menu')).toBeInTheDocument();
      expect(scrollContainer.scrollTop).toBe(240);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open resource usage' }));

    await waitFor(() => {
      expect(screen.getByText('Resource usage')).toBeInTheDocument();
      expect(scrollContainer.scrollTop).toBe(96);
    });
  });
});
