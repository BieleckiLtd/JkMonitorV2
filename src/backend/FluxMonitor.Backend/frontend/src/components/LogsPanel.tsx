import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, Filter, Search, RefreshCw, ChevronLeft, ChevronRight, Copy, Check, ClipboardX } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { cn } from '../lib/utils';

type LogEntry = {
  id: number;
  timestamp: string;
  level: string;
  category: string;
  message: string;
  exception?: string | null;
};

type LogQueryResponse = {
  entries: LogEntry[];
  totalCount: number;
};

const severityLevels = ['Trace', 'Debug', 'Information', 'Warning', 'Error', 'Critical'] as const;

const defaultSelectedLevels = new Set(['Critical', 'Error', 'Warning']);

const pageSize = 100;

function getDefaultFrom() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date;
}

function toLocalDatetimeString(date: Date) {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function severityColor(level: string) {
  switch (level) {
    case 'Critical':
      return 'bg-rose-500/20 text-rose-300 border-rose-500/30';
    case 'Error':
      return 'bg-red-500/15 text-red-300 border-red-500/25';
    case 'Warning':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/25';
    case 'Information':
      return 'bg-sky-500/15 text-sky-300 border-sky-500/25';
    case 'Debug':
      return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/25';
    case 'Trace':
      return 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

function severityToggleColor(level: string, active: boolean) {
  if (!active) return 'bg-muted/50 text-muted-foreground/60 border-border/50 hover:bg-muted';
  switch (level) {
    case 'Critical':
      return 'bg-rose-500/20 text-rose-300 border-rose-500/40';
    case 'Error':
      return 'bg-red-500/15 text-red-300 border-red-500/30';
    case 'Warning':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'Information':
      return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
    case 'Debug':
      return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
    case 'Trace':
      return 'bg-zinc-500/10 text-zinc-500 border-zinc-500/25';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

function formatLogEntry(entry: LogEntry) {
  const lines = [
    `[${new Date(entry.timestamp).toLocaleString()}] ${entry.level} ${entry.category}`,
    entry.message,
  ];

  if (entry.exception) {
    lines.push('', entry.exception);
  }

  return lines.join('\n');
}

function fallbackCopyTextToClipboard(text: string) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  textArea.style.pointerEvents = 'none';

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, text.length);

  const copied = document.execCommand('copy');
  document.body.removeChild(textArea);

  if (!copied) {
    throw new Error('Clipboard copy failed.');
  }
}

async function copyTextToClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall back below for browsers or contexts where the async clipboard API is unavailable.
  }

  fallbackCopyTextToClipboard(text);
}

export function LogsPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedLevels, setSelectedLevels] = useState<Set<string>>(() => new Set(defaultSelectedLevels));
  const [searchText, setSearchText] = useState('');
  const [fromDate, setFromDate] = useState(() => toLocalDatetimeString(getDefaultFrom()));
  const [toDate, setToDate] = useState(() => toLocalDatetimeString(new Date()));
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle');

  const fetchLogs = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);

    try {
      const params = new URLSearchParams();

      const activeLevels = Array.from(selectedLevels);
      if (activeLevels.length > 0 && activeLevels.length < severityLevels.length) {
        params.set('levels', activeLevels.join(','));
      }

      if (fromDate) {
        params.set('from', new Date(fromDate).toISOString());
      }

      if (toDate) {
        params.set('to', new Date(toDate).toISOString());
      }

      if (searchText.trim()) {
        params.set('search', searchText.trim());
      }

      params.set('skip', (page * pageSize).toString());
      params.set('take', pageSize.toString());

      const response = await fetch(`/api/logs?${params.toString()}`, { cache: 'no-store' });

      if (!response.ok) {
        throw new Error('Failed to load logs.');
      }

      const data = (await response.json()) as LogQueryResponse;
      setEntries(data.entries);
      setTotalCount(data.totalCount);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load logs.');
    } finally {
      setIsLoading(false);
    }
  }, [selectedLevels, fromDate, toDate, searchText, page]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (copyState === 'idle') {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  const toggleLevel = (level: string) => {
    setSelectedLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
    setPage(0);
  };

  const handleCopyVisibleLogs = async () => {
    try {
      await copyTextToClipboard(entries.map(formatLogEntry).join('\n\n'));
      setCopyState('success');
    } catch {
      setCopyState('error');
    }
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <Card className='border border-border/80 bg-card/85 shadow-sm'>
      <CardHeader className='border-b border-border/60 pb-4'>
        <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
          <div>
            <CardTitle className='flex items-center gap-2'>
              <AlertTriangle className='h-5 w-5 text-muted-foreground' />
              Application logs
            </CardTitle>
            <CardDescription className='mt-1'>
              Browse captured log entries filtered by severity and time range.
            </CardDescription>
          </div>
          <div className='flex items-center gap-2 self-start'>
            <Button
              type='button'
              variant='outline'
              size='icon-sm'
              onClick={() => void handleCopyVisibleLogs()}
              disabled={entries.length === 0}
              aria-label='Copy visible logs to clipboard'
              title={
                copyState === 'success'
                  ? 'Copied visible logs'
                  : copyState === 'error'
                    ? 'Copy failed'
                    : 'Copy visible logs to clipboard'
              }
              className={cn(
                'text-muted-foreground',
                copyState === 'success' && 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/15 hover:text-emerald-200',
                copyState === 'error' && 'text-rose-300 border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/15 hover:text-rose-200',
              )}
            >
              {copyState === 'success' ? (
                <Check />
              ) : copyState === 'error' ? (
                <ClipboardX />
              ) : (
                <Copy />
              )}
            </Button>
            <Button
              type='button'
              variant='outline'
              onClick={() => void fetchLogs()}
              disabled={isLoading}
              className='text-xs text-muted-foreground'
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className='space-y-4 pt-5'>
        {/* Severity filter */}
        <div className='space-y-2'>
          <div className='flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground'>
            <Filter className='h-3.5 w-3.5' />
            Severity
          </div>
          <div className='flex flex-wrap gap-1.5'>
            {severityLevels.map((level) => (
              <button
                key={level}
                onClick={() => toggleLevel(level)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors cursor-pointer',
                  severityToggleColor(level, selectedLevels.has(level))
                )}
              >
                {level}
              </button>
            ))}
          </div>
        </div>

        {/* Time range selectors */}
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-1'>
            <label className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>From</label>
            <input
              type='datetime-local'
              value={fromDate}
              onChange={(e) => { setFromDate(e.target.value); setPage(0); }}
              className='w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30'
            />
          </div>
          <div className='space-y-1'>
            <label className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>To</label>
            <input
              type='datetime-local'
              value={toDate}
              onChange={(e) => { setToDate(e.target.value); setPage(0); }}
              className='w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30'
            />
          </div>
        </div>

        {/* Search */}
        <div className='relative'>
          <Search className='absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
          <input
            type='text'
            placeholder='Search logs by message, category, or exception...'
            value={searchText}
            onChange={(e) => { setSearchText(e.target.value); setPage(0); }}
            className='w-full rounded-lg border border-border bg-background py-2 pl-10 pr-3 text-sm text-foreground outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30'
          />
        </div>

        {/* Results summary */}
        <div className='flex items-center justify-between text-xs text-muted-foreground'>
          <span>{totalCount.toLocaleString()} entries found</span>
          {totalPages > 1 && (
            <div className='flex items-center gap-2'>
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className='rounded p-1 hover:bg-muted disabled:opacity-30'
              >
                <ChevronLeft className='h-4 w-4' />
              </button>
              <span>
                Page {page + 1} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className='rounded p-1 hover:bg-muted disabled:opacity-30'
              >
                <ChevronRight className='h-4 w-4' />
              </button>
            </div>
          )}
        </div>

        {/* Error state */}
        {loadError && (
          <div className='rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive'>
            {loadError}
          </div>
        )}

        {/* Log entries */}
        <div className='space-y-1.5 max-h-[600px] overflow-y-auto'>
          {entries.length === 0 && !isLoading && (
            <div className='rounded-2xl border border-dashed border-border bg-background/40 px-5 py-10 text-center text-sm text-muted-foreground'>
              No log entries match the current filters.
            </div>
          )}

          {entries.map((entry) => (
            <button
              key={entry.id}
              type='button'
              onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
              className='w-full text-left rounded-lg border border-border/60 bg-background/40 px-3 py-2 transition-colors hover:bg-background/70 cursor-pointer'
            >
              <div className='flex items-start gap-3'>
                <span
                  className={cn(
                    'mt-0.5 shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                    severityColor(entry.level)
                  )}
                >
                  {entry.level.substring(0, 4)}
                </span>
                <div className='min-w-0 flex-1'>
                  <div className='flex items-baseline justify-between gap-2'>
                    <span className='truncate text-xs font-mono text-muted-foreground'>{entry.category}</span>
                    <span className='shrink-0 text-[11px] text-muted-foreground/70'>
                      {new Date(entry.timestamp).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className={cn('mt-1 text-sm text-foreground', expandedId !== entry.id && 'truncate')}>
                    {entry.message}
                  </div>
                  {expandedId === entry.id && entry.exception && (
                    <pre className='mt-2 overflow-x-auto rounded-lg bg-muted/50 p-2 text-xs font-mono text-rose-300 whitespace-pre-wrap break-all'>
                      {entry.exception}
                    </pre>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Bottom pagination for long lists */}
        {totalPages > 1 && (
          <div className='flex items-center justify-center gap-2 pt-2 text-xs text-muted-foreground'>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className='rounded p-1 hover:bg-muted disabled:opacity-30'
            >
              <ChevronLeft className='h-4 w-4' />
            </button>
            <span>
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className='rounded p-1 hover:bg-muted disabled:opacity-30'
            >
              <ChevronRight className='h-4 w-4' />
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
