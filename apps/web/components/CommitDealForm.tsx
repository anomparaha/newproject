'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Listing } from '@vin/shared';
import { useSession } from './SessionProvider';
import { Notice } from './Chips';
import { Icon } from './Icons';
import { formatAmount } from '@/lib/format';
import type { InspectorEntry } from '@/lib/api';

export function CommitDealForm({ listing }: { listing: Listing }) {
  const { actor, authHeaders } = useSession();
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
      <div className="card p-6 bg-white shadow-xs space-y-3 border-line">
        <div className="flex items-center gap-2.5 text-ink font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-600">
            <Icon name="lock" className="h-4 w-4" />
          </span>
          <span>Buyer Verification Required</span>
        </div>
        <p className="text-sm text-muted">
          Only signed-in buyers can lock an escrow agreement. The buyer selects the certified workshop, sets deadline
          terms, and funds the two escrow legs.
        </p>
        <Notice tone="info" title="How to test this deal">
          Use the <strong>Sign In</strong> button in the header, then select a demo buyer under <strong>Demo binding</strong>.
        </Notice>
      </div>
    );
  }

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/listings/${listing.id}/deals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
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
          headers: { 'content-type': 'application/json', ...authHeaders() },
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
    <div className="card p-6 bg-white shadow-elevated border-slate-300 space-y-5">
      <div className="flex items-center gap-3 border-b border-line pb-4">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-slate-900 text-white shadow-xs">
          <Icon name="lock" className="h-5 w-5" />
        </span>
        <div>
          <h3 className="text-base font-bold text-ink">Commit Escrow Deal</h3>
          <p className="text-xs text-muted">Two-leg buyer protected escrow</p>
        </div>
      </div>

      <div className="rounded-xl bg-slate-100 border border-slate-300 p-3.5 text-xs text-slate-800 leading-relaxed">
        Asking price{' '}
        <span className="font-bold text-slate-950">{formatAmount(listing.priceAmount, listing.priceCurrency)}</span> enters the
        vehicle escrow. Inspection fee enters a separate escrow leg.
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="inspector" className="text-xs font-semibold uppercase tracking-wider text-muted">
            Independent Inspection Workshop
          </label>
          <select
            id="inspector"
            value={form.inspectorId}
            onChange={(e) => setForm({ ...form, inspectorId: e.target.value })}
            className="mt-1"
          >
            {inspectors.length === 0 ? <option value="">No verified workshops found</option> : null}
            {inspectors.map((entry) => (
              <option key={entry.actor.id} value={entry.actor.id}>
                {entry.actor.displayName} — on-time{' '}
                {entry.reputation?.onTimeReportRate !== null && entry.reputation?.onTimeReportRate !== undefined
                  ? `${(entry.reputation.onTimeReportRate * 100).toFixed(0)}%`
                  : 'n/a'}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[0.7rem] text-muted">Chosen strictly by the buyer; seller cannot assign inspector.</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="fee" className="text-xs font-semibold uppercase tracking-wider text-muted">
              Inspection Fee (USDC)
            </label>
            <input
              id="fee"
              value={form.inspectionFeeAmount}
              onChange={(e) => setForm({ ...form, inspectionFeeAmount: e.target.value })}
              className="mt-1"
            />
          </div>
          <div>
            <label htmlFor="deadline" className="text-xs font-semibold uppercase tracking-wider text-muted">
              Report SLA (Hours)
            </label>
            <input
              id="deadline"
              inputMode="numeric"
              value={form.inspectionDeadlineHours}
              onChange={(e) =>
                setForm({ ...form, inspectionDeadlineHours: Number(e.target.value.replace(/[^0-9]/g, '') || 0) })
              }
              className="mt-1"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="shippingBy" className="text-xs font-semibold uppercase tracking-wider text-muted">
              Shipping Payer
            </label>
            <select
              id="shippingBy"
              value={form.shippingPaidBy}
              onChange={(e) => setForm({ ...form, shippingPaidBy: e.target.value as 'buyer' | 'seller' })}
              className="mt-1"
            >
              <option value="buyer">Buyer</option>
              <option value="seller">Seller</option>
            </select>
          </div>
          <div>
            <label htmlFor="shippingAmount" className="text-xs font-semibold uppercase tracking-wider text-muted">
              Est. Shipping
            </label>
            <input
              id="shippingAmount"
              value={form.shippingAmount}
              onChange={(e) => setForm({ ...form, shippingAmount: e.target.value })}
              className="mt-1"
            />
          </div>
        </div>

        <div>
          <label htmlFor="terms" className="text-xs font-semibold uppercase tracking-wider text-muted">
            Handover Terms (Locked in Deal)
          </label>
          <input
            id="terms"
            value={form.handoverTerms}
            onChange={(e) => setForm({ ...form, handoverTerms: e.target.value })}
            className="mt-1 text-xs"
          />
        </div>

        <label className="flex items-center gap-2.5 text-xs text-body font-medium pt-1 cursor-pointer">
          <input
            type="checkbox"
            checked={form.fundNow}
            onChange={(e) => setForm({ ...form, fundNow: e.target.checked })}
          />
          <span>Fund both escrow legs immediately (simulation)</span>
        </label>
      </div>

      <button
        type="button"
        className="primary w-full py-3.5 text-sm font-bold tracking-tight shadow-md"
        disabled={busy || !form.inspectorId}
        onClick={submit}
      >
        {busy ? 'Securing Escrow…' : 'Lock Deal & Fund Escrow'}
      </button>

      {msg ? (
        <div className="pt-2">
          <Notice tone={msg.tone} title={msg.text} />
        </div>
      ) : null}
    </div>
  );
}
