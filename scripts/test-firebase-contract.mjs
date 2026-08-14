// scripts/test-firebase-contract.mjs
//
// Firebase/Firestore is an existing production integration. This test guards the
// configuration contract so a clean rebuild can improve callers without silently
// renaming the service-account variable, database selector, or durable records.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const env = read('.env.sample');
const firestore = read('api/_lib/firestore.js');
const store = read('api/_lib/store.js');

const requiredEnvironmentVariables = [
  'FIREBASE_SERVICE_ACCOUNT',
  'FIRESTORE_DATABASE_ID',
  'FIRESTORE_TIMEOUT_MS',
  'FIRESTORE_COL_SUPPRESSION',
  'FIRESTORE_COL_LEADS',
  'FIRESTORE_COL_EVENTS',
  'FIRESTORE_COL_CALLS',
];

for (const variable of requiredEnvironmentVariables) {
  assert.match(env, new RegExp(`^${variable}=`, 'm'), `.env.sample must document ${variable}`);
}

assert.match(
  firestore,
  /process\.env\.FIREBASE_SERVICE_ACCOUNT/,
  'the Firestore adapter must keep reading the existing service-account variable'
);
assert.match(
  firestore,
  /process\.env\.FIRESTORE_DATABASE_ID \|\| '\(default\)'/,
  'the Firestore adapter must keep the existing default database selector'
);

const expectedCollections = {
  suppression: 'suppression',
  leads: 'leads',
  events: 'events',
  calls: 'calls',
  users: 'users',
};
for (const [name, defaultValue] of Object.entries(expectedCollections)) {
  assert.match(
    store,
    new RegExp(`${name}: process\\.env\\.FIRESTORE_COL_${name.toUpperCase()} \\|\\| '${defaultValue}'`),
    `the ${name} collection default must stay stable`
  );
}

assert.match(
  store,
  /return \{ suppressed: false, known: false, error: 'store_not_configured', at: null \};/,
  'an unavailable Firebase store must remain unknown so strict compliance can fail closed'
);

console.log('Firebase/Firestore contract OK: service account, database, collections, and fail-closed state are stable.');
