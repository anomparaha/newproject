import { api } from '@/lib/api';
import { Notice } from '@/components/Chips';
import { formatAmount, percent } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function InspectorsPage() {
  const data = await api.inspectors();

  if (!data) {
    return <Notice tone="warn" title="API is not running">Run <code>npm run dev:api</code>.</Notice>;
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Inspection market</h1>
        <p className="max-w-3xl text-sm text-mist-400">
          Workshops sign up with a location, service types, and coverage area. Once identity checks pass they appear as a
          buyer's options. The workshop sets its fee, the buyer pays it into escrow, and it releases after a complete
          report.
        </p>
      </header>

      <Notice tone="warn" title="Ranking is not for sale">
        Ordering comes from on-time report rate, dispute rate, and standard compliance. A workshop with repeated disputes
        drops off the list.
      </Notice>

      <div className="card overflow-x-auto">
        <table className="ledger">
          <thead>
            <tr>
              <th>#</th>
              <th>Workshop</th>
              <th>Location</th>
              <th>Capacity bond</th>
              <th>On time</th>
              <th>Standard</th>
              <th>Median report</th>
              <th>Disputes</th>
              <th>Deals completed</th>
            </tr>
          </thead>
          <tbody>
            {data.inspectors.map((entry, index) => (
              <tr key={entry.actor.id}>
                <td className="text-mist-400">{index + 1}</td>
                <td>
                  <div className="font-medium">{entry.actor.displayName}</div>
                  <div className="text-xs text-mist-400">
                    {entry.actor.verification === 'business_verified' ? 'business identity verified' : entry.actor.verification}
                  </div>
                </td>
                <td className="text-xs text-mist-300">
                  {entry.actor.city ?? '-'}, {entry.actor.countryCode}
                </td>
                <td className="tabular-nums">{formatAmount(entry.bond.amount, entry.bond.currency)}</td>
                <td className="tabular-nums">{percent(entry.reputation?.onTimeReportRate ?? null)}</td>
                <td className="tabular-nums">{percent(entry.reputation?.standardComplianceRate ?? null)}</td>
                <td className="tabular-nums">{entry.reputation?.medianReportHours !== null && entry.reputation?.medianReportHours !== undefined ? `${entry.reputation.medianReportHours}h` : '-'}</td>
                <td className="tabular-nums">
                  {entry.reputation?.disputesOpened ?? 0}
                  {entry.reputation && entry.reputation.disputesLost > 0 ? (
                    <span className="ml-1 text-alert">({entry.reputation.disputesLost} lost)</span>
                  ) : null}
                </td>
                <td className="tabular-nums">{entry.reputation?.dealsCompleted ?? 0}</td>
              </tr>
            ))}
            {data.inspectors.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-mist-400">
                  No verified workshops with a capacity bond yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-mist-400">{data.rankingPolicy}</p>
    </div>
  );
}
