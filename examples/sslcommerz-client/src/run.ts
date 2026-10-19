import { createClientApp } from './client.js';

const port = Number(process.env['PORT'] ?? 4000);
const simBaseUrl = process.env['SIM_BASE_URL'] ?? 'http://localhost:3001';
const clientBaseUrl = process.env['CLIENT_BASE_URL'] ?? `http://localhost:${port}`;

const { app } = createClientApp({ simBaseUrl, clientBaseUrl });
app.listen(port, () => {
  console.log(`example shop: ${clientBaseUrl} (simulator: ${simBaseUrl})`);
});
