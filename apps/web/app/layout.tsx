import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';
import { Nav } from '@/components/Nav';
import { PersonaPicker, PersonaProvider } from '@/components/PersonaProvider';

export const metadata: Metadata = {
  title: 'VIN — pasar kendaraan lintas negara',
  description:
    'Listing terkunci, dana di escrow, laporan inspeksi menempel pada nomor rangka, deal selesai dicatat sebagai bukti digital yang tidak bisa ditimpa.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body className="min-h-screen">
        <PersonaProvider>
          <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col lg:flex-row">
            <aside className="w-full shrink-0 border-b border-ink-800 px-5 py-5 lg:w-72 lg:border-b-0 lg:border-r">
              <Link href="/" className="block">
                <div className="flex items-baseline gap-2">
                  <span className="text-xl font-semibold tracking-tight">VIN</span>
                  <span className="text-[0.68rem] uppercase tracking-wider text-mist-400">pasar kendaraan lintas negara</span>
                </div>
              </Link>
              <p className="mt-3 text-xs leading-relaxed text-mist-400">
                Uang kendaraan tidak lewat token volatil. NFT hanya nota dan jejak klaim. Token hanya jaminan dan akses.
              </p>
              <div className="mt-5">
                <Nav />
              </div>
              <div className="mt-5">
                <PersonaPicker />
              </div>
              <div className="mt-5 rounded-xl border border-ink-700 p-3 text-[0.68rem] leading-relaxed text-mist-400">
                Tahap saat ini: <span className="text-signal">Tahap Bukti</span> — satu koridor, inspeksi wajib, escrow wajib,
                NFT nota hanya untuk deal selesai, belum ada penjualan token ke publik.
              </div>
            </aside>
            <main className="flex-1 px-5 py-6 lg:px-8">{children}</main>
          </div>
        </PersonaProvider>
      </body>
    </html>
  );
}
