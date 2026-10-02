import { api } from '@/lib/api';
import { Notice } from '@/components/Chips';
import { formatAmount } from '@/lib/format';

export const dynamic = 'force-dynamic';

const BPS_LABEL: Record<string, string> = {
  vehicleBps: 'Fee transaksi kendaraan (bps)',
  inspectionBps: 'Fee aplikasi inspeksi (bps)',
  tokenDiscountFactor: 'Faktor diskon fee bila dibayar token',
};

const BOND_LABEL: Record<string, string> = {
  listingBondUsdc: 'Jaminan listing (USDC)',
  inspectorBondUsdc: 'Jaminan bengkel (USDC)',
  stablecoinAllowedBelowUsd: 'Jaminan boleh stablecoin bila di bawah (USD)',
  slashRatio: 'Porsi jaminan terpotong saat pelanggaran',
};

export default async function PolicyPage() {
  const policy = await api.policy();

  if (!policy) {
    return <Notice tone="warn" title="API belum berjalan">Jalankan <code>npm run dev:api</code>.</Notice>;
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Kebijakan & tahapan</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-mist-400">{policy.whatItIs}</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <Notice tone="info" title="Uang">{policy.moneyRule}</Notice>
        <Notice tone="warn" title="NFT bukan surat kendaraan">{policy.disclaimers?.nftNotTitle}</Notice>
        <Notice tone="danger" title="Token bukan saham">{policy.disclaimers?.tokenNotEquity}</Notice>
      </div>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="card p-4">
          <h2 className="text-sm font-medium">Fee</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {Object.entries(policy.fees).map(([key, value]) => (
              <li key={key} className="flex items-start justify-between gap-3">
                <span className="text-mist-300">{BPS_LABEL[key] ?? key}</span>
                <span className="tabular-nums text-mist-400">{String(value)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-mist-400">
            Yang tidak punya token tetap bisa membayar fee dengan stablecoin. Sebagian fee yang masuk sebagai token dapat
            dibakar hanya jika fee itu benar-benar terkumpul dari pemakaian - tidak ada bakar terjadwal.
          </p>
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-medium">Jaminan</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {Object.entries(policy.bonds).map(([key, value]) => (
              <li key={key} className="flex items-start justify-between gap-3">
                <span className="text-mist-300">{BOND_LABEL[key] ?? key}</span>
                <span className="tabular-nums text-mist-400">{String(value)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-mist-400">
            Jaminan terpotong bila listing terbukti palsu, penjual menghilang, atau laporan tidak memenuhi standar. Potongan
            masuk kas sengketa, bukan ke dompet tim.
          </p>
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-medium">Token: tiga fungsi, tidak lebih</h2>
          <ul className="mt-3 space-y-1 text-sm">
            {policy.token.functions.map((fn) => (
              <li key={fn} className="flex items-center gap-2">
                <span className="text-safe">✓</span> {fn}
              </li>
            ))}
          </ul>
          <div className="mt-3 text-xs uppercase tracking-wider text-mist-400">Tidak pernah</div>
          <ul className="mt-1 space-y-1 text-sm">
            {policy.token.neverDoes.map((fn) => (
              <li key={fn} className="flex items-center gap-2 text-mist-300">
                <span className="text-alert">✕</span> {fn}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-mist-400">{policy.tokenMetricsNote}</p>
        </div>
      </section>

      <section className="card p-4">
        <h2 className="text-sm font-medium">Urutan sampai bisa dipublikasi</h2>
        <div className="mt-3 grid gap-3 lg:grid-cols-4">
          {policy.stages.map((stage) => (
            <div key={stage.id} className="rounded-lg border border-ink-700 p-3">
              <div className="text-sm font-medium">{stage.label}</div>
              <div className="mt-2 text-[0.68rem] uppercase tracking-wider text-safe">boleh</div>
              <ul className="mt-1 space-y-1 text-xs text-mist-300">
                {stage.allowed.map((item) => (
                  <li key={item}>· {item}</li>
                ))}
              </ul>
              <div className="mt-2 text-[0.68rem] uppercase tracking-wider text-alert">tidak boleh</div>
              <ul className="mt-1 space-y-1 text-xs text-mist-400">
                {stage.forbidden.map((item) => (
                  <li key={item}>· {item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="text-sm font-medium">Event yang sah</h2>
          <p className="mt-1 text-xs text-mist-400">
            Event lama tidak ditimpa. Hanya event berikut yang boleh masuk ke rangkaian satu VIN.
          </p>
          <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
            {policy.eventTypes.map((event) => (
              <li key={event.type} className="flex items-center justify-between gap-2 rounded border border-ink-800 px-2 py-1">
                <span className="text-mist-300">{event.label}</span>
                <span className="text-[0.68rem] uppercase tracking-wider text-mist-400">{event.category}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="text-sm font-medium">Kontrol yang membuatnya sehat</h2>
            <ul className="mt-3 space-y-2 text-sm text-mist-300">
              <li>Dana kendaraan tidak cair sebelum syarat serah terima.</li>
              <li>Dana inspeksi tidak cair sebelum laporan lengkap.</li>
              <li>Penjual tidak memilih inspektor.</li>
              <li>Event lama tidak bisa diedit.</li>
              <li>Anomali kilometer tetap terlihat.</li>
              <li>Sengketa membekukan nota dan escrow.</li>
              <li>Identitas penjual dan bengkel bisa dicabut.</li>
              <li>Halaman kendaraan menulis bahwa catatan ini jejak klaim, bukan title.</li>
            </ul>
          </div>
          <div className="card p-4">
            <h2 className="text-sm font-medium">Ambang pemicu berhenti perluasan</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {Object.entries(policy.haltThresholds).map(([key, value]) => (
                <li key={key} className="flex justify-between gap-3">
                  <span className="text-mist-300">{key}</span>
                  <span className="tabular-nums text-mist-400">{formatAmount(value)}</span>
                </li>
              ))}
            </ul>
          </div>
          <Notice tone="warn" title="Laporan inspeksi">{policy.disclaimers?.reportNotWarranty}</Notice>
        </div>
      </section>
    </div>
  );
}
