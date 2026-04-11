import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { cn } from '../../lib/utils';
import type { WebTerminalSnapshot } from './types';
import { FitAddon } from '@xterm/addon-fit';
import { LoaderCircle, RefreshCw, Shield, SquareTerminal, Trash2 } from 'lucide-react';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';

type TerminalSectionProps = {
  terminalAccess: WebTerminalSnapshot | null;
  connectivityLoading: boolean;
};

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

function seedTerminal(terminal: Terminal) {
  terminal.writeln('\x1b[1;36mFlux Monitor web terminal\x1b[0m');
  terminal.writeln('\x1b[90mUse the same shell you would over SSH, including sudo prompts and interactive apps.\x1b[0m');
}

export function TerminalSection({ terminalAccess, connectivityLoading }: TerminalSectionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const socketGenerationRef = useRef(0);
  const resetViewportOnNextConnectRef = useRef(false);
  const [terminalReady, setTerminalReady] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [connectionDetail, setConnectionDetail] = useState<string | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);

  const terminalEnabled = terminalAccess?.enabled ?? false;
  const terminalSupported = terminalAccess?.supported ?? false;
  const statusTone = connectionState === 'connected'
    ? 'default'
    : connectionState === 'connecting'
      ? 'secondary'
      : connectionState === 'error'
        ? 'destructive'
        : 'outline';

  const canConnect = terminalEnabled && terminalSupported;
  const statusLabel = connectionState === 'connected'
    ? 'Connected'
    : connectionState === 'connecting'
      ? 'Connecting'
      : connectionState === 'error'
        ? 'Connection error'
        : connectionState === 'disconnected'
          ? 'Disconnected'
          : 'Ready';

  const socketUrl = useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/api/system/terminal/ws`;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || terminalRef.current) {
      return undefined;
    }

    const terminal = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: '#050816',
        foreground: '#d9e2f1',
        cursor: '#9ae6b4',
        cursorAccent: '#050816',
        selectionBackground: '#1e293b',
        black: '#0f172a',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e2e8f0',
        brightBlack: '#475569',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#f8fafc',
      },
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();
    terminal.focus();
    seedTerminal(terminal);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setTerminalReady(true);

    const focusTerminal = () => {
      terminal.focus();
      const helperTextArea = container.querySelector('.xterm-helper-textarea');
      if (helperTextArea instanceof HTMLTextAreaElement) {
        helperTextArea.focus();
      }
    };

    const dataDisposable = terminal.onData((data) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(JSON.stringify({ type: 'input', data }));
    });

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
        fitAddon.fit();
      });

    container.addEventListener('pointerdown', focusTerminal);
    container.addEventListener('touchstart', focusTerminal, { passive: true });
    resizeObserver?.observe(container);

    return () => {
      container.removeEventListener('pointerdown', focusTerminal);
      container.removeEventListener('touchstart', focusTerminal);
      resizeObserver?.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      fitAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      setTerminalReady(false);
    };
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!canConnect || !socketUrl) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close(1000, 'Terminal disabled.');
      }

      socketRef.current = null;
      setConnectionState('idle');
      setConnectionDetail(terminalAccess?.statusMessage ?? null);
      return undefined;
    }

    if (!terminalReady) {
      setConnectionState('idle');
      setConnectionDetail('Preparing terminal…');
      return undefined;
    }

    const terminal = terminalRef.current;
    if (!terminal || typeof WebSocket === 'undefined') {
      setConnectionState('error');
      setConnectionDetail('This browser cannot open the terminal connection.');
      return undefined;
    }

    fitAddonRef.current?.fit();
    if (resetViewportOnNextConnectRef.current) {
      terminal.clear();
      seedTerminal(terminal);
      resetViewportOnNextConnectRef.current = false;
    }

    setConnectionState('connecting');
    setConnectionDetail('Opening host shell…');

    const url = new URL(socketUrl);
    url.searchParams.set('cols', String(terminal.cols));
    url.searchParams.set('rows', String(terminal.rows));

    const socketGeneration = socketGenerationRef.current + 1;
    socketGenerationRef.current = socketGeneration;
    const nextSocket = new WebSocket(url);
    socketRef.current = nextSocket;

    nextSocket.onopen = () => {
      if (socketRef.current !== nextSocket || socketGenerationRef.current !== socketGeneration) {
        return;
      }

      setConnectionState('connected');
      setConnectionDetail('Connected to the host shell.');
      terminal.focus();
      nextSocket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };

    nextSocket.onmessage = (event) => {
      if (socketRef.current !== nextSocket || socketGenerationRef.current !== socketGeneration) {
        return;
      }

      if (typeof event.data === 'string') {
        terminal.write(event.data);
      }
    };

    nextSocket.onerror = () => {
      if (socketRef.current !== nextSocket || socketGenerationRef.current !== socketGeneration) {
        return;
      }

      setConnectionState('error');
      setConnectionDetail('The terminal connection failed.');
    };

    nextSocket.onclose = (event) => {
      if (socketGenerationRef.current !== socketGeneration) {
        return;
      }

      if (socketRef.current === nextSocket) {
        socketRef.current = null;
      }

      setConnectionState(event.wasClean ? 'disconnected' : 'error');
      setConnectionDetail(event.reason || (event.wasClean
        ? 'The terminal session ended.'
        : 'The terminal disconnected unexpectedly.'));
    };

    return () => {
      nextSocket.onopen = null;
      nextSocket.onmessage = null;
      nextSocket.onerror = null;
      nextSocket.onclose = null;

      if (nextSocket.readyState === WebSocket.OPEN || nextSocket.readyState === WebSocket.CONNECTING) {
        nextSocket.close(1000, 'Leaving terminal page.');
      }

      if (socketRef.current === nextSocket) {
        socketRef.current = null;
      }
    };
  }, [canConnect, reconnectKey, socketUrl, terminalAccess?.statusMessage, terminalReady]);

  return (
    <Card className='flex min-h-full flex-1 flex-col overflow-hidden border border-border/80 bg-card/85 shadow-sm'>
      <CardContent className='flex min-h-0 flex-1 flex-col gap-4 p-4'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='space-y-2'>
            <div className='flex items-center gap-2'>
              <SquareTerminal className='h-4 w-4 text-muted-foreground' />
              <div className='text-sm font-semibold text-foreground'>Host terminal</div>
            </div>
            <div className='max-w-3xl text-sm text-muted-foreground'>
              Run the host shell directly in the browser. This uses the same interactive terminal flow as SSH, including `sudo` prompts and TUI apps.
            </div>
          </div>
          <div className='flex flex-wrap items-center gap-2'>
            <Badge variant={statusTone}>{statusLabel}</Badge>
            <Badge variant='outline'>{terminalAccess?.activeSessionCount ?? 0} active</Badge>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={() => {
                resetViewportOnNextConnectRef.current = true;
                setReconnectKey((current) => current + 1);
              }}
              disabled={!canConnect || connectionState === 'connecting'}
            >
              {connectionState === 'connecting' ? <LoaderCircle className='animate-spin' /> : <RefreshCw />}
              Reconnect
            </Button>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={() => terminalRef.current?.clear()}
            >
              <Trash2 />
              Clear
            </Button>
          </div>
        </div>

        <div className='flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-background/40 px-3 py-2 text-xs text-muted-foreground'>
          <span>{connectionDetail ?? terminalAccess?.statusMessage ?? 'Ready.'}</span>
          <span>Reconnect after a major resize to refresh the shell geometry.</span>
        </div>

        {!connectivityLoading && !terminalSupported ? (
          <div className='flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border bg-background/35 px-6 py-10'>
            <div className='max-w-lg space-y-3 text-center'>
              <div className='text-base font-semibold text-foreground'>Terminal unavailable on this host</div>
              <div className='text-sm text-muted-foreground'>
                {terminalAccess?.statusMessage ?? 'The host is missing the runtime required to launch the web terminal.'}
              </div>
            </div>
          </div>
        ) : null}

        {!connectivityLoading && terminalSupported && !terminalEnabled ? (
          <div className='flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border bg-background/35 px-6 py-10'>
            <div className='max-w-lg space-y-3 text-center'>
              <div className='inline-flex justify-center'>
                <Badge variant='outline' className='gap-1.5'>
                  <Shield />
                  Terminal off
                </Badge>
              </div>
              <div className='text-base font-semibold text-foreground'>Web terminal access is disabled</div>
              <div className='text-sm text-muted-foreground'>
                Turn it back on from Connectivity to allow browser access to the host shell.
              </div>
              <div>
                <Button render={<Link to='/system/connectivity' />} variant='outline'>
                  Open Connectivity
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {connectivityLoading ? (
          <div className='flex flex-1 items-center justify-center rounded-2xl border border-border/70 bg-background/35'>
            <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
          </div>
        ) : null}

        {!connectivityLoading && canConnect ? (
          <div className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'>
            <div className='flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-2 text-xs text-slate-300'>
              <div className='flex items-center gap-2'>
                <span className={cn(
                  'h-2.5 w-2.5 rounded-full',
                  connectionState === 'connected'
                    ? 'bg-emerald-400'
                    : connectionState === 'connecting'
                      ? 'bg-amber-400'
                      : connectionState === 'error'
                        ? 'bg-rose-400'
                        : 'bg-slate-500'
                )}
                />
                <span>{terminalAccess?.shellPath ?? '/bin/bash'}</span>
              </div>
              <span>{terminalAccess?.transport ?? 'terminal session'}</span>
            </div>
            <div ref={containerRef} className='web-terminal-host min-h-0 flex-1 overflow-hidden px-2 py-2' />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
