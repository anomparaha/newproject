import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { Notice } from '@/components/Chips';
import { Timeline } from '@/components/Timeline';
import { dateTime, formatAmount, shortHash } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function VinPage({ params }: { params: Promise<{ vin: string }> }) {
  const { vin } = await params;
  const data = await api.vin(vin);
  if (!data) notFound();

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Vehicle history</h1>
        <div className="hash text-base">{data.vin}</div>
        <p className="text-sm text-mist-400">
          A VIN has an event chain, not a file that gets edited. Old events are never overwritten.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <Notice tone="info" title="Claim boundary">
          {data.claimsBoundary}
        </Notice>
        <Notice tone="warn" title="VIN uniqueness boundary">
          {data.notice}
        </Notice>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wider text-mist-400">Last odometer reading</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            {data.lastOdometer ? `${data.lastOdometer.km.toLocaleString('en-US')} km` : 'none yet'}
          </div>
          {data.anomalies.length > 0 ? (
            <div className="mt-2 text-xs text-alert">
              {data.anomalies.length} odometer anomalies recorded. An anomaly is not an automatic rejection, but a warning
              the buyer must see before funds release.
            </div>
          ) : (
            <div className="mt-2 text-xs text-mist-400">No odometer anomalies.</div>
          )}
        </div>
      </div>

      {data.ifNoData ? <Notice tone="info" title={data.ifNoData} /> : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Event chain</h2>
          <Timeline events={data.events} />
        </section>

        <div className="space-y-6">
          <section className="card p-4">
            <h2 className="text-sm font-medium">Listings on this VIN</h2>
            {data.listings.length === 0 ? (
              <p className="mt-2 text-sm text-mist-400">No listings yet.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.listings.map((listing) => (
                  <li key={listing.id} className="rounded-lg border border-ink-700 p-3 text-sm">
                    <Link href={`/listing/${listing.id}`} className="hover:text-signal">
                      {listing.make} {listing.model} · {listing.year}
                    </Link>
                    <div className="mt-1 text-xs text-mist-400">
                      {formatAmount(listing.priceAmount, listing.priceCurrency)} · status {listing.status}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-medium">Inspection reports</h2>
            {data.reports.length === 0 ? (
              <p className="mt-2 text-sm text-mist-400">No reports yet.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {data.reports.map((report) => (
                  <li key={report.id} className="rounded-lg border border-ink-700 p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-sm">{report.odometerKm.toLocaleString('en-US')} km</span>
                      {report.anomaly ? <span className="chip text-alert border-alert/50">anomaly</span> : null}
                    </div>
                    <div className="hash mt-1">{shortHash(report.reportHash, 20, 12)}</div>
                    <div className="mt-1 text-mist-400">{dateTime(report.inspectedAt)} · standard {report.standardVersion}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-medium">Completion receipts</h2>
            {data.notes.length === 0 ? (
              <p className="mt-2 text-sm text-mist-400">No receipts yet. A receipt is recorded only for completed deals.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {data.notes.map((note) => (
                  <li key={note.id} className="rounded-lg border border-ink-700 p-3 text-xs">
                    <div>{formatAmount(note.priceAmount, note.priceCurrency)}</div>
                    <div className="hash mt-1">root {shortHash(note.evidenceRoot, 20, 12)}</div>
                    <Link href={`/api/notes/${note.id}/metadata`} className="mt-1 inline-block text-signal hover:underline">
                      receipt metadata →
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
