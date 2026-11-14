import { verifyLocalSnapshot } from './local-snapshot.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-snapshot.mjs <snapshot-directory>');
console.log(JSON.stringify(await verifyLocalSnapshot(process.argv[2])));
