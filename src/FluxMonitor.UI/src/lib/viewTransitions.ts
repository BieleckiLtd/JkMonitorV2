import { flushSync } from 'react-dom';
import { supportsViewTransitions } from './utils';

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => void;
};

export function runWithViewTransition(callback: () => void) {
  if (!supportsViewTransitions()) {
    callback();
    return;
  }

  const transitionDocument = document as ViewTransitionDocument;
  transitionDocument.startViewTransition?.(() => {
    flushSync(callback);
  });
}
