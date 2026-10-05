import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import './globals.css';
import { SiteHeader } from '@/components/SiteHeader';
import { SiteFooter } from '@/components/SiteFooter';
import { SessionProvider } from '@/components/SessionProvider';
import { BackToTop } from '@/components/BackToTop';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'VIN — cross-border vehicle market',
  description:
    'Listings lock to a chassis number, buyer funds sit in escrow, inspection reports attach to the same number, and every completed deal is recorded as a receipt that cannot be overwritten.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} min-h-screen bg-canvas font-sans text-body antialiased selection:bg-slate-300 selection:text-slate-950`}>
        <SessionProvider>
          <div className="flex min-h-screen flex-col">
            <SiteHeader />
            <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8 lg:py-10">{children}</main>
            <SiteFooter />
          </div>
        </SessionProvider>
        <BackToTop />
      </body>
    </html>
  );
}
