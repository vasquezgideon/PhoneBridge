// Regenerates protocol/test-vectors/handshake-v1.json. Only run when the protocol changes on purpose;
// the Swift tests (ios/PhoneBridgeCore) and JS tests both check against this file.
import { writeFile } from 'node:fs/promises';
import { computeVectors } from '../tests/lib.mjs';

const out = new URL('../../protocol/test-vectors/handshake-v1.json', import.meta.url);
await writeFile(out, JSON.stringify(await computeVectors(), null, 2) + '\n');
console.log('wrote', out.pathname);
