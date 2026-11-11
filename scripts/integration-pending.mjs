import { spawnSync } from 'node:child_process';

if (process.env.OBJECT_STORAGE_LIVE_TEST !== '1') {
  console.error('Live bucket test is not configured. Supply OBJECT_STORAGE_LIVE_TEST=1 and OBJECT_STORAGE_S3_* outside this repository.');
  process.exit(2);
}

const result = spawnSync('npx', ['vitest', 'run', 'tests/integration/live-bucket.test.ts'], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
