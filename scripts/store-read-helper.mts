/**
 * Fresh-process reader for store-smoke.mts.
 *
 * Importing the stores in a NEW process gives them a cold module cache,
 * so getAll()/getStats() exercise the real disk reload path (readDisk +
 * defaults merge) rather than the in-memory cache. Expects
 * $ZAPI_SMOKE_USERDATA to point at the temp userData dir (inherited env).
 * Prints one JSON line: { settings, usage }.
 *
 * Run only via bun with the electron stub preload:
 *   bun --preload ./scripts/store-preload.ts ./scripts/store-read-helper.mts
 */
import { getAll } from '../src/main/services/settings-store';
import { getStats } from '../src/main/services/usage-store';

console.log(JSON.stringify({ settings: getAll(), usage: getStats() }));
