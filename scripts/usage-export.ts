import { writeFileSync } from 'node:fs';
import { apiUsage, db } from '../server/db/database.ts';

db();
const rows = apiUsage();
const header = [
  'campaign_id',
  'endpoint',
  'purpose',
  'status',
  'request_id',
  'credits_used',
  'cache_hit',
  'valid_data',
  'created_at',
];
const csv = [
  header.join(','),
  ...rows.map((row) => header.map((key) => JSON.stringify(row[key] ?? '')).join(',')),
].join('\n');
writeFileSync('usage.csv', `${csv}\n`, 'utf8');
console.log(`Wrote usage.csv with ${rows.length} provider records`);
