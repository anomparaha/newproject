import { api } from '@/lib/api';
import { Badge, Notice, PageHeader, SectionTitle } from '@/components/Chips';
import { Icon } from '@/components/Icons';
import { ListingsExplorer } from '@/components/ListingsExplorer';
import { ScrollReveal } from '@/components/ScrollReveal';

export const dynamic = 'force-dynamic';

export default async function ListingsPage() {
  const data = await api.listings();

  if (!data) {
    return (
      <Notice tone="warn" title="API server is not responding">
        Run <code>npm run dev:api</code> to load active vehicle listings.
      </Notice>
    );
  }

  return (
    <div className="space-y-10">
      <ScrollReveal direction="up" delay={0}>
        <PageHeader
          eyebrow="Marketplace"
          title="Vehicle Registry & Listings"
          description="A listing locks the make, model, year, VIN, physical location, price, shipping terms, and photo hashes. Each deal is backed by seller collateral and an independent physical inspection."
          actions={<Badge tone="brand">{data.listings.length} units listed</Badge>}
        />
      </ScrollReveal>

      <ScrollReveal direction="up" delay={80}>
        <Notice tone="info" title="Registry Scope & Boundary">
          A VIN is unique only inside the platform. Chassis formats differ between countries, and on-chain uniqueness is
          not identical to legal ownership in official state vehicle registries.
        </Notice>
      </ScrollReveal>

      {/* Interactive explorer with search, status filters, and sorting */}
      <ScrollReveal direction="up" delay={120}>
        <ListingsExplorer listings={data.listings} />
      </ScrollReveal>

      {/* Corridors served */}
      <ScrollReveal direction="up" delay={60} as="section" className="space-y-5 pt-4 border-t border-line">
        <SectionTitle
          title="Corridors Served"
          description="The first corridor is deliberately narrow: verified origin chassis data, defined destination routes, high-value thresholds, and mandatory physical inspection."
        />
        <div className="grid gap-5 md:grid-cols-2">
          {data.corridor ? (
            <div className="card border-emerald-200 bg-white p-6 shadow-xs space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2.5 text-base font-bold text-ink">
                  <span className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
                    <Icon name="globe" className="h-4 w-4" />
                  </span>
                  <span>
                    {data.corridor.originCountry} → {data.corridor.destinationCountry}
                  </span>
                </span>
                <Badge tone="ok">{data.corridor.status.toUpperCase()}</Badge>
              </div>
              <p className="text-sm leading-relaxed text-muted">
                Minimum value USD {data.corridor.minVehiclePriceUsd.toLocaleString('en-US')} · currencies{' '}
                {data.corridor.allowedCurrencies.join(', ')} · mandatory workshop inspection before fund release.
              </p>
            </div>
          ) : null}

          {data.candidateCorridors.map((candidate) => (
            <div
              key={`${candidate.originCountry}-${candidate.destinationCountry}`}
              className="card p-6 bg-white space-y-3"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2.5 text-base font-semibold text-ink">
                  <span className="grid h-8 w-8 place-items-center rounded-xl bg-subtle text-muted">
                    <Icon name="globe" className="h-4 w-4" />
                  </span>
                  <span>
                    {candidate.originCountry} → {candidate.destinationCountry}
                  </span>
                </span>
                <Badge tone="neutral">Candidate</Badge>
              </div>
              <p className="text-sm leading-relaxed text-muted">{candidate.reason}</p>
            </div>
          ))}
        </div>
      </ScrollReveal>
    </div>
  );
}
