import { flushSync } from 'react-dom';
import { supportsViewTransitions } from './utils';

export type ViewTransitionDirection = 'forward' | 'back';

type ActiveViewTransition = {
  finished: Promise<unknown>;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => ActiveViewTransition;
};

let activePageTransitionId = 0;

export function runWithViewTransition(
  callback: () => void,
  options?: { direction?: ViewTransitionDirection },
) {
  if (!supportsViewTransitions()) {
    callback();
    return;
  }

  const transitionDocument = document as ViewTransitionDocument;
  const pageTransitionId = String(++activePageTransitionId);
  const rootElement = document.documentElement;

  rootElement.dataset.pageTransitionId = pageTransitionId;

  if (options?.direction) {
    rootElement.dataset.pageTransitionDirection = options.direction;
  } else {
    delete rootElement.dataset.pageTransitionDirection;
  }

  const transition = transitionDocument.startViewTransition?.(() => {
    flushSync(callback);
  });

  if (!transition) {
    callback();
    delete rootElement.dataset.pageTransitionId;
    delete rootElement.dataset.pageTransitionDirection;
    return;
  }

  void transition.finished.finally(() => {
    if (rootElement.dataset.pageTransitionId !== pageTransitionId) {
      return;
    }

    delete rootElement.dataset.pageTransitionId;
    delete rootElement.dataset.pageTransitionDirection;
  });
}
