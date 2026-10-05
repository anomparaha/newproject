'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Nav } from '@/components/Nav';
import { AccountButton } from '@/components/AccountButton';
import { Icon } from '@/components/Icons';

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header className="sticky top-0 z-40 border-b border-slate-300 bg-white/95 backdrop-blur-md shadow-2xs">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="group flex shrink-0 items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-900 text-white shadow-xs transition-transform duration-200 group-hover:scale-105">
            <Icon name="shield" className="h-5 w-5 text-white" />
          </span>
          <div className="flex flex-col leading-tight">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-tight text-ink">VIN</span>
              <span className="rounded-md bg-slate-900 px-1.5 py-0.5 text-[0.65rem] font-bold text-white shadow-2xs">
                ESCROW
              </span>
            </div>
            <span className="hidden text-[0.68rem] font-semibold text-muted sm:block">
              Cross-border vehicle protocol
            </span>
          </div>
        </Link>

        <div className="hidden flex-1 md:block">
          <Nav />
        </div>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden xl:flex items-center gap-2 rounded-full border border-slate-300 bg-slate-100 px-3 py-1 text-xs font-bold text-slate-800 shadow-2xs">
            <span className="h-2 w-2 rounded-full bg-emerald-600 animate-pulse" />
            <span>Pilot: UAE → Georgia</span>
          </div>

          <AccountButton />

          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="grid h-10 w-10 place-items-center rounded-xl border border-line text-ink hover:bg-subtle transition-colors md:hidden"
          >
            <Icon name={open ? 'x' : 'menu'} className="h-5 w-5" />
          </button>
        </div>
      </div>

      {open ? (
        <div className="border-t border-line bg-white/95 backdrop-blur-xl md:hidden animate-in slide-in-from-top-2 duration-150">
          <div className="mx-auto max-w-7xl px-4 py-4 space-y-3 sm:px-6">
            <div className="flex items-center gap-2 rounded-lg bg-subtle px-3 py-1.5 text-xs text-muted">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>Pilot Corridor: UAE → Georgia</span>
            </div>
            <Nav vertical />
          </div>
        </div>
      ) : null}
    </header>
  );
}
