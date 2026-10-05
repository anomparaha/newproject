'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Listing } from '@vin/shared';
import { useSession } from './SessionProvider';
import { Notice } from './Chips';
import { formatAmount } from '@/lib/format';
import type { InspectorEntry } from '@/lib/api';

export function CommitDealForm({ listing }: { listing: Listing }) {
  const { actor } = useSession();
  const router = useRouter();
  const [inspectors, setInspectors] = useState<InspectorEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'safe' | 'danger'; text: string } | null>(null);
  const [form, setForm] = useState({
    inspectorId: '',
    inspectionFeeAmount: '150',
    escrowCurrency: 'USDC' as 'USDC' | 'AED',
    shippingPaidBy: 'buyer' as 'buyer' | 'seller',
    shippingAmount: '1200',
    inspectionDeadlineHours: 72,
    handoverTerms: 'Handover at location + load proof; confirmation by both parties',
    fundNow: true,
  });

  useEffect(() => {
    fetch('/api/inspectors?country=AE')
      .then((r) => (r.ok ? r.json() : { inspectors: [] }))
      .then((data: { inspectors: InspectorEntry[] }) => {
        setInspectors(data.inspectors);
        if (data.inspectors[0]) setForm((f) => ({ ...f, inspectorId: data.inspectors[0]!.actor.id }));
      })
      .catch(() => setInspectors([]));
  }, []);

  if (!actor || actor.role !== 'buyer') {
    return (
      <Notice tone="info" title="Sign in as the buyer to lock a deal">
        The buyer picks the workshop, locks the price, and funds the escrow.
      </Notice>
    );
  }

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/listings/${listing.id}/deals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-actor-id': actor!.id },
        body: JSON.stringify({
          buyerId: actor!.id,
          inspectorId: form.inspectorId,
          shippingPaidBy: form.shippingPaidBy,
          shippingAmount: form.shippingAmount,
          inspectionFeeAmount: form.inspectionFeeAmount,
          escrowCurrency: form.escrowCurrency,
          inspectionDeadlineHours: Number(form.inspectionDeadlineHours),
          handoverTerms: form.handoverTerms,
        }),
      });
      const data = (await res.json()) as { deal?: { id: string }; error?: { message: string; details?: unknown } };
      if (!res.ok || !data.deal) {
        throw new Error(`${data.error?.message ?? `HTTP ${res.status}`}${data.error?.details ? ` (${JSON.stringify(data.error.details)})` : ''}`);
      }
      if (form.fundNow) {
        const fundRes = await fetch(`/api/deals/${data.deal.id}/fund`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-actor-id': actor!.id },
          body: JSON.stringify({ payerRef: actor!.id }),
        });
        if (!fundRes.ok) throw new Error('The deal is locked, but funding the escrow failed. Try funding it from the deal page.');
      }
      setMsg({ tone: 'safe', text: 'Deal locked. The listing cannot be sold to a second buyer while the escrow is active.' });
      router.push(`/deals/${data.deal.id}`);
    } catch (error) {
      setMsg({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      <h3 className="text-sm font-medium">Lock a deal</h3>
      <p className="mt-1 text-xs text-mist-400">
        The vehicle price {formatAmount(listing.priceAmount, listing.priceCurrency)} enters the vehicle escrow; the inspection fee enters a separate escrow.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="inspector">Inspection workshop (chosen by the buyer)</label>
          <select id="inspector" value={form.inspectorId} onChange={(e) => setForm({ ...form, inspectorId: e.target.value })}>
            {inspectors.length === 0 ? <option value="">No verified workshop yet</option> : null}
            {inspectors.map((entry) => (
              <option key={entry.actor.id} value={entry.actor.id}>
                {entry.actor.displayName} — on time {entry.reputation?.onTimeReportRate !== null && entry.reputation?.onTimeReportRate !== undefined ? `${(entry.reputation.onTimeReportRate * 100).toFixed(0)}%` : 'n/a'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="fee">Inspection fee (USDC)</label>
          <input id="fee" value={form.inspectionFeeAmount} onChange={(e) => setForm({ ...form, inspectionFeeAmount: e.target.value })} />
        </div>
        <div>
          <label htmlFor="deadline">Report deadline (hours)</label>
          <input
            id="deadline"
            inputMode="numeric"
            value={form.inspectionDeadlineHours}
            onChange={(e) => setForm({ ...form, inspectionDeadlineHours: Number(e.target.value.replace(/[^0-9]/g, '') || 0) })}
          />
        </div>
        <div>
          <label htmlFor="shippingBy">Shipping paid by</label>
          <select id="shippingBy" value={form.shippingPaidBy} onChange={(e) => setForm({ ...form, shippingPaidBy: e.target.value as 'buyer' | 'seller' })}>
            <option value="buyer">Buyer</option>
            <option value="seller">Seller</option>
          </select>
        </div>
        <div>
          <label htmlFor="shippingAmount">Estimated shipping</label>
          <input id="shippingAmount" value={form.shippingAmount} onChange={(e) => setForm({ ...form, shippingAmount: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="terms">Handover terms (locked at the start)</label>
          <input id="terms" value={form.handoverTerms} onChange={(e) => setForm({ ...form, handoverTerms: e.target.value })} />
        </div>
      </div>

      <label className="mt-3 flex items-center gap-2 text-xs normal-case text-mist-300">
        <input type="checkbox" className="h-4 w-4" checked={form.fundNow} onChange={(e) => setForm({ ...form, fundNow: e.target.checked })} />
        Fund the escrow now (licensed provider simulation)
      </label>

      <div className="mt-3">
        <button className="primary" disabled={busy || !form.inspectorId} onClick={submit}>
          {busy ? 'Working…' : 'Lock deal & fund escrow'}
        </button>
      </div>
      {msg ? (
        <div className="mt-3">
          <Notice tone={msg.tone} title={msg.text} />
        </div>
      ) : null}
    </div>
  );
}
