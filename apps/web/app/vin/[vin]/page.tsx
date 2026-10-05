import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { Badge, Notice, PageHeader } from '@/components/Chips';
import { Icon } from '@/components/Icons';
import { Timeline } from '@/components/Timeline';
import { dateTime, formatAmount, shortHash } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function VinPage({ params }: { params: Promise<{ vin: string }> }) {
  const { vin } = await params;
  const data = await api.vin(vin);
  if (!data) notFound();

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Cryptographic Chassis Ledger"
        title={
          <span className="font-mono text-2xl tracking-tight sm:text-3xl text-ink font-bold">
            {data.vin}
          </span>
        }
        description="A chassis identity is an append-only cryptographic event chain, not an editable file. Historical entries are mathematically anchored and cannot be erased."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Notice tone="info" title="Claim Boundary Scope">
          {data.claimsBoundary}
        </Notice>
        <Notice tone="warn" title="On-Chain VIN Specifics">
          {data.notice}
        </Notice>
        <div className="card p-5 bg-white shadow-xs space-y-2">
          <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
            <Icon name="gauge" className="h-4 w-4 text-brand-600" />
            <span>Latest Odometer Evidence</span>
          </div>
          <div className="text-3xl font-extrabold tabular-nums tracking-tight text-ink">
            {data.lastOdometer ? `${data.lastOdometer.km.toLocaleString('en-US')} km` : 'None Recorded'}
          </div>
          {data.anomalies.length > 0 ? (
            <p className="text-xs leading-relaxed text-bad font-medium pt-1">
              ⚠️ {data.anomalies.length} rollback anomaly flagged in history. Buyer must explicitly acknowledge before escrow payout.
            </p>
          ) : (
            <p className="text-xs text-ok font-medium pt-1">✓ No odometer anomalies flagged.</p>
          )}
        </div>
      </div>

      {data.ifNoData ? <Notice tone="info" title={data.ifNoData} /> : null}

      <div className="grid gap-8 lg:grid-cols-[1.75fr_1fr]">
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold tracking-tight text-ink">Chassis Timeline History</h2>
            <Badge tone="ok">Append-Only Audit Log</Badge>
          </div>
          <Timeline events={data.events} />
        </section>

        <div className="space-y-6">
          <section className="card p-5 bg-white shadow-xs space-y-3">
            <h2 className="text-sm font-bold text-ink uppercase tracking-wider">Listings on this Chassis</h2>
            {data.listings.length === 0 ? (
              <p className="text-xs text-muted py-2">No active marketplace listings.</p>
            ) : (
              <ul className="space-y-2.5">
                {data.listings.map((listing) => (
                  <li
                    key={listing.id}
                    className="rounded-xl border border-slate-300 p-3.5 text-xs transition-colors hover:border-slate-400 hover:bg-slate-50"
                  >
                    <Link href={`/listing/${listing.id}`} className="font-bold text-ink hover:text-black block text-sm">
                      {listing.make} {listing.model} · {listing.year}
                    </Link>
                    <div className="mt-1 flex items-center justify-between text-muted">
                      <span className="tabular-nums font-semibold text-ink">
                        {formatAmount(listing.priceAmount, listing.priceCurrency)}
                      </span>
                      <span className="capitalize">{listing.status}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-5 bg-white shadow-xs space-y-3">
            <h2 className="text-sm font-bold text-ink uppercase tracking-wider">Inspection Submissions</h2>
            {data.reports.length === 0 ? (
              <p className="text-xs text-muted py-2">No verified physical reports uploaded.</p>
            ) : (
              <ul className="space-y-2.5">
                {data.reports.map((report) => (
                  <li key={report.id} className="rounded-xl border border-line bg-subtle/50 p-3.5 text-xs space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold tabular-nums text-ink text-sm">
                        {report.odometerKm.toLocaleString('en-US')} km
                      </span>
                      {report.anomaly ? <Badge tone="bad">Anomaly</Badge> : <Badge tone="ok">Normal</Badge>}
                    </div>
                    <div className="hash text-[0.7rem]">{shortHash(report.reportHash, 14, 8)}</div>
                    <div className="text-[0.7rem] text-muted">
                      {dateTime(report.inspectedAt)} · {report.standardVersion}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-5 bg-white shadow-xs space-y-3">
            <h2 className="text-sm font-bold text-ink uppercase tracking-wider">Completion Receipts</h2>
            {data.notes.length === 0 ? (
              <p className="text-xs text-muted py-2">
                No receipts generated yet. Issued exclusively upon completed deals.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {data.notes.map((note) => (
                  <li key={note.id} className="rounded-xl border border-line bg-subtle/50 p-3.5 text-xs space-y-1.5">
                    <div className="font-bold tabular-nums text-ink text-sm">
                      {formatAmount(note.priceAmount, note.priceCurrency)}
                    </div>
                    <div className="hash text-[0.7rem]">Root: {shortHash(note.evidenceRoot, 14, 8)}</div>
                    <Link
                      href={`/api/notes/${note.id}/metadata`}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700"
                    >
                      <span>Receipt Metadata</span>
                      <Icon name="arrow" className="h-3 w-3" />
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
