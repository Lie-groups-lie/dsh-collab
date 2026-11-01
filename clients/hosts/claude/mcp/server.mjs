import { startServer } from '../lib/server.mjs';
import tools from './tools.json' with { type: 'json' };
import manifest from '../package.json' with { type: 'json' };
startServer(tools, manifest);
