import { type ReactNode, useDeferredValue, useEffect, useState } from 'react';
import { LoaderCircle, Package2, Search, ServerCog, Sparkles, Square } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
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

type SystemServicesSnapshot = {
  supported: boolean;
  statusMessage?: string | null;
  serviceCount: number;
  enabledServiceCount: number;
  runningServiceCount: number;
  services: ServiceUnitSummary[];
};

type SystemPackagesSnapshot = {
  supported: boolean;
  statusMessage?: string | null;
  packageCount: number;
  automaticPackageCount: number;
  packages: InstalledPackageSummary[];
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

type ServiceCommandResponse = {
  success: boolean;
  message: string;
  service?: ServiceUnitSummary | null;
};

type SelectedItem = {
  kind: 'package' | 'service';
  id: string;
};

type Tab = 'services' | 'packages';
type PackageFilter = 'all' | 'manual' | 'automatic';
type ServiceFilter = 'all' | 'running' | 'enabled' | 'manual';

export function ServicesPage() {
  const [activeTab, setActiveTab] = useState<Tab>('services');
  const [servicesSnapshot, setServicesSnapshot] = useState<SystemServicesSnapshot | null>(null);
  const [packagesSnapshot, setPackagesSnapshot] = useState<SystemPackagesSnapshot | null>(null);
  const [isLoadingServices, setIsLoadingServices] = useState(true);
  const [isLoadingPackages, setIsLoadingPackages] = useState(false);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [packagesError, setPackagesError] = useState<string | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null);
  const [insightCache, setInsightCache] = useState<Record<string, SystemServiceInsight>>({});
  const [loadingInsightKey, setLoadingInsightKey] = useState<string | null>(null);
  const [insightError, setInsightError] = useState<string | null>(null);
  const [stoppingServiceName, setStoppingServiceName] = useState<string | null>(null);
  const [serviceActionError, setServiceActionError] = useState<string | null>(null);
  const [packageQuery, setPackageQuery] = useState('');
  const [serviceQuery, setServiceQuery] = useState('');
  const [packageFilter, setPackageFilter] = useState<PackageFilter>('all');
  const [serviceFilter, setServiceFilter] = useState<ServiceFilter>('all');

  const deferredPackageQuery = useDeferredValue(packageQuery);
  const deferredServiceQuery = useDeferredValue(serviceQuery);

  useEffect(() => {
    let isMounted = true;

    const loadServices = async () => {
      try {
        const response = await fetch('/api/system/services', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Unable to load services.');
        }

        const data = await response.json() as SystemServicesSnapshot;
        if (!isMounted) {
          return;
        }

        setServicesSnapshot(data);
        setServicesError(null);
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setServicesError(error instanceof Error ? error.message : 'Unable to load services.');
      } finally {
        if (isMounted) {
          setIsLoadingServices(false);
        }
      }
    };

    void loadServices();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (activeTab !== 'packages' || packagesSnapshot) {
      return;
    }

    let isMounted = true;

    const loadPackages = async () => {
      setIsLoadingPackages(true);

      try {
        const response = await fetch('/api/system/packages', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Unable to load packages.');
        }

        const data = await response.json() as SystemPackagesSnapshot;
        if (!isMounted) {
          return;
        }

        setPackagesSnapshot(data);
        setPackagesError(null);
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setPackagesError(error instanceof Error ? error.message : 'Unable to load packages.');
      } finally {
        if (isMounted) {
          setIsLoadingPackages(false);
        }
      }
    };

    void loadPackages();

    return () => {
      isMounted = false;
    };
  }, [activeTab, packagesSnapshot]);

  const selectedItem = activeTab === 'services'
    ? (selectedServiceId ? { kind: 'service', id: selectedServiceId } satisfies SelectedItem : null)
    : (selectedPackageId ? { kind: 'package', id: selectedPackageId } satisfies SelectedItem : null);
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
          { cache: 'no-store' },
        );

        if (!response.ok) {
          throw new Error(`Unable to load ${selectedItem.kind} details.`);
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

        setInsightError(error instanceof Error ? error.message : `Unable to load ${selectedItem.kind} details.`);
      } finally {
        if (isMounted) {
          setLoadingInsightKey((current) => (current === selectedKey ? null : current));
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

  const filteredPackages = (packagesSnapshot?.packages ?? []).filter((pkg) => {
    if (packageFilter === 'manual' && pkg.isAutomatic) {
      return false;
    }

    if (packageFilter === 'automatic' && !pkg.isAutomatic) {
      return false;
    }

    if (!packageSearch) {
      return true;
    }

    return [pkg.name, pkg.version, pkg.architecture, pkg.channel, pkg.status].some((value) =>
      value.toLowerCase().includes(packageSearch),
    );
  });

  const filteredServices = (servicesSnapshot?.services ?? []).filter((service) => {
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
  const selectedPackage = selectedPackageId
    ? packagesSnapshot?.packages.find((pkg) => pkg.name === selectedPackageId) ?? null
    : null;
  const selectedService = selectedServiceId
    ? servicesSnapshot?.services.find((service) => service.name === selectedServiceId) ?? null
    : null;
  const activeStatusMessage = activeTab === 'services' ? servicesSnapshot?.statusMessage : packagesSnapshot?.statusMessage;
  const activeLoadError = activeTab === 'services' ? servicesError : packagesError;
  const isActiveTabLoading = activeTab === 'services' ? isLoadingServices : isLoadingPackages;
  const isSplitView = selectedItem !== null;

  const handleSelectService = (serviceId: string) => {
    setActiveTab('services');
    setSelectedServiceId(serviceId);
    setInsightError(null);
    setServiceActionError(null);
  };

  const handleSelectPackage = (packageId: string) => {
    setActiveTab('packages');
    setSelectedPackageId(packageId);
    setInsightError(null);
  };

  const handleSelectRelated = (item: SelectedItem) => {
    if (item.kind === 'service') {
      handleSelectService(item.id);
      return;
    }

    handleSelectPackage(item.id);
  };

  const handleStopService = async (serviceName: string) => {
    setStoppingServiceName(serviceName);
    setServiceActionError(null);

    try {
      const response = await fetch('/api/system/services/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: serviceName }),
      });

      const result = await response.json() as ServiceCommandResponse;
      if (!response.ok || !result.success) {
        throw new Error(result.message || `Unable to stop ${serviceName}.`);
      }

      const updatedService = result.service;
      if (updatedService) {
        setServicesSnapshot((current) => current ? applyServiceUpdate(current, updatedService) : current);
      }

      const insightKey = `service:${serviceName}`;
      setInsightCache((current) => {
        if (!(insightKey in current)) {
          return current;
        }

        const next = { ...current };
        delete next[insightKey];
        return next;
      });
      setInsightError(null);
    } catch (error) {
      setServiceActionError(error instanceof Error ? error.message : `Unable to stop ${serviceName}.`);
    } finally {
      setStoppingServiceName(null);
    }
  };

  return (
    <div className='flex min-h-full flex-col gap-5 pb-8'>
      <div className='flex flex-wrap items-center gap-2'>
        <PageTabButton active={activeTab === 'services'} icon={ServerCog} label='Services' onClick={() => setActiveTab('services')} />
        <PageTabButton active={activeTab === 'packages'} icon={Package2} label='Packages' onClick={() => setActiveTab('packages')} />
      </div>

      {activeStatusMessage ? (
        <Card className='border border-border/70 bg-card/95 shadow-sm'>
          <CardContent className='py-4 text-sm text-muted-foreground'>{activeStatusMessage}</CardContent>
        </Card>
      ) : null}

      {activeLoadError ? (
        <Card className='border border-destructive/25 bg-destructive/5'>
          <CardContent className='py-6 text-sm text-destructive'>{activeLoadError}</CardContent>
        </Card>
      ) : null}

      {isActiveTabLoading ? (
        <Card className='border border-border/70 bg-card/95 shadow-sm'>
          <CardContent className='flex items-center gap-3 py-10 text-sm text-muted-foreground'>
            <LoaderCircle className='h-4 w-4 animate-spin' />
            {activeTab === 'services' ? 'Loading services…' : 'Loading packages…'}
          </CardContent>
        </Card>
      ) : null}

      {!isActiveTabLoading && activeTab === 'services' && servicesSnapshot ? (
        !servicesSnapshot.supported ? (
          <Card className='border border-border/70 bg-card/95 shadow-sm'>
            <CardHeader>
              <CardTitle>Not available here</CardTitle>
              <CardDescription>
                {servicesSnapshot.statusMessage ?? 'This view is designed for Linux hosts where service data is available.'}
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className={cn('grid items-start gap-5', isSplitView ? 'xl:grid-cols-2' : 'grid-cols-1')}>
            <BrowserCard
              title='Services'
              description='Long-running helpers and system tasks available on this device.'
              icon={ServerCog}
              query={serviceQuery}
              onQueryChange={setServiceQuery}
              resultCount={filteredServices.length}
              quickFilters={(
                <>
                  <FilterChip active={serviceFilter === 'all'} onClick={() => setServiceFilter('all')}>All</FilterChip>
                  <FilterChip active={serviceFilter === 'running'} onClick={() => setServiceFilter('running')}>Running now</FilterChip>
                  <FilterChip active={serviceFilter === 'enabled'} onClick={() => setServiceFilter('enabled')}>Starts on its own</FilterChip>
                  <FilterChip active={serviceFilter === 'manual'} onClick={() => setServiceFilter('manual')}>On demand</FilterChip>
                </>
              )}
            >
              {filteredServices.length > 0 ? (
                filteredServices.map((service) => {
                  const isActive = selectedServiceId === service.name;
                  return (
                    <button
                      key={service.name}
                      type='button'
                      onClick={() => handleSelectService(service.name)}
                      className={cn(
                        'w-full rounded-xl border px-4 py-4 text-left transition-colors',
                        isActive
                          ? 'border-primary/35 bg-primary/8 shadow-sm'
                          : 'border-border/70 bg-background/65 hover:bg-accent/40',
                      )}
                    >
                      <div className='flex items-start justify-between gap-3'>
                        <div className='min-w-0 space-y-1'>
                          <div className='truncate text-sm font-semibold text-foreground'>{service.displayName}</div>
                          <div className='truncate text-xs text-muted-foreground'>{service.name}</div>
                        </div>
                        <StateBadge service={service} />
                      </div>
                      <div className='mt-3 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground'>
                        <span>{humanizeStartupMode(service.unitFileState)}</span>
                        {service.subState ? <span>• {humanizeState(service.subState)}</span> : null}
                      </div>
                    </button>
                  );
                })
              ) : (
                <EmptyListState message='No services match this filter.' />
              )}
            </BrowserCard>

            {selectedItem ? (
              <InsightCard
                selectedItem={selectedItem}
                selectedPackage={selectedPackage}
                selectedService={selectedService}
                insight={activeInsight}
                insightError={insightError}
                isLoading={loadingInsightKey === selectedKey}
                serviceActionError={serviceActionError}
                isStoppingService={stoppingServiceName === selectedService?.name}
                onSelectRelated={handleSelectRelated}
                onStopService={selectedService?.isRunning ? () => handleStopService(selectedService.name) : null}
              />
            ) : null}
          </div>
        )
      ) : null}

      {!isActiveTabLoading && activeTab === 'packages' && packagesSnapshot ? (
        !packagesSnapshot.supported ? (
          <Card className='border border-border/70 bg-card/95 shadow-sm'>
            <CardHeader>
              <CardTitle>Not available here</CardTitle>
              <CardDescription>
                {packagesSnapshot.statusMessage ?? 'This view is designed for Linux hosts where package data is available.'}
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className={cn('grid items-start gap-5', isSplitView ? 'xl:grid-cols-2' : 'grid-cols-1')}>
            <BrowserCard
              title='Packages'
              description='Apps, libraries, and platform pieces currently present on the device.'
              icon={Package2}
              query={packageQuery}
              onQueryChange={setPackageQuery}
              resultCount={filteredPackages.length}
              quickFilters={(
                <>
                  <FilterChip active={packageFilter === 'all'} onClick={() => setPackageFilter('all')}>All</FilterChip>
                  <FilterChip active={packageFilter === 'manual'} onClick={() => setPackageFilter('manual')}>Added by you</FilterChip>
                  <FilterChip active={packageFilter === 'automatic'} onClick={() => setPackageFilter('automatic')}>Supporting items</FilterChip>
                </>
              )}
            >
              {filteredPackages.length > 0 ? (
                filteredPackages.map((pkg) => {
                  const isActive = selectedPackageId === pkg.name;
                  return (
                    <button
                      key={pkg.name}
                      type='button'
                      onClick={() => handleSelectPackage(pkg.name)}
                      className={cn(
                        'w-full rounded-xl border px-4 py-4 text-left transition-colors',
                        isActive
                          ? 'border-primary/35 bg-primary/8 shadow-sm'
                          : 'border-border/70 bg-background/65 hover:bg-accent/40',
                      )}
                    >
                      <div className='flex items-start justify-between gap-3'>
                        <div className='min-w-0 space-y-1'>
                          <div className='truncate text-sm font-semibold text-foreground'>{pkg.name}</div>
                          <div className='text-xs text-muted-foreground'>
                            {pkg.version} · {pkg.architecture}
                          </div>
                        </div>
                        <PackageKindBadge isAutomatic={pkg.isAutomatic} />
                      </div>
                      <div className='mt-3 text-xs text-muted-foreground'>{humanizeChannel(pkg.channel)}</div>
                    </button>
                  );
                })
              ) : (
                <EmptyListState message='No packages match this filter.' />
              )}
            </BrowserCard>

            {selectedItem ? (
              <InsightCard
                selectedItem={selectedItem}
                selectedPackage={selectedPackage}
                selectedService={selectedService}
                insight={activeInsight}
                insightError={insightError}
                isLoading={loadingInsightKey === selectedKey}
                serviceActionError={serviceActionError}
                isStoppingService={false}
                onSelectRelated={handleSelectRelated}
                onStopService={null}
              />
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

function BrowserCard({
  title,
  description,
  icon: Icon,
  query,
  onQueryChange,
  resultCount,
  quickFilters,
  children,
}: {
  title: string;
  description: string;
  icon: typeof Package2;
  query: string;
  onQueryChange: (value: string) => void;
  resultCount: number;
  quickFilters: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className='border border-border/70 bg-card/95 shadow-sm'>
      <CardHeader className='space-y-4 border-b border-border/70 pb-5'>
        <div className='flex flex-wrap items-start justify-between gap-4'>
          <div className='space-y-1.5'>
            <div className='flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>
              <Icon className='h-3.5 w-3.5 text-primary' />
              Browser
            </div>
            <div className='space-y-1'>
              <CardTitle>{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
          </div>

          <div className='rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-right'>
            <div className='text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>Visible</div>
            <div className='mt-1 text-lg font-semibold tracking-tight text-foreground'>{resultCount.toLocaleString()}</div>
          </div>
        </div>

        <div className='space-y-3'>
          <div className='relative'>
            <Search className='pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder='Quick filter'
              className='h-7 rounded-lg bg-background/75 pl-8'
            />
          </div>

          <div className='flex flex-wrap gap-2'>{quickFilters}</div>
        </div>
      </CardHeader>

      <CardContent className='space-y-3 pt-5'>{children}</CardContent>
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
  serviceActionError,
  isStoppingService,
  onSelectRelated,
  onStopService,
}: {
  selectedItem: SelectedItem;
  selectedPackage: InstalledPackageSummary | null;
  selectedService: ServiceUnitSummary | null;
  insight: SystemServiceInsight | null;
  insightError: string | null;
  isLoading: boolean;
  serviceActionError: string | null;
  isStoppingService: boolean;
  onSelectRelated: (item: SelectedItem) => void;
  onStopService: (() => void) | null;
}) {
  const contextualHighlights = [
    ...(selectedPackage?.isAutomatic ? ['Installed automatically to support something else on the system.'] : []),
    ...(selectedService?.isRunning ? ['Active in memory right now.'] : []),
    ...(insight?.highlights ?? []),
  ];

  return (
    <Card className='border border-border/70 bg-card/95 shadow-sm xl:sticky xl:top-20'>
      <CardContent className='space-y-5 pt-5'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='inline-flex w-fit items-center gap-2 rounded-lg border border-border/70 bg-background/70 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>
            <Sparkles className='h-3.5 w-3.5 text-primary' />
            {selectedItem.kind === 'package' ? 'Package insight' : 'Service insight'}
          </div>

          {onStopService ? (
            <Button variant='destructive' size='sm' onClick={onStopService} disabled={isStoppingService}>
              {isStoppingService ? <LoaderCircle className='h-3.5 w-3.5 animate-spin' /> : <Square className='h-3.5 w-3.5' />}
              {isStoppingService ? 'Stopping…' : 'Stop service'}
            </Button>
          ) : null}
        </div>

        {isLoading && !insight ? (
          <div className='flex items-center gap-3 rounded-xl border border-border/70 bg-muted/30 px-4 py-4 text-sm text-muted-foreground'>
            <LoaderCircle className='h-4 w-4 animate-spin' />
            Loading insight…
          </div>
        ) : insightError ? (
          <div className='rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-4 text-sm text-destructive'>
            {insightError}
          </div>
        ) : insight ? (
          <div className='space-y-6'>
            <div className='space-y-2'>
              <div className='break-words text-2xl font-semibold tracking-tight text-foreground'>{insight.title}</div>
              {insight.subtitle ? <div className='break-words text-sm text-muted-foreground'>{insight.subtitle}</div> : null}
              {insight.summary ? <p className='text-sm leading-6 text-foreground/90'>{insight.summary}</p> : null}
              {insight.narrative ? <p className='text-sm leading-6 text-muted-foreground'>{insight.narrative}</p> : null}
            </div>

            {serviceActionError ? (
              <div className='rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-4 text-sm text-destructive'>
                {serviceActionError}
              </div>
            ) : null}

            {!insight.supported ? (
              <div className='rounded-xl border border-border/70 bg-muted/30 px-4 py-4 text-sm text-muted-foreground'>
                {insight.statusMessage ?? 'No additional insight is available for this selection.'}
              </div>
            ) : null}

            {insight.metrics.length > 0 ? (
              <div className='grid gap-3 sm:grid-cols-2'>
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
                    <div key={highlight} className='rounded-xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-foreground/90'>
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
                    <div key={fact.label} className='rounded-xl border border-border/70 bg-background/70 px-4 py-3'>
                      <div className='grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start'>
                        <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>{fact.label}</div>
                        <div className='break-words text-sm text-foreground'>{fact.value}</div>
                      </div>
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
                      className='w-full rounded-xl border border-border/70 bg-background/70 px-4 py-3 text-left transition-colors hover:bg-accent/40'
                    >
                      <div className='flex items-start justify-between gap-3'>
                        <div className='min-w-0'>
                          <div className='truncate text-sm font-semibold text-foreground'>{item.title}</div>
                          {item.subtitle ? <div className='mt-1 break-words text-xs text-muted-foreground'>{item.subtitle}</div> : null}
                        </div>
                        <Badge variant='outline' className='rounded-lg bg-background/80'>
                          {item.kind === 'package' ? 'Package' : 'Service'}
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyInsightState />
        )}
      </CardContent>
    </Card>
  );
}

function PageTabButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof ServerCog;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className='h-4 w-4' />
      {label}
    </button>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className='min-w-0 rounded-xl border border-border/70 bg-background/70 px-4 py-4'>
      <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>{label}</div>
      <div className='mt-2 break-words text-base font-semibold text-foreground'>{value}</div>
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
        'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'border-border/70 bg-background/70 text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function StateBadge({ service }: { service: ServiceUnitSummary }) {
  if (service.isRunning) {
    return <Badge className='rounded-lg border border-emerald-500/30 bg-emerald-500/12 text-emerald-600 dark:text-emerald-300'>Running</Badge>;
  }

  if (service.isEnabled) {
    return <Badge variant='secondary' className='rounded-lg border border-border/70 bg-secondary/75'>Ready</Badge>;
  }

  return <Badge variant='outline' className='rounded-lg bg-background/80'>Manual</Badge>;
}

function PackageKindBadge({ isAutomatic }: { isAutomatic: boolean }) {
  if (isAutomatic) {
    return <Badge variant='secondary' className='rounded-lg border border-border/70 bg-secondary/75'>Supporting</Badge>;
  }

  return <Badge variant='outline' className='rounded-lg bg-background/80'>Direct</Badge>;
}

function EmptyListState({ message }: { message: string }) {
  return (
    <div className='rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground'>
      {message}
    </div>
  );
}

function EmptyInsightState() {
  return (
    <div className='rounded-xl border border-dashed border-border/70 bg-muted/20 px-6 py-10 text-center'>
      <div className='mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-background/80 text-muted-foreground'>
        <Sparkles className='h-5 w-5' />
      </div>
      <div className='mt-4 text-base font-medium text-foreground'>Pick something to inspect</div>
      <div className='mt-2 text-sm leading-6 text-muted-foreground'>
        Insight stays hidden until you click a service or package.
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>{children}</div>;
}

function applyServiceUpdate(snapshot: SystemServicesSnapshot, service: ServiceUnitSummary): SystemServicesSnapshot {
  const services = snapshot.services.map((current) => current.name === service.name ? service : current);
  services.sort((left, right) => {
    if (left.isRunning !== right.isRunning) {
      return left.isRunning ? -1 : 1;
    }

    if (left.isEnabled !== right.isEnabled) {
      return left.isEnabled ? -1 : 1;
    }

    const byDisplayName = left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' });
    if (byDisplayName !== 0) {
      return byDisplayName;
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });

  return {
    ...snapshot,
    serviceCount: services.length,
    enabledServiceCount: services.filter((current) => current.isEnabled).length,
    runningServiceCount: services.filter((current) => current.isRunning).length,
    services,
  };
}

function humanizeChannel(channel: string) {
  return channel
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part === 'now' ? 'current release' : part))
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
