import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  let scrollYValue = 0;
  const originalFetch = global.fetch;

  beforeEach(() => {
    scrollYValue = 0;

    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      get: () => scrollYValue,
    });

    Object.defineProperty(window, 'pageYOffset', {
      configurable: true,
      get: () => scrollYValue,
    });

    window.scrollTo = vi.fn((optionsOrX?: number | ScrollToOptions, y?: number) => {
      if (typeof optionsOrX === 'object') {
        scrollYValue = optionsOrX.top ?? 0;
        return;
      }

      scrollYValue = y ?? 0;
    });

    useAppStore.setState({
      updateProgress: null,
      updateActionPending: null,
      dismissedUpdateSessionId: null,
    });

    global.fetch = vi.fn().mockRejectedValue(new Error('network unavailable')) as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
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

  it('restores scroll position independently for each route in the document scroll position', async () => {
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

    scrollYValue = 240;
    fireEvent.scroll(window);

    fireEvent.click(screen.getByRole('button', { name: 'Open resource usage' }));

    await waitFor(() => {
      expect(screen.getByText('Resource usage')).toBeInTheDocument();
      expect(scrollYValue).toBe(0);
    });

    scrollYValue = 96;
    fireEvent.scroll(window);

    fireEvent.click(screen.getByRole('button', { name: 'Back to system menu' }));

    await waitFor(() => {
      expect(screen.getByText('System menu')).toBeInTheDocument();
      expect(scrollYValue).toBe(240);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open resource usage' }));

    await waitFor(() => {
      expect(screen.getByText('Resource usage')).toBeInTheDocument();
      expect(scrollYValue).toBe(96);
    });
  });
});
