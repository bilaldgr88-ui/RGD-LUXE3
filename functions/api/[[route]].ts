import { createEdgeApiApp, type EdgeEnv } from '../../src/edge/apiApp';

const app = createEdgeApiApp();

export function onRequest(context: {
  request: Request;
  env: EdgeEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}) {
  return app.fetch(context.request, context.env, context as any);
}
