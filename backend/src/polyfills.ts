/**
 * polyfills.ts
 * Polyfills DOMMatrix and File on globalThis for Node.js 18 environment.
 * Must be imported at the very top of index.ts before anything else.
 */

if (!(globalThis as any).DOMMatrix) {
  (globalThis as any).DOMMatrix = class DOMMatrix {};
}

if (!(globalThis as any).File) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (globalThis as any).File = require('node:buffer').File;
  } catch {
    // Fallback if not available
    (globalThis as any).File = class File {};
  }
}
