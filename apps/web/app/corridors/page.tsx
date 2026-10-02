import { api } from '@/lib/api';
import { Metric, Notice } from '@/components/Chips';
import { percent } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function CorridorsPage() {
  const corridors = await api.corridors();

  if (!corridors) {
    return <Notice tone="warn" title="API is not running">Run <code>npm run dev:api</code>.</Notice>;
  }

  const details = await Promise.all(
    corridors.corridors.map(async (corridor) => ({
      corridor,
      result: await api.corridorMetrics(corridor.id),
    })),
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Corridors</h1>
        <p className="max-w-3xl text-sm text-mist-400">
          The first corridor is deliberately narrow. A new corridor only opens once the completed-deal rate and the
          dispute rate in the old one are under control.
        </p>
      </header>

      {details.map(({ corridor, result }) => (
        <section key={corridor.id} className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">
              {corridor.originCountry} → {corridor.destinationCountry}
            </h2>
            <span className={`chip ${corridor.status === 'pilot' ? 'text-signal border-signal/40' : 'text-mist-300'}`}>{corridor.status}</span>
            <span className="text-xs text-mist-400">
              minimum value USD {corridor.minVehiclePriceUsd.toLocaleString('en-US')} · {corridor.allowedCurrencies.join(', ')}
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Deals completed" value={String(result?.metrics.dealsCompleted ?? 0)} />
            <Metric
              label="Median time to report"
              value={result?.metrics.medianHoursToReport !== null && result?.metrics.medianHoursToReport !== undefined ? `${result.metrics.medianHoursToReport}h` : '-'}
            />
            <Metric label="Dispute rate" value={percent(result?.metrics.disputeRate ?? 0, 1)} />
            <Metric label="Open odometer anomalies" value={String(result?.metrics.unexplainedOdometerAnomalies ?? 0)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card p-4">
              <h3 className="text-sm font-medium">Corridor health</h3>
              <ul className="mt-3 space-y-2 text-sm">
                <li className="flex justify-between">
                  <span className="text-mist-300">Sellers returning</span>
                  <span className="tabular-nums">{percent(result?.metrics.sellerReturnRate ?? 0)}</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-mist-300">Workshops returning</span>
                  <span className="tabular-nums">{percent(result?.metrics.inspectorReturnRate ?? 0)}</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-mist-300">Expansion halted?</span>
                  <span className={result?.halt.halted ? 'text-alert' : 'text-safe'}>
                    {result?.halt.halted ? 'yes' : 'no'}
                  </span>
                </li>
              </ul>
              {result?.halt.halted ? (
                <div className="mt-3 text-xs text-alert">Reasons: {result.halt.reasons.join(', ')}</div>
              ) : (
                <p className="mt-3 text-xs text-mist-400">
                  Expansion still needs an existing corridor that genuinely works — not just numbers that are not bad.
                </p>
              )}
            </div>

            <div className="card p-4">
              <h3 className="text-sm font-medium">Public metrics we may display</h3>
              <p className="mt-2 text-xs text-mist-400">
                Completed deals, median time to report, dispute rate. What we may not publish as fact: token price
                projections or promised returns for holders.
              </p>
              <p className="mt-3 text-xs text-mist-400">
                An odometer anomaly on a VIN in this corridor counts as unexplained unless that VIN has completed a
                dispute.
              </p>
            </div>
          </div>
        </section>
      ))}

      <section className="card p-4">
        <h2 className="text-sm font-medium">Candidate corridors (not served yet)</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {corridors.candidateCorridors.map((candidate) => (
            <li key={`${candidate.originCountry}-${candidate.destinationCountry}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-700 p-3">
              <span>
                {candidate.originCountry} → {candidate.destinationCountry}
              </span>
              <span className="text-xs text-mist-400">{candidate.reason}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
