#!/usr/bin/env node
/**
 * Run the VIN API "Postman local collection" folders without the Postman app.
 *
 * The collection under `postman/collections/VIN API` is exported as one YAML
 * file per request, so it can be executed by a small runner: this script reads
 * the requests in `order`, runs their `beforeRequest` / `afterResponse`
 * scripts against a `pm` shim (`pm.test`, `pm.expect`, `pm.response`,
 * `pm.collectionVariables`), and reports per-request and per-assertion
 * results. It is the regression guard for the API flows in CI, and a way to
 * run the same folders locally.
 *
 * It intentionally implements only the small slice of the Postman scripting
 * API that this collection uses. If a script starts using something else,
 * extend the shim rather than screening it out: the collection is the
 * regression suite, and silently skipping a request would defeat the purpose.
 *
 * Usage:
 *   node tools/collection-runner.mjs                        # the three flow folders
 *   node tools/collection-runner.mjs --folder "Meta"        # one folder by name
 *   node tools/collection-runner.mjs --all                  # every folder
 *   node tools/collection-runner.mjs --list                 # show folder names
 *
 * Options:
 *   --base <url>        API base URL (default $VIN_BASE_URL or http://127.0.0.1:8080)
 *   --folder <name>     folder to run; repeatable
 *   --all               run every folder that contains request files
 *   --list              list the folder names and exit
 *   --collection <dir>  collection directory (default postman/collections/VIN API)
 *
 * Exit code: 0 when every assertion passes, 1 on any failure, 2 on a bad
 * invocation (unknown folder, missing collection).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const flags = new Set(argv.filter((a) => a.startsWith('--')));

const BASE = arg('--base') ?? process.env.VIN_BASE_URL ?? 'http://127.0.0.1:8080';
const COLLECTION_DIR = path.resolve(
  arg('--collection') ?? path.join(REPO_ROOT, 'postman', 'collections', 'VIN API'),
);
const DEFINITION = path.join(COLLECTION_DIR, '.resources', 'definition.yaml');

/** The flows that guard behaviour; run these by default. */
const DEFAULT_FOLDERS = ['E2E Happy Path', 'E2E Dispute Path', 'Regression - Odometer Baseline'];

const wanted = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--folder' && argv[i + 1] !== undefined) wanted.push(argv[i + 1]);
}

if (!fs.existsSync(COLLECTION_DIR)) {
  console.error(`collection directory not found: ${COLLECTION_DIR}`);
  process.exit(2);
}

const folderNames = fs
  .readdirSync(COLLECTION_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name)
  .filter((name) => fs.readdirSync(path.join(COLLECTION_DIR, name)).some((f) => f.endsWith('.request.yaml')))
  .sort((a, b) => a.localeCompare(b));

if (flags.has('--list')) {
  console.log('folders with requests:');
  for (const name of folderNames) console.log(`  - ${name}`);
  process.exit(0);
}

const selected = flags.has('--all') ? folderNames : wanted.length > 0 ? wanted : DEFAULT_FOLDERS;
for (const name of selected) {
  if (!folderNames.includes(name)) {
    console.error(`unknown folder: ${name}\navailable folders:\n  ${folderNames.join('\n  ')}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Collection variables (definition.yaml -> variables:)
// ---------------------------------------------------------------------------
const vars = {};
if (fs.existsSync(DEFINITION)) {
  const def = YAML.parse(fs.readFileSync(DEFINITION, 'utf8'));
  for (const [k, v] of Object.entries(def.variables ?? {})) vars[k] = v === null ? '' : String(v);
}
vars.baseUrl = BASE;

// ---------------------------------------------------------------------------
// {{...}} resolution, including Postman dynamic variables the collection uses
// ---------------------------------------------------------------------------
let dynamicCount = 0;
const dynamicValue = (name) => {
  switch (name) {
    case '$timestamp':
      // Postman resolves $timestamp to the current Unix time in seconds. Two
      // calls inside one run must differ (unique VINs), hence the counter.
      dynamicCount += 1;
      return String(Math.floor(Date.now() / 1000) + dynamicCount);
    case '$randomInt':
      return String(Math.floor(Math.random() * 1000));
    case '$guid':
    case '$uuid':
      return crypto.randomUUID();
    case '$isoTimestamp':
      return new Date().toISOString();
    default:
      return '';
  }
};
const resolve = (text, unset) =>
  String(text).replace(/\{\{([^}]+)\}\}/g, (_m, raw) => {
    const name = String(raw).trim();
    if (name.startsWith('$')) return dynamicValue(name);
    if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name] ?? '');
    if (!unset.includes(name)) unset.push(name);
    return '';
  });

// ---------------------------------------------------------------------------
// pm.expect: the small chai surface this collection uses
// ---------------------------------------------------------------------------
const fmt = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));

class Expectation {
  constructor(value, fail) {
    this._v = value;
    this._fail = fail;
    this._neg = false;
  }
  get to() { return this; }
  get be() { return this; }
  get is() { return this; }
  get that() { return this; }
  get which() { return this; }
  get and() { return this; }
  get has() { return this; }
  get have() { return this; }
  get with() { return this; }
  get at() { return this; }
  get of() { return this; }
  get same() { return this; }
  get not() { this._neg = true; return this; }
  get ok() { return this._check(Boolean(this._v), 'expected a truthy value'); }
  get true() { return this._check(this._v === true, `expected ${fmt(this._v)} to be true`); }
  get false() { return this._check(this._v === false, `expected ${fmt(this._v)} to be false`); }
  get null() { return this._check(this._v === null, `expected ${fmt(this._v)} to be null`); }
  get undefined() { return this._check(this._v === undefined, `expected ${fmt(this._v)} to be undefined`); }
  get empty() {
    const isEmpty =
      this._v === '' || this._v === null || this._v === undefined ||
      (Array.isArray(this._v) && this._v.length === 0) ||
      (typeof this._v === 'object' && Object.keys(this._v).length === 0);
    return this._check(isEmpty, `expected ${fmt(this._v)} to be empty`);
  }
  a(kind) {
    const t = typeof this._v;
    const table = {
      string: t === 'string',
      number: t === 'number' && Number.isFinite(this._v),
      boolean: t === 'boolean',
      object: this._v !== null && t === 'object' && !Array.isArray(this._v),
      array: Array.isArray(this._v),
    };
    const ok = Object.prototype.hasOwnProperty.call(table, kind) ? table[kind] : t === kind;
    return this._check(ok, `expected ${fmt(this._v)} to be a ${kind}`);
  }
  an(kind) {
    return this.a(kind);
  }
  /**
   * chai's `.property(name[, value])`: asserts the property exists on an object
   * (or a matching entry exists in an array), and, when a value is given, that
   * it equals the expected one.
   */
  property(name, value) {
    const target = this._v;
    let present = false;
    let actual;
    if (Array.isArray(target)) {
      for (const item of target) {
        if (item !== null && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, name)) {
          present = true;
          actual = item[name];
          break;
        }
      }
    } else if (target !== null && typeof target === 'object') {
      present = Object.prototype.hasOwnProperty.call(target, name);
      actual = present ? target[name] : undefined;
    }
    const matches = arguments.length < 2 ? present : present && isDeepStrictEqual(actual, value);
    const detail = arguments.length < 2 ? `to have property ${fmt(name)}` : `to have property ${fmt(name)} equal to ${fmt(value)}`;
    return this._check(matches, `expected ${fmt(target)} ${detail}`);
  }
  within(lo, hi) {
    return this._check(typeof this._v === 'number' && this._v >= lo && this._v <= hi, `expected ${fmt(this._v)} to be within ${lo}..${hi}`);
  }
  above(n) { return this._check(typeof this._v === 'number' && this._v > n, `expected ${fmt(this._v)} to be above ${n}`); }
  below(n) { return this._check(typeof this._v === 'number' && this._v < n, `expected ${fmt(this._v)} to be below ${n}`); }
  least(n) { return this._check(typeof this._v === 'number' && this._v >= n, `expected ${fmt(this._v)} to be at least ${n}`); }
  most(n) { return this._check(typeof this._v === 'number' && this._v <= n, `expected ${fmt(this._v)} to be at most ${n}`); }
  eql(expected) { return this._check(isDeepStrictEqual(this._v, expected), `expected ${fmt(this._v)} to equal ${fmt(expected)}`); }
  equal(expected) { return this._check(this._v === expected, `expected ${fmt(this._v)} to equal ${fmt(expected)}`); }
  equals(expected) { return this.equal(expected); }
  include(needle) {
    const ok =
      typeof this._v === 'string' ? this._v.includes(needle) :
      Array.isArray(this._v) ? this._v.some((x) => isDeepStrictEqual(x, needle)) : false;
    return this._check(ok, `expected ${fmt(this._v)} to include ${fmt(needle)}`);
  }
  match(re) { return this._check(new RegExp(re).test(String(this._v)), `expected ${fmt(this._v)} to match ${re}`); }
  lengthOf(n) { return this._check(this._v != null && this._v.length === n, `expected length ${n}`); }
  _check(ok, message) {
    const passed = this._neg ? !ok : ok;
    if (!passed) this._fail(this._neg ? message.replace(' to ', ' not to ') : message);
    return this;
  }
}

// ---------------------------------------------------------------------------
// Run one folder
// ---------------------------------------------------------------------------
const onGitHub = process.env.GITHUB_ACTIONS === 'true';

async function runFolder(folderName) {
  const dir = path.join(COLLECTION_DIR, folderName);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.request.yaml'))
    .map((f) => ({ f, doc: YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }))
    .sort((a, b) => (a.doc.order ?? 0) - (b.doc.order ?? 0));

  const rows = [];
  const failures = [];

  for (const { f, doc } of files) {
    const name = doc.name ?? f;
    const unset = [];
    const logs = [];
    const tests = [];
    let status = null;
    let requestError = null;

    const pm = {
      collectionVariables: {
        get: (k) => vars[k],
        set: (k, v) => { vars[k] = v === null || v === undefined ? '' : String(v); },
        has: (k) => Object.prototype.hasOwnProperty.call(vars, k),
        unset: (k) => { delete vars[k]; },
      },
      variables: { get: (k) => vars[k], set: (k, v) => { vars[k] = String(v); } },
      environment: { get: (k) => vars[k], set: (k, v) => { vars[k] = String(v); } },
      iteration: 1,
      test: (testName, fn) => {
        try {
          fn();
          tests.push({ name: testName, passed: true });
        } catch (e) {
          tests.push({ name: testName, passed: false, error: e && e.message ? e.message : String(e) });
        }
      },
      expect: (value, msg) => new Expectation(value, (m) => { throw new Error(msg ? `${msg}: ${m}` : m); }),
      response: null,
    };
    const context = vm.createContext({
      pm,
      console: { log: (...a) => logs.push(a.join(' ')) },
      crypto,
      Date,
      Math,
      JSON,
    });

    const runScripts = (type) => {
      for (const s of doc.scripts ?? []) {
        if (s.type !== type) continue;
        new vm.Script(s.code, { filename: `${folderName}/${name}:${type}` }).runInContext(context);
      }
    };

    try {
      runScripts('beforeRequest');
      let url = resolve(doc.url, unset);
      for (const pv of doc.pathVariables ?? []) {
        url = url.replaceAll(`:${pv.key}`, encodeURIComponent(resolve(pv.value, unset)));
      }
      const headers = {};
      for (const h of doc.headers ?? []) headers[h.key] = resolve(h.value, unset);
      const method = doc.method ?? 'GET';
      const init = { method, headers, signal: AbortSignal.timeout(30000) };
      if (doc.body?.content !== undefined && !['GET', 'HEAD'].includes(method)) {
        init.body = resolve(doc.body.content, unset);
      }
      const res = await fetch(url, init);
      const text = await res.text();
      status = res.status;
      // Postman's `pm.response.headers` is a header list, not a plain object:
      // the collection reads headers through `.get(name)`, and Postman matches
      // names case-insensitively. Provide that surface (plus `.has`/`.all`)
      // over the fetched headers while keeping the raw map for inspection.
      const rawHeaders = Object.fromEntries(res.headers.entries());
      const headerList = {
        ...rawHeaders,
        get: (name) => {
          const wanted = String(name).toLowerCase();
          for (const [key, value] of Object.entries(rawHeaders)) {
            if (key.toLowerCase() === wanted) return value;
          }
          return undefined;
        },
        has: (name) => headerList.get(name) !== undefined,
        all: () => Object.entries(rawHeaders).map(([key, value]) => ({ key, value })),
      };
      pm.response = {
        code: res.status,
        status: res.statusText,
        text: () => text,
        json: () => JSON.parse(text),
        headers: headerList,
        to: {
          get have() { return this; },
          get be() { return this; },
          status(code) {
            if (res.status !== code) throw new Error(`expected response to have status ${code} but got ${res.status}`);
            return this;
          },
        },
      };
      pm.request = { url, method, headers };
      runScripts('afterResponse');
    } catch (e) {
      requestError = e && e.message ? e.message : String(e);
    }

    const passed = tests.filter((t) => t.passed).length;
    for (const t of tests.filter((x) => !x.passed)) {
      failures.push({ request: name, test: t.name, error: t.error });
    }
    if (requestError) failures.push({ request: name, test: '(request)', error: requestError });
    rows.push({ name, status, tests, passed, requestError, unset, logs });
  }

  return { folderName, rows, failures };
}

// ---------------------------------------------------------------------------
// Drive every selected folder and summarise
// ---------------------------------------------------------------------------
const results = [];
for (const folderName of selected) {
  console.log(`\n== ${folderName} ==`);
  const r = await runFolder(folderName);
  for (const row of r.rows) {
    const total = row.tests.length;
    const failed = row.tests.filter((t) => !t.passed);
    console.log(
      `${row.status === null ? 'ERR ' : String(row.status).padEnd(4)} ${row.name}` +
        `  [tests ${row.passed}/${total}${failed.length ? ` — FAILED: ${failed.map((t) => t.name).join('; ')}` : ''}]` +
        `${row.unset.length ? `  (unset variables: ${row.unset.join(', ')})` : ''}`,
    );
    for (const t of failed) console.log(`       x ${t.name}\n         -> ${t.error}`);
    if (row.requestError) console.log(`       ! ${row.requestError}`);
    for (const line of row.logs) console.log(`       · ${line}`);
  }
  results.push(r);
}

const totalTests = results.reduce((n, r) => n + r.rows.reduce((m, row) => m + row.tests.length, 0), 0);
const totalPassed = results.reduce((n, r) => n + r.rows.reduce((m, row) => m + row.passed, 0), 0);
const totalFailures = results.reduce((n, r) => n + r.failures.length, 0);

console.log('\n==========================================================');
console.log(`base url : ${BASE}`);
for (const r of results) {
  const t = r.rows.reduce((m, row) => m + row.tests.length, 0);
  const p = r.rows.reduce((m, row) => m + row.passed, 0);
  const ok = r.rows.filter((row) => row.status !== null && row.status >= 200 && row.status < 300).length;
  console.log(`${r.folderName.padEnd(34)} requests ${ok}/${r.rows.length} 2xx   assertions ${p}/${t}`);
}
console.log(`TOTAL: ${totalPassed}/${totalTests} assertions passed, ${totalFailures} failed`);
console.log('==========================================================');

if (onGitHub && totalFailures > 0) {
  for (const r of results) {
    for (const f of r.failures) {
      const line = `${r.folderName} :: ${f.request} :: ${f.test} -> ${f.error}`.replace(/\s*\n\s*/g, ' | ').slice(0, 400);
      console.log(`::error::${line}`);
    }
  }
}

process.exit(totalFailures > 0 ? 1 : 0);
