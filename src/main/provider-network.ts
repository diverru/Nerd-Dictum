import { Agent, setGlobalDispatcher } from 'undici';

export function configureProviderNetwork(): Agent {
  const agent = new Agent({
    keepAliveTimeout: 600_000,
    keepAliveMaxTimeout: 600_000,
    connect: { timeout: 3_000, keepAlive: true, keepAliveInitialDelay: 30_000 },
    headersTimeout: 5_000,
    bodyTimeout: 60_000,
    pipelining: 1,
  });
  setGlobalDispatcher(agent);
  return agent;
}
