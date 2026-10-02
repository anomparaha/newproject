import { api } from '@/lib/api';
import { Notice } from '@/components/Chips';
import { formatAmount, percent } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function InspectorsPage() {
  const data = await api.inspectors();

  if (!data) {
    return <Notice tone="warn" title="API belum berjalan">Jalankan <code>npm run dev:api</code>.</Notice>;
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Pasar inspeksi</h1>
        <p className="max-w-3xl text-sm text-mist-400">
          Bengkel mendaftar dengan lokasi, jenis layanan, dan area jangkauan. Setelah lolos cek identitas, mereka muncul
          sebagai pilihan pembeli. Biaya inspeksi ditentukan bengkel, dibayar pembeli, ditahan escrow, dan dilepas setelah
          laporan lengkap.
        </p>
      </header>

      <Notice tone="warn" title="Ranking tidak dijual">
        Urutan tampil berasal dari tingkat laporan tepat waktu, tingkat sengketa, dan kelengkapan standar. Bengkel dengan
        sengketa berulang keluar dari daftar.
      </Notice>

      <div className="card overflow-x-auto">
        <table className="ledger">
          <thead>
            <tr>
              <th>#</th>
              <th>Bengkel</th>
              <th>Lokasi</th>
              <th>Jaminan kapasitas</th>
              <th>Tepat waktu</th>
              <th>Standar</th>
              <th>Median laporan</th>
              <th>Sengketa</th>
              <th>Deal selesai</th>
            </tr>
          </thead>
          <tbody>
            {data.inspectors.map((entry, index) => (
              <tr key={entry.actor.id}>
                <td className="text-mist-400">{index + 1}</td>
                <td>
                  <div className="font-medium">{entry.actor.displayName}</div>
                  <div className="text-xs text-mist-400">
                    {entry.actor.verification === 'business_verified' ? 'identitas usaha terverifikasi' : entry.actor.verification}
                  </div>
                </td>
                <td className="text-xs text-mist-300">
                  {entry.actor.city ?? '-'}, {entry.actor.countryCode}
                </td>
                <td className="tabular-nums">{formatAmount(entry.bond.amount, entry.bond.currency)}</td>
                <td className="tabular-nums">{percent(entry.reputation?.onTimeReportRate ?? null)}</td>
                <td className="tabular-nums">{percent(entry.reputation?.standardComplianceRate ?? null)}</td>
                <td className="tabular-nums">{entry.reputation?.medianReportHours !== null && entry.reputation?.medianReportHours !== undefined ? `${entry.reputation.medianReportHours} jam` : '-'}</td>
                <td className="tabular-nums">
                  {entry.reputation?.disputesOpened ?? 0}
                  {entry.reputation && entry.reputation.disputesLost > 0 ? (
                    <span className="ml-1 text-alert">({entry.reputation.disputesLost} kalah)</span>
                  ) : null}
                </td>
                <td className="tabular-nums">{entry.reputation?.dealsCompleted ?? 0}</td>
              </tr>
            ))}
            {data.inspectors.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-mist-400">
                  Belum ada bengkel terverifikasi dengan jaminan kapasitas.
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
