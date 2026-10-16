// One Linked app in its own process, for cookie-prefix.fuseki.test.mjs: the auth provider's
// middleware, a server-rendered page and the RPC route, on the dataset the parent created. The
// cookie prefix comes from the environment (AUTH_COOKIE_PREFIX, else APP_PREFIX), as in a real
// app. Prints its URL when listening.
//
// Runs against the BUILT package in lib/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-prefixed-app-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
const cleanup = () => fs.rmSync(workDir, { recursive: true, force: true });
process.on('exit', cleanup);
process.on('SIGTERM', () => process.exit(0));

const libDir = new URL('../../lib/esm/', import.meta.url);
const { default: express } = await import('express');
const { FusekiStore } = await import('@_linked/fuseki/shapes/FusekiStore');
const { LinkedStorage } = await import('@_linked/core/utils/LinkedStorage');
await import(new URL('shapes/index.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));

LinkedStorage.setDefaultDataset(
  new FusekiStore({
    endpoint: process.env.TEST_DATASET_ENDPOINT,
    credentials: {
      username: process.env.TEST_DATASET_USER,
      password: process.env.TEST_DATASET_PASSWORD,
    },
  })
);

const app = express();
app.lazyrouter();
const provider = new AuthBackendProvider(app, { callGenericBackendProvidersMethod: async () => {} });
await provider.setupBeforeControllers();
app.get('/page', (req, res) => res.json({ account: req.linkedAuth?.userAccount?.id ?? null }));
app.post('/call/@_linked/auth/:method', express.json(), async (req, res) => {
  provider.initRequest(req, res);
  const result = await provider[req.params.method](...(req.body?.args ?? []));
  if (!res.headersSent) res.json(result ?? null);
});
const server = http.createServer(app).listen(0, '127.0.0.1', () => {
  console.log(`LISTENING http://127.0.0.1:${server.address().port}`);
});
