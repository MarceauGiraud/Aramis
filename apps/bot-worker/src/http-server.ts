import * as http from 'http';
import * as promMetrics from './lib/prometheus-metrics';

/**
 * Create the HTTP server that serves health checks, Prometheus metrics,
 * and screenshot debug endpoints.
 */
export function createHttpServer(workerId: string): http.Server {
  return http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', workerId }));
      return;
    }

    if (req.url === '/metrics') {
      try {
        res.writeHead(200, { 'Content-Type': promMetrics.register.contentType });
        res.end(await promMetrics.register.metrics());
      } catch (err) {
        res.writeHead(500);
        res.end(`Error collecting metrics: ${err}`);
      }
      return;
    }

    // Serve screenshots: GET /screenshots/:meetingId
    const screenshotMatch = req.url?.match(/^\/screenshots\/([^/]+)$/);
    if (screenshotMatch && req.method === 'GET') {
      const meetingId = screenshotMatch[1];
      const screenshotDir = '/tmp/bot-screenshots';
      try {
        const fs = await import('fs');
        const files = fs
          .readdirSync(screenshotDir)
          .filter((f: string) => f.startsWith(meetingId) && f.endsWith('.png'))
          .sort();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ screenshots: files.map((f: string) => `/screenshot-file/${f}`) }));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ screenshots: [] }));
      }
      return;
    }

    // Serve a single screenshot file: GET /screenshot-file/:filename
    const fileMatch = req.url?.match(/^\/screenshot-file\/(.+\.png)$/);
    if (fileMatch && req.method === 'GET') {
      const filename = fileMatch[1];
      const filePath = `/tmp/bot-screenshots/${filename}`;
      try {
        const fs = await import('fs');
        if (fs.existsSync(filePath)) {
          const data = fs.readFileSync(filePath);
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
          });
          res.end(data);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      } catch {
        res.writeHead(500);
        res.end('Error reading file');
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });
}
