/**
 * Baseline load test against the real running API (real Postgres/Redis, no
 * mocks). Exercises the two storefront paths a live deploy actually takes
 * the most traffic on: the public product listing (read) and order creation
 * (write — pricing, a DB transaction, and RLS on every query).
 *
 * Requires the app already running and reachable at BASE_URL, with a real
 * tenant and at least one published product.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000/api/v1 \
 *   TENANT_ID=<tenant-uuid> PRODUCT_ID=<product-uuid> \
 *   CONNECTIONS=25 DURATION=20 \
 *   npx ts-node scripts/load/storefront-load-test.ts
 */
import autocannon, { Result } from 'autocannon';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:3000/api/v1';
const tenantId = requireEnv('TENANT_ID');
const productId = requireEnv('PRODUCT_ID');
const connections = parseInt(process.env.CONNECTIONS ?? '25', 10);
const duration = parseInt(process.env.DURATION ?? '20', 10);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

function summarize(label: string, result: Result) {
  const errors = result.errors + result.timeouts + result.non2xx;
  console.log(`\n${label}`);
  console.log(`  requests/sec  : ${result.requests.average.toFixed(1)} (min ${result.requests.min}, max ${result.requests.max})`);
  console.log(`  latency (ms)  : p50=${result.latency.p50} p95=${result.latency.p97_5} p99=${result.latency.p99} max=${result.latency.max}`);
  console.log(`  throughput    : ${(result.throughput.average / 1024).toFixed(1)} KB/s`);
  console.log(`  total requests: ${result.requests.total}, errors: ${errors} (2xx-only counted as success)`);
  if (errors > 0) {
    console.log(`  ⚠ ${errors} non-2xx/timeout/error responses out of ${result.requests.total}`);
  }
  return { label, requestsPerSec: result.requests.average, p50: result.latency.p50, p95: result.latency.p97_5, p99: result.latency.p99, errors };
}

async function run(opts: autocannon.Options, label: string) {
  const result = await autocannon({ ...opts, connections, duration });
  return summarize(label, result);
}

async function main() {
  console.log(`Load test against ${baseUrl} — ${connections} connections, ${duration}s per scenario\n`);

  const results = [];

  results.push(
    await run(
      { url: `${baseUrl}/health`, method: 'GET' },
      'Scenario 1: GET /health (baseline, no DB query)',
    ),
  );

  results.push(
    await run(
      {
        url: `${baseUrl}/storefront/products`,
        method: 'GET',
        headers: { 'x-tenant-id': tenantId },
      },
      'Scenario 2: GET /storefront/products (public catalog read)',
    ),
  );

  results.push(
    await run(
      {
        url: `${baseUrl}/storefront/orders`,
        method: 'POST',
        headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Load Test Customer',
          customerPhone: '+15551234567',
          fulfillmentMethod: 'WHATSAPP',
          items: [{ productId, quantity: 1 }],
        }),
      },
      'Scenario 3: POST /storefront/orders (write — pricing + DB transaction + RLS)',
    ),
  );

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`${r.label.split(':')[0]}: ${r.requestsPerSec.toFixed(0)} req/s, p50=${r.p50}ms p95=${r.p95}ms p99=${r.p99}ms, errors=${r.errors}`);
  }
}

main().catch((err) => {
  console.error('Load test failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
