import { spawnSync } from 'node:child_process';
const database = process.argv[2];
if (!/^publium_audit_(clean|restore)_\d{8}$/.test(database ?? '')) throw new Error('Only isolated audit databases are allowed');
const url = new URL(process.env.DATABASE_URL);
url.pathname = `/${database}`;
const testEnv = { ...process.env, DATABASE_URL: url.href, DIRECT_URL: url.href, NODE_ENV: 'test', PUBLIC_BASE_URL: 'https://example.com' };
for (const key of Object.keys(testEnv)) if (/TOKEN|SECRET|API_KEY|ENCRYPTION_KEY|TELEGRAM_API/.test(key)) testEnv[key] = '';
testEnv.TELEGRAM_BOT_TOKEN = 'audit-token';
testEnv.TELEGRAM_WEBHOOK_SECRET = 'audit-secret';
function run(args) {
  const result = spawnSync(process.execPath, args, { env: testEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
run(['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-schema-datasource', 'prisma/schema.prisma', '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code']);
run(['scripts/audit-integration.mjs']);
console.log(`PASS migrations, schema parity and integration: ${database}`);
