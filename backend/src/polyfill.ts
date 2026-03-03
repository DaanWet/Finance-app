// Node.js < 20 has no globalThis.File — polyfill it from the built-in 'buffer' module.
// This must be imported before any package that uses undici (e.g. googleapis).
import { File as NodeFile } from 'buffer';

if (typeof File === 'undefined') {
  Object.defineProperty(globalThis, 'File', {
    value: NodeFile,
    writable: true,
    configurable: true,
  });
}
