import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TerminalSection } from './TerminalSection';

const terminalMocks = vi.hoisted(() => ({
  terminals: [] as any[],
  sockets: [] as any[],
}));

vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit = vi.fn();
    dispose = vi.fn();
  }

  return { FitAddon: MockFitAddon };
});

vi.mock('xterm', () => {
  class MockTerminal {
    cols = 120;
    rows = 32;
    focusCount = 0;
    clearCount = 0;
    writtenLines: string[] = [];
    textarea: HTMLTextAreaElement | undefined;
    helperTextArea: HTMLTextAreaElement | null = null;
    private onDataHandler: ((data: string) => void) | null = null;
    private onResizeHandler: ((size: { cols: number; rows: number }) => void) | null = null;

    constructor() {
      terminalMocks.terminals.push(this);
    }

    loadAddon() {}

    open(container: HTMLElement) {
      const helperTextArea = document.createElement('textarea');
      helperTextArea.className = 'xterm-helper-textarea';
      container.appendChild(helperTextArea);
      this.textarea = helperTextArea;
      this.helperTextArea = helperTextArea;
    }

    focus() {
      this.focusCount += 1;
    }

    writeln(value: string) {
      this.writtenLines.push(value);
    }

    clear() {
      this.clearCount += 1;
    }

    write(value: string) {
      this.writtenLines.push(value);
    }

    dispose() {}

    onData(handler: (data: string) => void) {
      this.onDataHandler = handler;
      return {
        dispose: () => {
          this.onDataHandler = null;
        },
      };
    }

    onResize(handler: (size: { cols: number; rows: number }) => void) {
      this.onResizeHandler = handler;
      return {
        dispose: () => {
          this.onResizeHandler = null;
        },
      };
    }
  }

  return { Terminal: MockTerminal };
});

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  readonly send = vi.fn();
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ wasClean: true, code: code ?? 1000, reason: reason ?? '' } as CloseEvent);
  });
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    terminalMocks.sockets.push(this);
    queueMicrotask(() => {
      if (this.readyState !== MockWebSocket.CONNECTING) {
        return;
      }

      this.emitOpen();
    });
  }

  emitOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
}

describe('TerminalSection', () => {
  beforeEach(() => {
    terminalMocks.terminals.length = 0;
    terminalMocks.sockets.length = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('ResizeObserver', undefined);
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      matches: false,
      media: '(pointer: coarse)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('focuses the terminal again when the host surface is pressed', async () => {
    const { container } = render(
      <MemoryRouter>
        <TerminalSection
          terminalAccess={{
            supported: true,
            enabled: true,
            storageAvailable: true,
            activeSessionCount: 0,
            statusMessage: 'Web terminal access is enabled.',
            shellPath: '/bin/bash',
            transport: 'pty-via-script',
          }}
          connectivityLoading={false}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(terminalMocks.terminals).toHaveLength(1);
      expect(terminalMocks.sockets).toHaveLength(1);
    });

    const terminal = terminalMocks.terminals[0];
    const host = container.querySelector('.web-terminal-host');
    if (!(host instanceof HTMLDivElement)) {
      throw new Error('Expected the terminal host to render.');
    }

    const focusCountBeforePress = terminal.focusCount;
    fireEvent.pointerDown(host);

    expect(terminal.focusCount).toBeGreaterThan(focusCountBeforePress);
    expect(document.activeElement).toBe(host.querySelector('.xterm-helper-textarea'));
  });

  it('configures the helper textarea for touch keyboards', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      matches: true,
      media: '(pointer: coarse)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));

    render(
      <MemoryRouter>
        <TerminalSection
          terminalAccess={{
            supported: true,
            enabled: true,
            storageAvailable: true,
            activeSessionCount: 0,
            statusMessage: 'Web terminal access is enabled.',
            shellPath: '/bin/bash',
            transport: 'pty-via-script',
          }}
          connectivityLoading={false}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(terminalMocks.terminals).toHaveLength(1);
    });

    const terminal = terminalMocks.terminals[0];
    expect(terminal.textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(terminal.textarea.autocapitalize).toBe('none');
    expect(terminal.textarea.autocomplete).toBe('off');
    expect(terminal.textarea.autocorrect).toBe('off');
    expect(terminal.textarea.inputMode).toBe('text');
    expect(terminal.textarea.spellcheck).toBe(false);
    expect(terminal.textarea.style.left).toBe('0px');
    expect(terminal.textarea.style.width).toBe('1px');
    expect(terminal.textarea.style.height).toBe('1px');
    expect(terminal.textarea.style.opacity).toBe('0.01');
    expect(terminal.textarea.style.zIndex).toBe('1');
  });
});
