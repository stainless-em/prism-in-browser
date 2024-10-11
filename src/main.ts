import {
  createServer,
  getHttpOperationsFromSpec,
} from "./prism.js";
import spec from "./petstore.json";
import pino from "pino"
const operations = await getHttpOperationsFromSpec(spec);
const server = createServer(operations, {
  components: {
    logger: pino({
      base: {},
      customLevels: {
          success: pino.levels.values['info'] + 2,
      },
      level: 'success',
      timestamp: false,
    }) as any,
  },
  config: {
    checkSecurity: true,
    validateRequest: true,
    validateResponse: true,
    mock: { dynamic: false },
    errors: false,
    upstreamProxy: undefined,
    isProxy: false,
  },
});
(window as any).prismFetch = server.fetch;
