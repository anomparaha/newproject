// One-shot enrichment of the "VIN API" collection:
//  - inserts a Markdown `description` into every request that lacks one
//  - appends an afterResponse test `scripts` block to CRUD requests that lack one
// Idempotent + preserves each file's own line endings. Run: node tools/enrich-collection.mjs
//
// The collection directory defaults to the one inside this checkout, so the
// script works on any machine; override it with VIN_COLLECTION_DIR (or the
// same `--collection <dir>` the runner accepts) for another checkout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argCollection = (() => {
  const i = process.argv.indexOf('--collection');
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : null;
})();
const ROOT = path.resolve(
  argCollection ??
    process.env.VIN_COLLECTION_DIR ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'postman', 'collections', 'VIN API'),
);
if (!fs.existsSync(ROOT)) {
  console.error(`collection directory not found: ${ROOT}`);
  process.exit(2);
}

// relpath (folder/base, no extension) -> { shape } for files that should ALSO get a test block.
// shape: { list:'key' } | { key:'key' } | { object:true }
const TEST_TARGETS = {
  'Corridors/List Corridors': { list: 'corridors' },
  'Corridors/Create Corridor': { key: 'corridor' },
  'Corridors/Corridor Metrics': { object: true },
  'Deals/Commit Deal': { key: 'deal' },
  'Deals/Fund Deal': { object: true },
  'Deals/Upload Report': { key: 'report' },
  'Deals/Accept Report': { object: true },
  'Deals/Confirm Handover': { object: true },
  'Deals/Release Vehicle': { object: true },
  'Deals/Open Dispute': { key: 'dispute' },
  'Deals/Resolve Dispute': { object: true },
  'Deals/List Deals': { list: 'deals' },
  'Deals/Get Deal': { key: 'deal' },
  'Deals/Deal Escrows': { list: 'escrows' },
  'Deals/List Notes': { list: 'notes' },
  'Deals/Note Metadata': { object: true },
  'Listings/Create Listing': { key: 'listing' },
  'Listings/Get Listing': { key: 'listing' },
  'Listings/List Listings': { list: 'listings' },
  'Listings/Update Listing': { object: true },
  'Listings/VIN Lookup': { object: true },
  'Meta/Demo Actors': { list: 'actors' },
  'Meta/Policy': { key: 'platform' },
  'Meta/Token Metrics': { list: 'lockBonds' },
  'Reputation/Actor Reputation': { key: 'reputation' },
  'Reputation/List Inspectors': { list: 'inspectors' },
};

// Hand-written purpose line per non-flow request (first paragraph of its description).
const PURPOSE = {
  'Corridors/List Corridors': 'List trade corridors that are open or candidate, each with its own rules (minimum vehicle value, allowed currencies, mandatory inspection).',
  'Corridors/Create Corridor': 'Open a new trade corridor. Only a curator may open one, and only once the existing corridor is healthy (enough completed deals, dispute rate under control).',
  'Corridors/Corridor Metrics': 'Public health metrics for a corridor: completed deals, median time-to-report, dispute rate, plus the thresholds that halt expansion.',
  'Deals/Commit Deal': 'Buyer locks a deal against a listing and chooses the inspection workshop. Starts the escrow lifecycle.',
  'Deals/Fund Deal': 'Fund the deal escrow (vehicle leg + inspection leg). Moves the deal into the inspecting state.',
  'Deals/Upload Report': 'Inspection workshop uploads its report for the deal. The odometer reading is checked against the VIN\'s highest recorded value (max-odometer baseline) to flag rollback anomalies.',
  'Deals/Accept Report': 'Buyer accepts the uploaded inspection report, which releases the inspection fee to the workshop (minus the platform fee).',
  'Deals/Confirm Handover': 'Buyer or seller confirms physical handover of the vehicle. Both confirmations are needed before funds release.',
  'Deals/Release Vehicle': 'Release the vehicle-leg escrow funds to the seller once the handover preconditions are met.',
  'Deals/Open Dispute': 'A party to the deal opens a dispute, which freezes the escrow until an arbiter rules.',
  'Deals/Resolve Dispute': 'Arbiter rules on a dispute (for example refund the buyer) and settles both the vehicle and inspection legs.',
  'Deals/List Deals': 'List deals.',
  'Deals/Get Deal': 'Fetch a single deal together with its events, inspection reports, dispute, and digital receipts.',
  'Deals/Deal Escrows': 'List the escrow legs (vehicle + inspection) for a deal and their current status.',
  'Deals/List Notes': 'List digital receipts (notes) — the immutable proof records produced by completed deals.',
  'Deals/Note Metadata': 'Fetch the metadata and evidence trail for a single digital receipt.',
  'Listings/Create Listing': 'Create a vehicle listing locked to a VIN/chassis number. A listing above the corridor value threshold also requires seller verification and a locked bond.',
  'Listings/Get Listing': 'Fetch a single listing by id.',
  'Listings/List Listings': 'List vehicle listings.',
  'Listings/Update Listing': 'Update an existing listing (price, shipping terms, status, etc.).',
  'Listings/VIN Lookup': 'Look up the full history recorded against a VIN/chassis number (listings, reports, odometer readings).',
  'Meta/Demo Actors': 'List demo personas for choosing an actor in the UI. Demo-mode only; production uses Sign-In With Solana and identity attestations instead of the x-actor-id header.',
  'Meta/Policy': 'All public platform policy in one place so it can be audited: fees, bonds, capacity, token utility, publication stages, and halt thresholds.',
  'Meta/Token Metrics': 'The only token metric the platform claims: locked bonds by currency, active stakeholders, and the count of bonds slashed/returned.',
  'Meta/Health': 'Liveness/health check. Returns status, service name, lifecycle stage, and the configured escrow provider.',
  'Reputation/Actor Reputation': 'Reputation for an actor: deals completed, disputes opened/lost, on-time report rate, and standard-compliance rate. Recomputed on read.',
  'Reputation/List Inspectors': 'Ranked list of verified inspection workshops. Order comes from report/dispute performance and is not for sale.',
};

const FLOW = {
  '0. Setup': (n) => `Setup step (${n}) that seeds baseline demo data used by the other folders. Run the whole \`0. Setup\` folder after every \`npm run seed:reset\`, because seeding mints fresh IDs.`,
  'E2E Happy Path': (n) => `End-to-end happy-path step: ${n}. Runs in order to take a listing from creation through funded escrow, inspection, acceptance, handover, and vehicle release.`,
  'E2E Dispute Path': (n) => `End-to-end dispute-path step: ${n}. Runs in order to drive a deal into a dispute and an arbiter-ordered buyer refund.`,
  'Regression - Odometer Baseline': (n) => `Odometer-baseline regression step: ${n}. Proves a VIN\'s highest recorded odometer cannot be reset by relisting the same car at a lower reading.`,
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.request.yaml')) out.push(full);
  }
  return out;
}

function relKey(full) {
  return path.relative(ROOT, full).replace(/\\/g, '/').replace(/\.request\.yaml$/, '');
}

function nameFromContent(content, base) {
  const m = content.match(/^name:\s*(.+?)\s*$/m);
  if (!m) return base;
  return m[1].replace(/^['"]|['"]$/g, '');
}

function buildDescription(lines, nl) {
  let out = 'description: |-' + nl;
  for (const l of lines) out += (l === '' ? '' : '  ' + l) + nl;
  return out;
}

function shapeLine(shape) {
  if (shape.list) return `pm.test('${shape.list} array', () => { pm.expect(b).to.have.property('${shape.list}'); pm.expect(b.${shape.list}).to.be.an('array'); });`;
  if (shape.key) return `pm.test('has ${shape.key}', () => pm.expect(b).to.have.property('${shape.key}'));`;
  return `pm.test('object body', () => pm.expect(b).to.be.an('object'));`;
}

function buildScripts(shape, nl) {
  const code = [
    `pm.test('no server error', () => pm.expect(pm.response.code).to.be.below(500));`,
    `pm.test('json response', () => pm.expect(pm.response.headers.get('Content-Type') || '').to.include('application/json'));`,
    `if (pm.response.code < 300) {`,
    `  const b = pm.response.json();`,
    `  ${shapeLine(shape)}`,
    `}`,
  ];
  let out = 'scripts:' + nl;
  out += '  - type: afterResponse' + nl;
  out += '    language: text/javascript' + nl;
  out += '    code: |-' + nl;
  for (const l of code) out += '      ' + l + nl;
  return out;
}

function insertAfterAnchor(content, insertText) {
  let m = content.match(/^name:.*$/m);
  if (!m) m = content.match(/^\$kind:.*$/m);
  if (!m) return content; // shouldn't happen
  let end = m.index + m[0].length;
  if (content.startsWith('\r\n', end)) end += 2;
  else if (content[end] === '\n') end += 1;
  return content.slice(0, end) + insertText + content.slice(end);
}

const files = walk(ROOT);
let descAdded = 0, scriptsAdded = 0, descTotal = 0, scriptsTotal = 0;

for (const full of files) {
  const key = relKey(full);
  const topFolder = key.split('/')[0];
  const base = key.split('/').pop();
  let content = fs.readFileSync(full, 'utf8');
  // Preserve the file's own line endings: the repo stores these YAML files with
  // LF, while a Windows checkout with core.autocrlf checks them out as CRLF.
  const NL = content.includes('\r\n') ? '\r\n' : '\n';
  const hasDesc = /^description:/m.test(content);
  const hasScripts = /^scripts:/m.test(content);

  // 1) description
  if (!hasDesc) {
    const display = nameFromContent(content, base);
    const method = (content.match(/^method:\s*(\w+)/m) || [])[1] || 'GET';
    let urlPath = (content.match(/^url:\s*['"]?\{\{baseUrl\}\}([^'"\r\n]*)/m) || [])[1];
    if (!urlPath) urlPath = (content.match(/^url:\s*['"]?([^'"\r\n]*)/m) || [])[1] || '';
    const hasActor = /x-actor-id/i.test(content);
    let purpose;
    if (PURPOSE[key]) purpose = PURPOSE[key];
    else if (FLOW[topFolder]) purpose = FLOW[topFolder](display);
    else purpose = `${method} ${urlPath} endpoint of the VIN API.`;
    const codeLine = '`' + method + ' ' + urlPath + '`' + (hasActor ? ' Requires an `x-actor-id` header identifying the caller.' : '');
    content = insertAfterAnchor(content, buildDescription([purpose, '', codeLine], NL));
    descAdded++;
  }
  descTotal++;

  // 2) scripts (only CRUD test targets, only if none present)
  if (TEST_TARGETS[key] && !hasScripts) {
    if (!content.endsWith(NL)) content += NL;
    content += buildScripts(TEST_TARGETS[key], NL);
    scriptsAdded++;
  }
  if (/^scripts:/m.test(content)) scriptsTotal++;

  fs.writeFileSync(full, content, 'utf8');
}

console.log(`files scanned: ${files.length}`);
console.log(`descriptions added this run: ${descAdded}`);
console.log(`descriptions present now: ${descTotal}`);
console.log(`test blocks added this run: ${scriptsAdded}`);
console.log(`requests with scripts now: ${scriptsTotal}`);
