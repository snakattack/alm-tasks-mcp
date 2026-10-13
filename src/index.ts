import { asCrmError } from './errors.js';
import { serve } from './runtime.js';

try {
  await serve();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: asCrmError(error).toJSON() })}\n`);
  process.exitCode = 1;
}
