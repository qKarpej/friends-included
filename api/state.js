// Everything the current demonstration role is allowed to see.
import { handler } from '../lib/http.js';
import { getContext } from '../lib/context.js';

export default handler(['GET'], async ({ role }) => getContext().service.state(role));
