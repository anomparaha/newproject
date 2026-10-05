'use client';

import { useMemo, useState } from 'react';
import type { Listing } from '@vin/shared';
import { ListingCard } from '@/components/ListingCard';
import { EmptyState } from '@/components/Chips';
import { Icon } from '@/components/Icons';

interface Props {
  listings: Listing[];
}

export function ListingsExplorer({ listings }: Props) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'price_asc' | 'price_desc' | 'year' | 'odometer'>('newest');

  const filtered = useMemo(() => {
    let result = [...listings];

    if (statusFilter !== 'all') {
      result = result.filter((l) => l.status === statusFilter);
    }

    if (query.trim()) {
      const q = query.toLowerCase().trim();
      result = result.filter((l) => {
        const title = `${l.make} ${l.model} ${l.year}`.toLowerCase();
        const vin = l.vin.toLowerCase();
        const loc = l.location.toLowerCase();
        return title.includes(q) || vin.includes(q) || loc.includes(q);
      });
    }

    result.sort((a, b) => {
      if (sortBy === 'price_asc') {
        return Number(a.priceAmount) - Number(b.priceAmount);
      }
      if (sortBy === 'price_desc') {
        return Number(b.priceAmount) - Number(a.priceAmount);
      }
      if (sortBy === 'year') {
        return b.year - a.year;
      }
      if (sortBy === 'odometer') {
        return (a.odometerKm ?? 0) - (b.odometerKm ?? 0);
      }
      // default: newest
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return result;
  }, [listings, query, statusFilter, sortBy]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: listings.length };
    listings.forEach((l) => {
      counts[l.status] = (counts[l.status] ?? 0) + 1;
    });
    return counts;
  }, [listings]);

  return (
    <div className="space-y-6">
      {/* Controls Bar: Search, Status Tabs, and Sorting */}
      <div className="card p-4 sm:p-5 space-y-4 bg-white shadow-xs">
        <div className="flex flex-col md:flex-row gap-3 md:items-center justify-between">
          {/* Search Input */}
          <div className="relative flex-1">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted">
              <Icon name="search" className="h-4 w-4" />
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by make, model, chassis VIN, or location..."
              className="pl-10 pr-4 py-2.5 text-sm rounded-xl border border-slate-300 bg-slate-50 focus:bg-white text-slate-900 font-medium transition-colors"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-ink"
              >
                <Icon name="x" className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          {/* Sort dropdown */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-bold uppercase tracking-wider text-muted hidden sm:inline">Sort:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="py-2.5 px-3 text-sm rounded-xl border border-slate-300 bg-white font-semibold text-slate-900 cursor-pointer shadow-2xs"
            >
              <option value="newest">Recently Added</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
              <option value="year">Model Year: Newest</option>
              <option value="odometer">Mileage: Lowest</option>
            </select>
          </div>
        </div>

        {/* Status filter tabs */}
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {[
            { id: 'all', label: 'All Units' },
            { id: 'listed', label: 'Available' },
            { id: 'reserved', label: 'Reserved' },
            { id: 'completed', label: 'Completed' },
          ].map((tab) => {
            const count = statusCounts[tab.id] ?? 0;
            const active = statusFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-1.5 text-xs font-bold transition-all ${
                  active
                    ? 'bg-slate-900 text-white shadow-2xs'
                    : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-950 font-semibold'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`rounded-full px-1.5 py-0.2 text-[0.68rem] font-bold ${
                    active ? 'bg-white/20 text-white' : 'bg-slate-100 border border-slate-200 text-slate-700'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}

          <div className="ml-auto text-xs text-muted font-medium">
            Showing <span className="font-bold text-ink">{filtered.length}</span> of {listings.length} vehicles
          </div>
        </div>
      </div>

      {/* Grid or Empty */}
      {filtered.length === 0 ? (
        <EmptyState title="No matching vehicles found">
          {query || statusFilter !== 'all'
            ? 'Try adjusting your search criteria or resetting filters.'
            : 'No vehicle listings are currently published in the catalog.'}
        </EmptyState>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((listing) => (
            <ListingCard key={listing.id} listing={listing} showVin />
          ))}
        </div>
      )}
    </div>
  );
}
