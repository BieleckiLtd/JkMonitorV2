import { type ReactNode, useDeferredValue, useEffect, useState } from 'react';
import { LoaderCircle, Search, Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/utils';

type InstalledPackageSummary = {
  name: string;
  version: string;
  architecture: string;
  channel: string;
  status: string;
  isAutomatic: boolean;
};

type ServiceUnitSummary = {
  name: string;
  displayName: string;
  description?: string | null;
  unitFileState: string;
  vendorPreset?: string | null;
  activeState?: string | null;
  subState?: string | null;
  isEnabled: boolean;
  isRunning: boolean;
};

type SystemServicesCatalogSnapshot = {
  supported: boolean;
  statusMessage?: string | null;
  summary: {
    packageCount: number;
    automaticPackageCount: number;
    serviceCount: number;
    enabledServiceCount: number;
    runningServiceCount: number;
  };
  packages: InstalledPackageSummary[];
  services: ServiceUnitSummary[];
};

type SystemServiceInsight = {
  supported: boolean;
  statusMessage?: string | null;
  kind: 'package' | 'service';
  id: string;
  title: string;
  subtitle?: string | null;
  summary?: string | null;
  narrative?: string | null;
  metrics: { label: string; value: string }[];
  facts: { label: string; value: string }[];
  highlights: string[];
  relatedItems: { kind: 'package' | 'service'; id: string; title: string; subtitle?: string | null }[];
};

type SelectedItem = {
  kind: 'package' | 'service';
  id: string;
};

type PackageFilter = 'all' | 'manual' | 'automatic';
type ServiceFilter = 'all' | 'running' | 'enabled' | 'manual';

export function ServicesPage() {
  const [catalog, setCatalog] = useState<SystemServicesCatalogSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<SelectedItem | null>(null);
  const [insightCache, setInsightCache] = useState<Record<string, SystemServiceInsight>>({});
  const [loadingInsightKey, setLoadingInsightKey] = useState<string | null>(null);
  const [insightError, setInsightError] = useState<string | null>(null);
  const [packageQuery, setPackageQuery] = useState('');
  const [serviceQuery, setServiceQuery] = useState('');
  const [packageFilter, setPackageFilter] = useState<PackageFilter>('all');
  const [serviceFilter, setServiceFilter] = useState<ServiceFilter>('all');

  const deferredPackageQuery = useDeferredValue(packageQuery);
  const deferredServiceQuery = useDeferredValue(serviceQuery);

  useEffect(() => {
    let isMounted = true;

    const loadCatalog = async () => {
      try {
        const response = await fetch('/api/system/services/catalog', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Unable to load services and packages.');
        }

        const data = await response.json() as SystemServicesCatalogSnapshot;
        if (!isMounted) {
          return;
        }

        setCatalog(data);
        setLoadError(null);
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setLoadError(error instanceof Error ? error.message : 'Unable to load services and packages.');
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void loadCatalog();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!catalog || selectedItem) {
      return;
    }

    if (catalog.services.length > 0) {
      const preferredService = catalog.services.find((service) => service.isRunning) ?? catalog.services[0];
      setSelectedItem({ kind: 'service', id: preferredService.name });
      return;
    }

    if (catalog.packages.length > 0) {
      setSelectedItem({ kind: 'package', id: catalog.packages[0].name });
    }
  }, [catalog, selectedItem]);

  const selectedKey = selectedItem ? `${selectedItem.kind}:${selectedItem.id}` : null;

  useEffect(() => {
    if (!selectedItem || !selectedKey || insightCache[selectedKey]) {
      return;
    }

    let isMounted = true;

    const loadInsight = async () => {
      setLoadingInsightKey(selectedKey);
      setInsightError(null);

      try {
        const response = await fetch(
          `/api/system/services/insight?kind=${encodeURIComponent(selectedItem.kind)}&id=${encodeURIComponent(selectedItem.id)}`,
          { cache: 'no-store' }
        );

        if (!response.ok) {
          throw new Error('Unable to load package details.');
        }

        const data = await response.json() as SystemServiceInsight;
        if (!isMounted) {
          return;
        }

        setInsightCache((current) => ({ ...current, [selectedKey]: data }));
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setInsightError(error instanceof Error ? error.message : 'Unable to load package details.');
      } finally {
        if (isMounted) {
          setLoadingInsightKey((current) => current === selectedKey ? null : current);
        }
      }
    };

    void loadInsight();

    return () => {
      isMounted = false;
    };
  }, [insightCache, selectedItem, selectedKey]);

  const packageSearch = deferredPackageQuery.trim().toLowerCase();
  const serviceSearch = deferredServiceQuery.trim().toLowerCase();

  const filteredPackages = (catalog?.packages ?? []).filter((pkg) => {
    if (packageFilter === 'manual' && pkg.isAutomatic) {
      return false;
    }

    if (packageFilter === 'automatic' && !pkg.isAutomatic) {
      return false;
    }

    if (!packageSearch) {
      return true;
    }

    return [
      pkg.name,
      pkg.version,
      pkg.architecture,
      pkg.channel,
      pkg.status,
    ].some((value) => value.toLowerCase().includes(packageSearch));
  });

  const filteredServices = (catalog?.services ?? []).filter((service) => {
    if (serviceFilter === 'running' && !service.isRunning) {
      return false;
    }

    if (serviceFilter === 'enabled' && !service.isEnabled) {
      return false;
    }

    if (serviceFilter === 'manual' && service.isEnabled) {
      return false;
    }

    if (!serviceSearch) {
      return true;
    }

    return [
      service.name,
      service.displayName,
      service.description ?? '',
      service.unitFileState,
      service.activeState ?? '',
      service.subState ?? '',
    ].some((value) => value.toLowerCase().includes(serviceSearch));
  });

  const activeInsight = selectedKey ? insightCache[selectedKey] : null;
  const selectedPackage = selectedItem?.kind === 'package'
    ? catalog?.packages.find((pkg) => pkg.name === selectedItem.id) ?? null
    : null;
  const selectedService = selectedItem?.kind === 'service'
    ? catalog?.services.find((service) => service.name === selectedItem.id) ?? null
    : null;

  return (
    <div className='space-y-6 pb-12'>
      <section className='overflow-hidden rounded-[2rem] border border-border/70 bg-[radial-gradient(circle_at_top_left,rgba(184,115,51,0.16),transparent_32%),linear-gradient(135deg,rgba(255,252,245,0.92),rgba(250,246,237,0.98))] p-6 shadow-sm'>
        <div className='flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between'>
          <div className='max-w-2xl space-y-2'>
            <div className='inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-1 text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase'>
              <Sparkles className='h-3.5 w-3.5' />
              Services
            </div>
            <h2 className='font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl'>
              Browse what is installed and what keeps the system moving.
            </h2>
            <p className='max-w-xl text-sm leading-6 text-muted-foreground sm:text-base'>
              Explore installed packages, background services, and plain-English insights without dropping into a terminal.
            </p>
          </div>

          <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
            <SummaryTile label='Installed items' value={catalog?.summary.packageCount ?? 0} />
            <SummaryTile label='Added by dependencies' value={catalog?.summary.automaticPackageCount ?? 0} />
            <SummaryTile label='Services' value={catalog?.summary.serviceCount ?? 0} />
            <SummaryTile label='Running now' value={catalog?.summary.runningServiceCount ?? 0} />
          </div>
        </div>

        {catalog?.statusMessage ? (
          <div className='mt-4 rounded-2xl border border-border/70 bg-background/75 px-4 py-3 text-sm text-muted-foreground'>
            {catalog.statusMessage}
          </div>
        ) : null}
      </section>

      {loadError ? (
        <Card className='border-destructive/20 bg-destructive/5'>
          <CardContent className='py-6 text-sm text-destructive'>{loadError}</CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <Card>
          <CardContent className='flex items-center gap-3 py-10 text-sm text-muted-foreground'>
            <LoaderCircle className='h-4 w-4 animate-spin' />
            Loading packages and services…
          </CardContent>
        </Card>
      ) : null}

      {!isLoading && catalog ? (
        <>
          {!catalog.supported ? (
            <Card>
              <CardHeader>
                <CardTitle>Not available here</CardTitle>
                <CardDescription>
                  {catalog.statusMessage ?? 'This view is designed for Linux hosts where package and service data is available.'}
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <div className='grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(22rem,0.95fr)]'>
              <BrowserCard
                title='Installed packages'
                description='Apps, libraries, and platform pieces currently present on the device.'
                query={packageQuery}
                onQueryChange={setPackageQuery}
                resultCount={filteredPackages.length}
                quickFilters={
                  <>
                    <FilterChip active={packageFilter === 'all'} onClick={() => setPackageFilter('all')}>All</FilterChip>
                    <FilterChip active={packageFilter === 'manual'} onClick={() => setPackageFilter('manual')}>Added by you</FilterChip>
                    <FilterChip active={packageFilter === 'automatic'} onClick={() => setPackageFilter('automatic')}>Supporting items</FilterChip>
                  </>
                }
              >
                {filteredPackages.length > 0 ? (
                  filteredPackages.map((pkg) => {
                    const isActive = selectedItem?.kind === 'package' && selectedItem.id === pkg.name;
                    return (
                      <button
                        key={pkg.name}
                        type='button'
                        onClick={() => setSelectedItem({ kind: 'package', id: pkg.name })}
                        className={cn(
                          'w-full rounded-2xl border px-4 py-3 text-left transition-colors',
                          isActive
                            ? 'border-primary/40 bg-primary/10 shadow-sm'
                            : 'border-border/70 bg-background/70 hover:bg-accent/45'
                        )}
                      >
                        <div className='flex items-start justify-between gap-3'>
                          <div className='min-w-0'>
                            <div className='truncate text-sm font-semibold text-foreground'>{pkg.name}</div>
                            <div className='mt-1 text-xs text-muted-foreground'>
                              {pkg.version} · {pkg.architecture}
                            </div>
                          </div>
                          <Badge variant={pkg.isAutomatic ? 'secondary' : 'outline'}>
                            {pkg.isAutomatic ? 'Supporting' : 'Direct'}
                          </Badge>
                        </div>
                        <div className='mt-3 text-xs text-muted-foreground'>
                          {humanizeChannel(pkg.channel)}
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <EmptyListState message='No packages match this filter.' />
                )}
              </BrowserCard>

              <BrowserCard
                title='Background services'
                description='Long-running helpers and system tasks available on this device.'
                query={serviceQuery}
                onQueryChange={setServiceQuery}
                resultCount={filteredServices.length}
                quickFilters={
                  <>
                    <FilterChip active={serviceFilter === 'all'} onClick={() => setServiceFilter('all')}>All</FilterChip>
                    <FilterChip active={serviceFilter === 'running'} onClick={() => setServiceFilter('running')}>Running now</FilterChip>
                    <FilterChip active={serviceFilter === 'enabled'} onClick={() => setServiceFilter('enabled')}>Starts on its own</FilterChip>
                    <FilterChip active={serviceFilter === 'manual'} onClick={() => setServiceFilter('manual')}>On demand</FilterChip>
                  </>
                }
              >
                {filteredServices.length > 0 ? (
                  filteredServices.map((service) => {
                    const isActive = selectedItem?.kind === 'service' && selectedItem.id === service.name;
                    return (
                      <button
                        key={service.name}
                        type='button'
                        onClick={() => setSelectedItem({ kind: 'service', id: service.name })}
                        className={cn(
                          'w-full rounded-2xl border px-4 py-3 text-left transition-colors',
                          isActive
                            ? 'border-primary/40 bg-primary/10 shadow-sm'
                            : 'border-border/70 bg-background/70 hover:bg-accent/45'
                        )}
                      >
                        <div className='flex items-start justify-between gap-3'>
                          <div className='min-w-0'>
                            <div className='truncate text-sm font-semibold text-foreground'>{service.displayName}</div>
                            <div className='mt-1 truncate text-xs text-muted-foreground'>{service.name}</div>
                          </div>
                          <StateBadge service={service} />
                        </div>
                        <div className='mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground'>
                          <span>{humanizeStartupMode(service.unitFileState)}</span>
                          {service.subState ? <span>· {humanizeState(service.subState)}</span> : null}
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <EmptyListState message='No services match this filter.' />
                )}
              </BrowserCard>

              <InsightCard
                selectedItem={selectedItem}
                selectedPackage={selectedPackage}
                selectedService={selectedService}
                insight={activeInsight}
                insightError={insightError}
                isLoading={loadingInsightKey === selectedKey}
                onSelectRelated={(item) => setSelectedItem(item)}
              />
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function BrowserCard({
  title,
  description,
  query,
  onQueryChange,
  resultCount,
  quickFilters,
  children,
}: {
  title: string;
  description: string;
  query: string;
  onQueryChange: (value: string) => void;
  resultCount: number;
  quickFilters: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className='min-h-[38rem]'>
      <CardHeader className='space-y-4 border-b border-border/70 pb-4'>
        <div className='space-y-1'>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>

        <div className='space-y-3'>
          <div className='relative'>
            <Search className='pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder='Quick filter'
              className='h-10 rounded-xl bg-background pl-9'
            />
          </div>

          <div className='flex flex-wrap gap-2'>{quickFilters}</div>
        </div>
      </CardHeader>

      <CardContent className='flex h-[31rem] flex-col gap-3 overflow-y-auto py-4'>
        <div className='text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>
          {resultCount.toLocaleString()} visible
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function InsightCard({
  selectedItem,
  selectedPackage,
  selectedService,
  insight,
  insightError,
  isLoading,
  onSelectRelated,
}: {
  selectedItem: SelectedItem | null;
  selectedPackage: InstalledPackageSummary | null;
  selectedService: ServiceUnitSummary | null;
  insight: SystemServiceInsight | null;
  insightError: string | null;
  isLoading: boolean;
  onSelectRelated: (item: SelectedItem) => void;
}) {
  const contextualHighlights = [
    ...(selectedPackage?.isAutomatic ? ['Installed automatically to support something else on the system.'] : []),
    ...(selectedService?.isRunning ? ['Active in memory right now.'] : []),
    ...(insight?.highlights ?? []),
  ];

  return (
    <Card className='xl:sticky xl:top-20'>
      <CardHeader className='space-y-3 border-b border-border/70 pb-4'>
        <div className='space-y-1'>
          <CardTitle>What this does</CardTitle>
          <CardDescription>
            Select a package or service to see a simpler explanation, key facts, and related items.
          </CardDescription>
        </div>

        {selectedItem ? (
          <div className='inline-flex w-fit items-center gap-2 rounded-full border border-border/70 bg-muted/50 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>
            {selectedItem.kind === 'package' ? 'Package' : 'Service'}
          </div>
        ) : null}
      </CardHeader>

      <CardContent className='space-y-6 py-5'>
        {!selectedItem ? (
          <EmptyInsightState />
        ) : isLoading && !insight ? (
          <div className='flex items-center gap-3 rounded-2xl border border-border/70 bg-muted/35 px-4 py-4 text-sm text-muted-foreground'>
            <LoaderCircle className='h-4 w-4 animate-spin' />
            Loading insight…
          </div>
        ) : insightError ? (
          <div className='rounded-2xl border border-destructive/25 bg-destructive/5 px-4 py-4 text-sm text-destructive'>
            {insightError}
          </div>
        ) : insight ? (
          <>
            <div className='space-y-2'>
              <div className='text-2xl font-semibold tracking-tight text-foreground'>{insight.title}</div>
              {insight.subtitle ? (
                <div className='text-sm text-muted-foreground'>{insight.subtitle}</div>
              ) : null}
              {insight.summary ? (
                <p className='text-sm leading-6 text-foreground/88'>{insight.summary}</p>
              ) : null}
              {insight.narrative ? (
                <p className='text-sm leading-6 text-muted-foreground'>{insight.narrative}</p>
              ) : null}
            </div>

            {!insight.supported ? (
              <div className='rounded-2xl border border-border/70 bg-muted/35 px-4 py-4 text-sm text-muted-foreground'>
                {insight.statusMessage ?? 'No additional insight is available for this selection.'}
              </div>
            ) : null}

            {insight.metrics.length > 0 ? (
              <div className='grid gap-3 sm:grid-cols-3'>
                {insight.metrics.map((metric) => (
                  <MetricTile key={metric.label} label={metric.label} value={metric.value} />
                ))}
              </div>
            ) : null}

            {contextualHighlights.length > 0 ? (
              <div className='space-y-3'>
                <SectionLabel>At a glance</SectionLabel>
                <div className='space-y-2'>
                  {contextualHighlights.map((highlight) => (
                    <div key={highlight} className='rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm text-foreground/90'>
                      {highlight}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {insight.facts.length > 0 ? (
              <div className='space-y-3'>
                <SectionLabel>Key facts</SectionLabel>
                <div className='space-y-2'>
                  {insight.facts.map((fact) => (
                    <div key={fact.label} className='flex items-start justify-between gap-4 rounded-2xl border border-border/70 bg-background/80 px-4 py-3'>
                      <div className='text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground'>{fact.label}</div>
                      <div className='max-w-[65%] text-right text-sm text-foreground'>{fact.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {insight.relatedItems.length > 0 ? (
              <div className='space-y-3'>
                <SectionLabel>Related</SectionLabel>
                <div className='space-y-2'>
                  {insight.relatedItems.map((item) => (
                    <button
                      key={`${item.kind}:${item.id}`}
                      type='button'
                      onClick={() => onSelectRelated({ kind: item.kind, id: item.id })}
                      className='w-full rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-left transition-colors hover:bg-accent/45'
                    >
                      <div className='flex items-start justify-between gap-3'>
                        <div className='min-w-0'>
                          <div className='truncate text-sm font-semibold text-foreground'>{item.title}</div>
                          {item.subtitle ? (
                            <div className='mt-1 text-xs text-muted-foreground'>{item.subtitle}</div>
                          ) : null}
                        </div>
                        <Badge variant='outline'>{item.kind === 'package' ? 'Package' : 'Service'}</Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyInsightState />
        )}
      </CardContent>
    </Card>
  );
}

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className='rounded-2xl border border-border/70 bg-background/75 px-4 py-3'>
      <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>{label}</div>
      <div className='mt-2 text-2xl font-semibold tracking-tight text-foreground'>{value.toLocaleString()}</div>
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded-2xl border border-border/70 bg-muted/35 px-4 py-4'>
      <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>{label}</div>
      <div className='mt-2 text-base font-semibold text-foreground'>{value}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'border-border/70 bg-background text-muted-foreground hover:bg-accent/45 hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function StateBadge({ service }: { service: ServiceUnitSummary }) {
  if (service.isRunning) {
    return <Badge>Running</Badge>;
  }

  if (service.isEnabled) {
    return <Badge variant='secondary'>Ready</Badge>;
  }

  return <Badge variant='outline'>Manual</Badge>;
}

function EmptyListState({ message }: { message: string }) {
  return (
    <div className='rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground'>
      {message}
    </div>
  );
}

function EmptyInsightState() {
  return (
    <div className='rounded-3xl border border-dashed border-border/70 bg-muted/20 px-6 py-10 text-center'>
      <div className='mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-background text-muted-foreground'>
        <Sparkles className='h-5 w-5' />
      </div>
      <div className='mt-4 text-base font-medium text-foreground'>Pick something to inspect</div>
      <div className='mt-2 text-sm leading-6 text-muted-foreground'>
        The detail panel will explain what the selected item is, how it behaves, and what it connects to.
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>
      {children}
    </div>
  );
}

function humanizeChannel(channel: string) {
  return channel
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part === 'now' ? 'current release' : part)
    .join(' · ');
}

function humanizeState(value: string | null | undefined) {
  if (!value) {
    return 'Unknown';
  }

  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function humanizeStartupMode(value: string) {
  const normalized = value.toLowerCase();

  if (normalized === 'enabled' || normalized === 'enabled-runtime') {
    return 'Starts automatically';
  }

  if (normalized === 'static') {
    return 'Started by another app';
  }

  if (normalized === 'disabled') {
    return 'Starts manually';
  }

  if (normalized === 'masked') {
    return 'Blocked';
  }

  return humanizeState(value);
}
