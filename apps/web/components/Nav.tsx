'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const NAV_LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/listings', label: 'Listings' },
  { href: '/inspectors', label: 'Inspectors' },
  { href: '/corridors', label: 'Corridors' },
  { href: '/policy', label: 'Policy' },
];

export function Nav({ vertical = false }: { vertical?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className={vertical ? 'flex flex-col gap-1.5' : 'flex items-center gap-1.5'} aria-label="Main">
      {NAV_LINKS.map((link) => {
        const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-xl px-3.5 py-1.5 text-xs font-bold transition-all duration-150 ${
              active
                ? 'bg-slate-900 text-white shadow-2xs'
                : 'text-slate-700 hover:bg-slate-100 hover:text-slate-950 font-semibold'
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
