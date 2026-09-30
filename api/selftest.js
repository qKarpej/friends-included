// Runs the homework's own test script against an isolated in-memory copy of the
// real processing layer. Never touches live data, so anyone may run it.
import { handler } from '../lib/http.js';
import { runScenario } from '../lib/scenario.js';

export default handler(['GET'], async () => runScenario());
