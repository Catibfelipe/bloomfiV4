// All BloomFi API routes except e-mail login (see auth.mjs).
import { handle } from '../../server/handler.js';

export default (req) => handle(req);

export const config = {
  path: ['/api/config', '/api/license', '/api/billing/*', '/api/of/*', '/api/push', '/api/push/*', '/api/sync'],
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
