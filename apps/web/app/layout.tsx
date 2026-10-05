import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';
import { Nav } from '@/components/Nav';
import { AccountButton } from '@/components/AccountButton';
import { SessionProvider } from '@/components/SessionProvider';

export const metadata: Metadata = {
  title: 'VIN — cross-border vehicle market',
  description:
    'Listings lock to a chassis number, buyer funds sit in escrow, inspection reports attach to the same number, and every completed deal is recorded as a receipt that cannot be overwritten.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <SessionProvider>
          <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col lg:flex-row">
            <aside className="w-full shrink-0 border-b border-ink-800 bg-ink-950/60 px-5 py-5 lg:flex lg:w-72 lg:flex-col lg:justify-between lg:border-b-0 lg:border-r">
              <div>
                <Link href="/" className="block">
                  <div className="flex items-center gap-2">
                    <span className="grid h-8 w-8 place-items-center rounded-lg bg-signal/15 text-sm font-semibold text-signal">V</span>
                    <span className="flex flex-col leading-tight">
                      <span className="text-base font-semibold tracking-tight">VIN</span>
                      <span className="text-[0.62rem] uppercase tracking-[0.14em] text-mist-400">cross-border vehicle market</span>
                    </span>
                  </div>
                </Link>
                <div className="mt-4 rounded-xl border border-ink-800 bg-ink-900/40 p-3">
                  <AccountButton />
                  <p className="mt-2 text-[0.62rem] leading-relaxed text-mist-400">
                    Wallet-first identity: connecting a wallet signs a one-time challenge that the API verifies. The
                    demo binding is a local shortcut for the seeded actors and signs nothing.
                  </p>
                </div>
                <div className="mt-5">
                  <Nav />
                </div>
              </div>
              <div className="mt-5 rounded-xl border border-ink-800 bg-ink-900/40 p-3">
                <div className="text-[0.62rem] uppercase tracking-wider text-mist-400">Current stage</div>
                <div className="mt-1 text-sm text-signal">Proof Stage</div>
                <p className="mt-1 text-[0.68rem] leading-relaxed text-mist-400">
                  Multiple corridors, mandatory inspection and escrow, receipt NFTs only for completed deals, no public
                  token sale.
                </p>
              </div>
            </aside>
            <main className="flex-1 px-5 py-6 lg:px-8">{children}</main>
          </div>
        </SessionProvider>
      </body>
    </html>
  );
}
