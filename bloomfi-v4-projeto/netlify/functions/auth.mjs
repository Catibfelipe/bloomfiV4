// E-mail login codes get a much stricter rate limit to stop guessing.
import { handle } from '../../server/handler.js';

export default (req) => handle(req);

export const config = {
  path: ['/api/auth/*'],
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
