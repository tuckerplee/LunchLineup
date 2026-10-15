// Local drill only. Stand-in for the owner's alert endpoint (Slack relay, pager,
// email/SMS gateway): records every Alertmanager webhook POST as one JSON line
// and exposes the log at GET /received so the drill can assert delivery.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const logPath = process.env.DRILL_WEBHOOK_LOG ?? '/tmp/received.jsonl';
const port = Number(process.env.DRILL_WEBHOOK_PORT ?? 8080);

createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/received') {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.end(existsSync(logPath) ? readFileSync(logPath) : '');
    return;
  }
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    if (request.method === 'POST' && request.url?.startsWith('/alert')) {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = { unparsed: body }; }
      appendFileSync(logPath, `${JSON.stringify({ receivedAt: new Date().toISOString(), path: request.url, payload })}\n`);
      response.writeHead(200).end('ok\n');
      return;
    }
    response.writeHead(404).end();
  });
}).listen(port, '0.0.0.0');
