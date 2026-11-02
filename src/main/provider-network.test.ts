import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';

// Bun's fetch does not use Node's global dispatcher. Run the actual Node transport.
it('reuses Node fetch connections after 31 seconds idle and reconnects after server closure', () => {
  const result = spawnSync('node', ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import { once } from 'node:events';
    import { setTimeout as delay } from 'node:timers/promises';
    const { configureProviderNetwork } = await import(${JSON.stringify(new URL('./provider-network.ts', import.meta.url).href)});
    const agent = configureProviderNetwork();
    let connections = 0;
    const server = http.createServer((req, res) => {
      // No server timeout hint: exercise the client's own idle policy.
      res.setHeader('Keep-Alive', 'max=1000');
      res.end('ok');
    });
    server.keepAliveTimeout = 600_000;
    server.on('connection', () => connections++);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port;
    try {
      assert.equal(await (await fetch(url)).text(), 'ok');
      await delay(31_000);
      assert.equal(await (await fetch(url)).text(), 'ok');
      assert.equal(connections, 1, 'idle request should reuse the original socket');
      await delay(20);
      server.closeIdleConnections();
      await delay(50);
      assert.equal(await (await fetch(url)).text(), 'ok');
      assert.equal(connections, 2, 'server closure should cause a fresh connection');
      console.log('reused after 31s idle; reconnected after server closed socket');
    } finally {
      await agent.close();
      server.closeAllConnections();
      server.close();
    }
  `], { encoding: 'utf8', timeout: 40_000 });
  expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toMatchObject({ status: 0 });
}, 45_000);
