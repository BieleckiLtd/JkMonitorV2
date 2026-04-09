import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrimaryNavigationLayout } from './PrimaryNavigationLayout';

type MatchMediaMock = MediaQueryList & {
  dispatchChange: (matches: boolean) => void;
};

function createMatchMediaMock(initialMatches: boolean): MatchMediaMock {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  return {
    get matches() {
      return matches;
    },
    media: '(min-width: 768px)',
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => true,
    dispatchChange: (nextMatches: boolean) => {
      matches = nextMatches;
      const event = { matches, media: '(min-width: 768px)' } as MediaQueryListEvent;

      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

function renderLayout(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={<PrimaryNavigationLayout />}>
          <Route path='/' element={<div>Home workspace</div>} />
          <Route path='/monitor' element={<div>Monitor workspace</div>} />
          <Route path='/devices' element={<div>Devices workspace</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('PrimaryNavigationLayout', () => {
  let matchMediaMock: MatchMediaMock;

  beforeEach(() => {
    matchMediaMock = createMatchMediaMock(true);
    window.matchMedia = vi.fn().mockImplementation(() => matchMediaMock);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the primary menu visible while routing content into the right workspace at tablet widths', async () => {
    renderLayout('/');

    expect(screen.getByRole('navigation', { name: /primary navigation/i })).toBeInTheDocument();
    expect(screen.getByText('Open a section')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /monitor/i }));

    await waitFor(() => {
      expect(screen.getByText('Monitor workspace')).toBeInTheDocument();
    });

    expect(screen.getByRole('navigation', { name: /primary navigation/i })).toBeInTheDocument();
    expect(screen.queryByText('Open a section')).not.toBeInTheDocument();
  });

  it('falls back to rendering only the active route below the split breakpoint', () => {
    matchMediaMock.dispatchChange(false);

    renderLayout('/devices');

    expect(screen.queryByRole('navigation', { name: /primary navigation/i })).not.toBeInTheDocument();
    expect(screen.getByText('Devices workspace')).toBeInTheDocument();
  });
});
