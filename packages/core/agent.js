import { readFileSync } from 'node:fs';

// The name every request goes out under. Wikimedia and OpenStreetMap ask for the
// program, its version and a way to reach the project: `homepage` in package.json.
const { version, homepage } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const USER_AGENT = `Obelisk/${version} (${homepage ? `${homepage}; ` : ''}personal offline library)`;
