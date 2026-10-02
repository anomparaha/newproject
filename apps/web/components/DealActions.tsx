'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Deal, Dispute, VinEvent } from '@vin/shared';
import { usePersona } from './PersonaProvider';
import { Notice } from './Chips';
import { formatAmount, randomSha256, shortHash } from '@/lib/format';

interface Props {
  deal: Deal;
  dispute: Dispute | null;
  events: VinEvent[];
}

type Msg = { tone: 'safe' | 'danger' | 'info'; text: string } | null;

async function post(path: string, body: unknown, actorId: string | null): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(actorId ? { 'x-actor-id': actorId } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = data.error as { message?: string; details?: unknown } | undefined;
    const details = err?.details ? ` (${JSON.stringify(err.details)})` : '';
    throw new Error(`${err?.message ?? `HTTP ${res.status}`}${details}`);
  }
  return data;
}

function nextStep(deal: Deal, dispute: Dispute | null, events: VinEvent[]): string {
  if (dispute && dispute.state === 'open') return 'Menunggu putusan arbiter. Escrow dan nota dibekukan.';
  switch (deal.state) {
    case 'escrow_pending':
      return 'Pembeli mendanai escrow kendaraan dan escrow inspeksi (dua leg terpisah).';
    case 'inspecting':
      return events.some((e) => e.type === 'report_uploaded')
        ? 'Pembeli menerima atau menolak laporan dalam batas waktu.'
        : 'Bengkel mengerjakan cek di lokasi kendaraan dan mengunggah laporan minimum.';
    case 'inspection_accepted':
      return 'Menunggu konfirmasi serah terima sesuai syarat yang dikunci di awal.';
    case 'handover_pending':
      return 'Syarat serah terima dikonfirmasi. Dana kendaraan boleh dilepas ke penjual.';
    case 'completed':
      return 'Deal selesai. Nota tercatat sebagai jejak klaim, bukan title.';
    case 'frozen':
      return 'Deal dibekukan. Transfer nota tidak terjadi sebelum keputusan arbitrase.';
    default:
      return 'Belum ada langkah berikutnya.';
  }
}

export function DealActions({ deal, dispute, events }: Props) {
  const { actor } = usePersona();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const isBuyer = actor?.id === deal.buyerId;
  const isSeller = actor?.id === deal.sellerId;
  const isInspector = actor?.id === deal.inspectorId;
  const isArbiter = actor?.role === 'arbiter';

  const [report, setReport] = useState({
    odometerKm: '',
    inspectedAt: new Date().toISOString().slice(0, 16),
    reportHash: '',
    dashboardPhotoHash: '',
    conditionSummary: '',
    checklist: {
      vin_matches_unit: true,
      dashboard_photo: true,
      odometer_documented: true,
      main_condition: true,
      date_and_location: true,
    },
  });
  const [accept, setAccept] = useState({ acknowledgeAnomaly: false });
  const [handover, setHandover] = useState({ method: 'load_proof' as 'handover_location_confirmed' | 'load_proof' | 'mutual_confirmation' });
  const [disputeForm, setDisputeForm] = useState({ reason: '' });
  const [resolveForm, setResolveForm] = useState({
    outcome: 'release_to_seller' as 'refund_buyer' | 'release_to_seller' | 'split' | 'bond_slashed',
    refundedAmount: '',
    releasedAmount: '',
    bondSlashedAmount: '',
    arbiterNote: '',
  });

  const hasAnomaly = events.some((e) => e.type === 'odometer_anomaly');
  const canDispute = ['escrow_pending', 'inspecting', 'inspection_accepted', 'handover_pending'].includes(deal.state) && !dispute;

  async function act(fn: () => Promise<Record<string, unknown>>, success: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'safe', text: success });
      router.refresh();
    } catch (error) {
      setMsg({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Notice tone={dispute?.state === 'open' ? 'danger' : 'info'} title="Langkah berikutnya">
        {nextStep(deal, dispute, events)}
      </Notice>

      {msg ? <Notice tone={msg.tone} title={msg.text} /> : null}

      {/* Pembeli: danai escrow */}
      {deal.state === 'escrow_pending' && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Escrow menunggu pendanaan</h4>
          <p className="mt-1 text-xs text-mist-400">
            Dua leg terpisah: dana kendaraan {formatAmount(deal.priceAmount, deal.priceCurrency)} dan dana inspeksi{' '}
            {formatAmount(deal.inspectionFeeAmount)}. Produksi: penyedia pembayaran berizin di koridor; on-chain: program Anchor.
          </p>
          <div className="mt-3">
            <button
              className="primary"
              disabled={busy || !isBuyer}
              onClick={() => act(() => post(`/api/deals/${deal.id}/fund`, { payerRef: deal.buyerId }, actor?.id ?? null), 'Escrow didanai. Deal dikunci.')}
            >
              {isBuyer ? 'Danai escrow sekarang' : 'Hanya pembeli yang bisa mendanai escrow'}
            </button>
          </div>
        </div>
      )}

      {/* Bengkel: unggah laporan */}
      {deal.state === 'inspecting' && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Unggah laporan inspeksi</h4>
          <p className="mt-1 text-xs text-mist-400">
            File mentah disimpan off-chain; yang dikunci hanya hash. Laporan wajib memuat titik-titik minimum.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="odo">Odometer (km)</label>
              <input
                id="odo"
                inputMode="numeric"
                value={report.odometerKm}
                onChange={(e) => setReport({ ...report, odometerKm: e.target.value.replace(/[^0-9]/g, '') })}
                placeholder="30240"
              />
            </div>
            <div>
              <label htmlFor="inspectedAt">Waktu inspeksi</label>
              <input
                id="inspectedAt"
                type="datetime-local"
                value={report.inspectedAt}
                onChange={(e) => setReport({ ...report, inspectedAt: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="reportHash">Hash laporan (sha256)</label>
              <div className="flex gap-2">
                <input id="reportHash" value={report.reportHash} onChange={(e) => setReport({ ...report, reportHash: e.target.value })} placeholder="64 hex" />
                <button type="button" className="ghost whitespace-nowrap" onClick={() => setReport({ ...report, reportHash: randomSha256() })}>
                  contoh
                </button>
              </div>
            </div>
            <div>
              <label htmlFor="dashHash">Hash foto dasbor (sha256)</label>
              <div className="flex gap-2">
                <input id="dashHash" value={report.dashboardPhotoHash} onChange={(e) => setReport({ ...report, dashboardPhotoHash: e.target.value })} placeholder="64 hex" />
                <button type="button" className="ghost whitespace-nowrap" onClick={() => setReport({ ...report, dashboardPhotoHash: randomSha256() })}>
                  contoh
                </button>
              </div>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="summary">Kondisi utama</label>
              <textarea
                id="summary"
                rows={3}
                value={report.conditionSummary}
                onChange={(e) => setReport({ ...report, conditionSummary: e.target.value })}
                placeholder="Temuan pada tanggal inspeksi - bukan garansi sampai kendaraan tiba di negara pembeli."
              />
            </div>
          </div>
          <fieldset className="mt-3">
            <legend className="text-[0.7rem] uppercase tracking-wider text-mist-400">Checklist standar</legend>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {Object.entries(report.checklist).map(([key, checked]) => (
                <label key={key} className="flex items-center gap-2 text-xs normal-case text-mist-300">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={checked}
                    onChange={(e) => setReport({ ...report, checklist: { ...report.checklist, [key]: e.target.checked } })}
                  />
                  {key}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-3">
            <button
              className="primary"
              disabled={busy || !isInspector || report.odometerKm === '' || report.reportHash.length !== 64 || report.dashboardPhotoHash.length !== 64}
              onClick={() =>
                act(
                  () =>
                    post(
                      `/api/deals/${deal.id}/reports`,
                      {
                        inspectorId: deal.inspectorId,
                        odometerKm: Number(report.odometerKm),
                        inspectedAt: new Date(report.inspectedAt).toISOString(),
                        reportHash: report.reportHash,
                        dashboardPhotoHash: report.dashboardPhotoHash,
                        conditionSummary: report.conditionSummary,
                        standardVersion: 'vin-report-v1',
                        checklist: report.checklist,
                      },
                      actor?.id ?? null,
                    ),
                  'Laporan diunggah. Hash terkunci di event log.',
                )
              }
            >
              {isInspector ? 'Unggah laporan' : 'Hanya bengkel terpilih yang bisa mengunggah'}
            </button>
          </div>
        </div>
      )}

      {/* Pembeli: terima laporan */}
      {deal.state === 'inspecting' && events.some((e) => e.type === 'report_uploaded') && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Terima laporan</h4>
          {hasAnomaly ? (
            <div className="mt-2">
              <Notice tone="warn" title="Ada anomali kilometer pada VIN ini">
                Anomali bukan penolakan otomatis, tetapi peringatan yang wajib dilihat sebelum dana dilepas.
              </Notice>
              <label className="mt-2 flex items-center gap-2 text-xs normal-case text-mist-300">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={accept.acknowledgeAnomaly}
                  onChange={(e) => setAccept({ acknowledgeAnomaly: e.target.checked })}
                />
                Saya sudah membaca peringatan anomali odometer
              </label>
            </div>
          ) : null}
          <div className="mt-3">
            <button
              className="primary"
              disabled={busy || !isBuyer || (hasAnomaly && !accept.acknowledgeAnomaly)}
              onClick={() =>
                act(async () => {
                  const detail = await fetch(`/api/deals/${deal.id}`).then((r) => r.json());
                  const reportId: string = detail.reports?.[0]?.id;
                  if (!reportId) throw new Error('Laporan belum tersedia di server');
                  return post(
                    `/api/deals/${deal.id}/reports/${reportId}/accept`,
                    { buyerId: deal.buyerId, acknowledgeAnomaly: accept.acknowledgeAnomaly },
                    actor?.id ?? null,
                  );
                }, 'Laporan diterima. Dana inspeksi lepas ke bengkel setelah fee platform dipotong.')
              }
            >
              {isBuyer ? 'Terima laporan, lepas dana inspeksi' : 'Hanya pembeli yang bisa menerima laporan'}
            </button>
          </div>
        </div>
      )}

      {/* Serah terima */}
      {['inspection_accepted', 'handover_pending'].includes(deal.state) && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Konfirmasi serah terima</h4>
          <p className="mt-1 text-xs text-mist-400">
            Syarat yang dikunci: {deal.handoverTerms}. Terkonfirmasi oleh: {deal.handoverConfirmedBy.length} pihak.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="method">Metode bukti</label>
              <select id="method" value={handover.method} onChange={(e) => setHandover({ method: e.target.value as typeof handover.method })}>
                <option value="handover_location_confirmed">Serah di lokasi</option>
                <option value="load_proof">Bukti muat</option>
                <option value="mutual_confirmation">Konfirmasi kedua pihak</option>
              </select>
            </div>
            <div className="flex items-end">
              <button
                className="ghost w-full"
                disabled={busy || (!isBuyer && !isSeller)}
                onClick={() =>
                  act(
                    () => post(`/api/deals/${deal.id}/handover`, { actorId: actor?.id, method: handover.method }, actor?.id ?? null),
                    'Konfirmasi tercatat.',
                  )
                }
              >
                {isBuyer || isSeller ? 'Konfirmasi sebagai saya' : 'Hanya pembeli/penjual'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pelepasan dana kendaraan */}
      {deal.state === 'handover_pending' && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Pelepasan dana kendaraan</h4>
          <p className="mt-1 text-xs text-mist-400">
            Dana kendaraan tidak cair sebelum syarat serah terima terpenuhi. Setelah lepas, nota selesai dicatat ke pembeli.
          </p>
          <div className="mt-3">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                act(() => post(`/api/deals/${deal.id}/release-vehicle`, {}, actor?.id ?? null), 'Dana kendaraan dilepas. Nota selesai tercatat.')
              }
            >
              Lepaskan dana kendaraan dan catat nota
            </button>
          </div>
        </div>
      )}

      {/* Sengketa */}
      {canDispute && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Buka sengketa</h4>
          <p className="mt-1 text-xs text-mist-400">
            Sengketa membekukan escrow dan nota. Hanya jika kedua pihak tidak sepakat.
          </p>
          <div className="mt-3">
            <label htmlFor="reason">Alasan</label>
            <textarea
              id="reason"
              rows={3}
              value={disputeForm.reason}
              onChange={(e) => setDisputeForm({ reason: e.target.value })}
              placeholder="Penjual tidak menyerahkan unit / laporan diduga tidak sesuai unit / alasan lain."
            />
          </div>
          <div className="mt-3">
            <button
              className="primary"
              disabled={busy || !actor || disputeForm.reason.length < 10}
              onClick={() => act(() => post(`/api/deals/${deal.id}/disputes`, { openedBy: actor?.id, reason: disputeForm.reason }, actor?.id ?? null), 'Sengketa dibuka. Escrow dibekukan.')}
            >
              Buka sengketa
            </button>
          </div>
        </div>
      )}

      {/* Arbiter */}
      {dispute?.state === 'open' && isArbiter && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Putusan arbiter</h4>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="outcome">Putusan</label>
              <select id="outcome" value={resolveForm.outcome} onChange={(e) => setResolveForm({ ...resolveForm, outcome: e.target.value as typeof resolveForm.outcome })}>
                <option value="refund_buyer">Dana kembali ke pembeli</option>
                <option value="release_to_seller">Dana dilepas ke penjual</option>
                <option value="split">Pelepasan sebagian (split)</option>
                <option value="bond_slashed">Penjual gagal: jaminan terpotong</option>
              </select>
            </div>
            {resolveForm.outcome === 'split' ? (
              <>
                <div>
                  <label htmlFor="toBuyer">Kembali ke pembeli</label>
                  <input id="toBuyer" value={resolveForm.refundedAmount} onChange={(e) => setResolveForm({ ...resolveForm, refundedAmount: e.target.value })} placeholder="1000" />
                </div>
                <div>
                  <label htmlFor="toSeller">Dilepas ke penjual</label>
                  <input id="toSeller" value={resolveForm.releasedAmount} onChange={(e) => setResolveForm({ ...resolveForm, releasedAmount: e.target.value })} placeholder="44000" />
                </div>
              </>
            ) : null}
            <div className="sm:col-span-2">
              <label htmlFor="arbNote">Catatan arbiter</label>
              <textarea id="arbNote" rows={3} value={resolveForm.arbiterNote} onChange={(e) => setResolveForm({ ...resolveForm, arbiterNote: e.target.value })} />
            </div>
          </div>
          <div className="mt-3">
            <button
              className="primary"
              disabled={busy || resolveForm.arbiterNote.length < 4}
              onClick={() =>
                act(
                  () =>
                    post(
                      `/api/disputes/${dispute.id}/resolve`,
                      {
                        arbiterId: actor?.id,
                        outcome: resolveForm.outcome,
                        refundedAmount: resolveForm.refundedAmount || undefined,
                        releasedAmount: resolveForm.releasedAmount || undefined,
                        bondSlashedAmount: resolveForm.bondSlashedAmount || undefined,
                        arbiterNote: resolveForm.arbiterNote,
                      },
                      actor?.id ?? null,
                    ),
                  'Sengketa diputus. Potongan jaminan masuk kas sengketa, bukan dompet tim.',
                )
              }
            >
              Putuskan sengketa
            </button>
          </div>
        </div>
      )}

      {dispute?.state === 'open' && !isArbiter ? (
        <Notice tone="danger" title={`Sengketa terbuka oleh ${shortHash(dispute.openedBy, 8, 4)}`}>
          Pilih persona Arbiter pada panel kiri untuk memutuskan sengketa.
        </Notice>
      ) : null}
    </div>
  );
}
