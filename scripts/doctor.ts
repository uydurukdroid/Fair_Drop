import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const major = Number(process.versions.node.split('.')[0]);
const checks = [
  ['Node 24 LTS', major === 24],
  ['schema.sql', existsSync(resolve('server/db/schema.sql'))],
  ['synthetic fixture', existsSync(resolve('fixtures/synthetic/observations.ts'))],
  ['.env.example', existsSync(resolve('.env.example'))],
];
for (const [label, passed] of checks) console.log(`${passed ? '✓' : '✗'} ${label}`);
if (checks.some(([, passed]) => !passed)) process.exitCode = 1;
