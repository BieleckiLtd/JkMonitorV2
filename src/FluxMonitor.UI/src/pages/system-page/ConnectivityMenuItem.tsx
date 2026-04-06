import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

type ConnectivityMenuItemProps = {
  title: string;
  summary: string | ReactNode;
  icon: LucideIcon;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  expandButtonLabel?: { collapsed: string; expanded: string };
  toggleControl?: ReactNode;
  children?: ReactNode;
  bodyClassName?: string;
  fullWidthHeaderButton?: boolean;
};

export function ConnectivityMenuItem({
  title,
  summary,
  icon: Icon,
  expanded = false,
  onToggleExpanded,
  expandButtonLabel,
  toggleControl,
  children,
  bodyClassName,
  fullWidthHeaderButton = false,
}: ConnectivityMenuItemProps) {
  const isCollapsible = typeof onToggleExpanded === 'function';

  return (
    <div className='system-menu-card'>
      <div className='system-menu-card-header'>
        {isCollapsible ? (
          <button
            type='button'
            onClick={onToggleExpanded}
            className={cn('system-menu-card-trigger', fullWidthHeaderButton && 'w-full')}
            aria-expanded={expanded}
          >
            <div className='system-menu-card-icon'>
              <Icon className='h-4 w-4 text-muted-foreground' />
            </div>
            <div className='min-w-0 flex-1'>
              <div className='system-menu-card-title'>{title}</div>
              <div className='system-menu-card-summary'>{summary}</div>
            </div>
            {!toggleControl ? (
              <div className='pl-3 text-muted-foreground'>
                {expanded ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
              </div>
            ) : null}
          </button>
        ) : (
          <div className='system-menu-card-trigger'>
            <div className='system-menu-card-icon'>
              <Icon className='h-4 w-4 text-muted-foreground' />
            </div>
            <div className='min-w-0 flex-1'>
              <div className='system-menu-card-title'>{title}</div>
              <div className='system-menu-card-summary'>{summary}</div>
            </div>
          </div>
        )}

        {toggleControl ? <div className='system-menu-card-action'>{toggleControl}</div> : null}

        {isCollapsible && toggleControl ? (
          <button
            type='button'
            onClick={onToggleExpanded}
            className='system-menu-card-chevron'
            aria-label={expanded ? expandButtonLabel?.expanded : expandButtonLabel?.collapsed}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
          </button>
        ) : null}
      </div>

      {isCollapsible && expanded ? (
        <div className={cn('system-menu-card-body', bodyClassName)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
