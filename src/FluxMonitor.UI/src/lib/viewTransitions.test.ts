import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithViewTransition } from './viewTransitions';

describe('runWithViewTransition', () => {
  afterEach(() => {
    delete document.documentElement.dataset.pageTransitionDirection;
    delete document.documentElement.dataset.pageTransitionId;

    delete (document as Document & { startViewTransition?: unknown }).startViewTransition;

    vi.restoreAllMocks();
  });

  it('applies the requested direction while the view transition is active', async () => {
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      return { finished };
    });

    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    });

    let directionDuringCallback: string | undefined;

    runWithViewTransition(() => {
      directionDuringCallback = document.documentElement.dataset.pageTransitionDirection;
    }, { direction: 'forward' });

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(directionDuringCallback).toBe('forward');
    expect(document.documentElement.dataset.pageTransitionDirection).toBe('forward');
    expect(document.documentElement.dataset.pageTransitionId).toBeTruthy();

    resolveFinished();
    await finished;
    await Promise.resolve();

    expect(document.documentElement.dataset.pageTransitionDirection).toBeUndefined();
    expect(document.documentElement.dataset.pageTransitionId).toBeUndefined();
  });

  it('runs the callback without transition metadata when the API is unavailable', () => {
    let callbackRan = false;

    runWithViewTransition(() => {
      callbackRan = true;
    }, { direction: 'back' });

    expect(callbackRan).toBe(true);
    expect(document.documentElement.dataset.pageTransitionDirection).toBeUndefined();
    expect(document.documentElement.dataset.pageTransitionId).toBeUndefined();
  });
});
