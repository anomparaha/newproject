'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/listings', label: 'Listings' },
  { href: '/inspectors', label: 'Inspection Market' },
  { href: '/corridors', label: 'Corridors' },
  { href: '/policy', label: 'Policy & Stages' },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {LINKS.map((link) => {
        const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-lg px-3 py-2 text-sm transition-colors ${
              active ? 'bg-ink-800 text-paper' : 'text-mist-400 hover:bg-ink-850 hover:text-paper'
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
