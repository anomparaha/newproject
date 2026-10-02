import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';
import { Nav } from '@/components/Nav';
import { PersonaPicker, PersonaProvider } from '@/components/PersonaProvider';

export const metadata: Metadata = {
  title: 'VIN — cross-border vehicle market',
  description:
    'Listings lock to a chassis number, buyer funds sit in escrow, inspection reports attach to the same number, and every completed deal is recorded as a receipt that cannot be overwritten.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <PersonaProvider>
          <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col lg:flex-row">
            <aside className="w-full shrink-0 border-b border-ink-800 px-5 py-5 lg:w-72 lg:border-b-0 lg:border-r">
              <Link href="/" className="block">
                <div className="flex items-baseline gap-2">
                  <span className="text-xl font-semibold tracking-tight">VIN</span>
                  <span className="text-[0.68rem] uppercase tracking-wider text-mist-400">cross-border vehicle market</span>
                </div>
              </Link>
              <p className="mt-3 text-xs leading-relaxed text-mist-400">
                Vehicle money never moves through a volatile token. The NFT is a receipt and a claim trail. The token is
                collateral and access.
              </p>
              <div className="mt-5">
                <Nav />
              </div>
              <div className="mt-5">
                <PersonaPicker />
              </div>
              <div className="mt-5 rounded-xl border border-ink-700 p-3 text-[0.68rem] leading-relaxed text-mist-400">
                Current stage: <span className="text-signal">Proof Stage</span> — one corridor, mandatory inspection,
                mandatory escrow, receipt NFTs only for completed deals, no public token sale.
              </div>
            </aside>
            <main className="flex-1 px-5 py-6 lg:px-8">{children}</main>
          </div>
        </PersonaProvider>
      </body>
    </html>
  );
}
