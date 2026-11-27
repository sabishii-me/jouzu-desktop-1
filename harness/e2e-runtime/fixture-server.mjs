import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// Deterministic loopback provider for exercising the desktop's RPC path.
// It is test-only: no network, no credentials, no runtime patch.

/** Pixel sizes of the PNG images a request carries (from each image's header). */
function imageSizes(messages) {
  const sizes = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const url = part?.type === 'image_url' ? String(part.image_url?.url ?? '') : '';
      const data = /^data:image\/png;base64,(.+)$/u.exec(url)?.[1];
      if (!data) continue;
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR') sizes.push([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]);
    }
  }
  return sizes;
}

/**
 * Provider faults a test switches on and off while the app runs, to see what the
 * person sees when the model provider misbehaves. POST /__fault with one of:
 *   {}                                   no fault (the default)
 *   { status: 401|404|429|500, message } each request is refused with that status and an
 *                                        OpenAI-style error body: key rejected, model
 *                                        gone, rate limited, provider failure
 *   { reset: true }                      the connection drops before any answer
 *                                        (provider or network unreachable)
 *   { hang: true }                       requests are accepted and never answered; clearing
 *                                        the fault drops the held connections
 *   { firstByteMs: n }                   the answer starts after n ms
 *   { cutAfter: n }                      n pieces of text are streamed, then the
 *                                        connection drops
 *   { requireKey: "k" }                  a request without "Authorization: Bearer k" is refused
 *                                        (401): a rotated key the session must pick up
 *   { refuseImages: true }               a request carrying any image is refused (400) with
 *                                        the provider text of #17
 * GET /__fault returns the fault, the requests answered and the requests refused.
 */
const faultBodies = {
  401: { code: 'invalid_api_key', type: 'invalid_request_error', message: 'Incorrect API key provided.' },
  404: { code: 'model_not_found', type: 'invalid_request_error', message: 'The model `deterministic` does not exist or you do not have access to it.' },
  429: { code: 'rate_limit_exceeded', type: 'requests', message: 'Rate limit reached for requests. Please try again in 20s.' },
  500: { code: 'server_error', type: 'server_error', message: 'The server had an error while processing your request.' },
};

export function startFixtureServer(port = 0) {
  const requests = [];
  let fault = {};
  let refused = 0;
  const held = new Set();
  const control = (request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.method === 'POST') {
        try { fault = body ? JSON.parse(body) : {}; } catch { response.writeHead(400).end(); return; }
        if (!fault.hang) { for (const drop of held) drop(); held.clear(); }
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ fault, requests: requests.length, refused }));
    });
  };
  // A stand-in for the Shisa.AI platform's device sign-in (JOUZU_SHISA_PLATFORM_URL=<fixture>/shisa):
  // it hands out a device code, approves it on the second poll, and records every call.
  const shisa = { calls: [], issued: 0 };
  const standIn = (request, response) => {
    const path = request.url.slice('/shisa'.length).split('?')[0];
    const own = `http://${request.headers.host}`;
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let input = {}; try { input = body ? JSON.parse(body) : {}; } catch { /* not JSON */ }
      shisa.calls.push({ path, method: request.method, bearer: request.headers.authorization === 'Bearer stand-in-link', clientId: input.client_id ?? null });
      const json = (status, value) => response.writeHead(status, { 'content-type': 'application/json' }).end(value === undefined ? '' : JSON.stringify(value));
      if (path === '/device/code') {
        shisa.issued += 1; shisa.polls = 0;
        return json(201, { device_code: `stand-in-device-${shisa.issued}`, user_code: `QA-${1000 + shisa.issued}`, verification_uri: 'https://platform.shisa.ai/connect', verification_uri_complete: `https://platform.shisa.ai/connect?code=QA-${1000 + shisa.issued}`, authorization_id: `auth-${shisa.issued}`, expires_in: 120, interval: 1 });
      }
      if (path === '/device/token') {
        shisa.polls += 1;
        if (shisa.polls < 2) return json(400, { error: 'authorization_pending' });
        return json(200, {
          api_key: { uuid: 'stand-in-key', secret: 'stand-in-secret', label: 'QA stand-in' },
          org: { id: 'org-qa', name: 'QA organisation', slug: 'qa' }, user: { email: ['qa', 'example.invalid'].join(String.fromCharCode(64)) },
          endpoints: { openai_base_url: `${own}/v1`, model_catalog_url: `${own}/shisa/catalog`, asr_realtime_url: `${own.replace('http', 'ws')}/shisa/asr` },
          link_token: 'stand-in-link', authorization_id: `auth-${shisa.issued}`, urls: {},
        });
      }
      if (path === '/device/link/ack' || path === '/device/link/revoke') { response.writeHead(204).end(); return; }
      json(404, { error: 'not_found' });
    });
  };
  const server = createServer((request, response) => {
    if (request.url === '/__fault') { control(request, response); return; }
    if (request.url === '/__shisa') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(shisa)); return; }
    if (request.url?.startsWith('/shisa/')) { standIn(request, response); return; }
    // The requests answered so far: the last user text of each, in order (release playbook: asked once).
    if (request.url === '/__requests') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(requests.map(item => ({ model: item.model, text: item.text, users: item.users })))); return; }
    if (request.method === 'POST' && request.url?.endsWith('/chat/completions') && Object.keys(fault).length) {
      if (fault.reset) { refused += 1; request.socket.destroy(); return; }
      if (fault.requireKey && request.headers.authorization !== `Bearer ${fault.requireKey}`) {
        refused += 1;
        request.resume();
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: faultBodies[401] }));
        return;
      }
      if (fault.status) {
        refused += 1;
        request.resume();
        response.writeHead(fault.status, { 'content-type': 'application/json', ...(fault.status === 429 ? { 'retry-after': '20' } : {}) });
        response.end(JSON.stringify({ error: { ...faultBodies[fault.status], ...(fault.message ? { message: fault.message } : {}) } }));
        return;
      }
      if (fault.hang) {
        refused += 1;
        request.resume();
        const drop = () => request.socket.destroy();
        held.add(drop);
        response.on('close', () => held.delete(drop));
        return;
      }
      if (fault.firstByteMs) { setTimeout(() => serve(request, response), fault.firstByteMs); return; }
      if (fault.cutAfter) {
        let pieces = 0;
        const write = response.write.bind(response);
        response.write = (data, ...rest) => {
          if (String(data).includes('"content"') && ++pieces > fault.cutAfter) { response.socket?.destroy(); return false; }
          return write(data, ...rest);
        };
        response.end = () => response;
      }
    }
    serve(request, response);
  });
  const serve = (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 2_000_000) request.destroy(); });
    request.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const lastUser = [...messages].reverse().find(message => message.role === 'user');
      const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
      // The system prompt is kept so a check can see what the runtime instructed (e.g. its language section).
      const system = messages.filter(message => message.role === 'system' || message.role === 'developer').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')).join('\n');
      const users = messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''));
      requests.push({ model: data.model, text, system, images: imageSizes(messages), users });
      // A real provider refuses an image with a side of 10 px or less, with this text (#17).
      const tiny = imageSizes(messages).find(([width, height]) => Math.min(width, height) <= 10)
        ?? (fault.refuseImages ? imageSizes(messages)[0] : undefined);
      if (tiny) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'invalid_parameter_error', type: 'invalid_request_error', message: `The image length and width do not meet the model restrictions. [height:${tiny[1]} or width:${tiny[0]} must be larger than 10]` } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deterministic', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: 'assistant' });
      // LONG: a reply that streams for about 12 s, one numbered line every 300 ms.
      if (text.includes('LONG')) {
        let line = 0;
        const timer = setInterval(() => {
          if (response.destroyed || !response.socket) { clearInterval(timer); return; }
          line += 1;
          chunk({ content: `line ${line}\n` });
          if (line === 40) { clearInterval(timer); chunk({}, 'stop'); response.end('data: [DONE]\n\n'); }
        }, 300);
        response.on('close', () => clearInterval(timer));
        return;
      }
      if (text.includes('SLOW')) {
        chunk({ content: 'waiting-for-steer' });
        setTimeout(() => {
          chunk({ content: 'slow finished' });
          chunk({}, 'stop');
          response.end('data: [DONE]\n\n');
        }, 2500);
        return;
      }
      if (text.includes('ABORT')) {
        chunk({ content: 'waiting-for-abort' });
        const timer = setInterval(() => { if (!response.destroyed) response.write(': keep-alive\n\n'); }, 1000);
        request.on('close', () => clearInterval(timer));
        return;
      }
      // TOOLWAIT: one tool call that runs for 30 s (a command that sleeps), to stop it half-way.
      if (text.includes('TOOLWAIT') && !messages.some(message => message.role === 'tool')) {
        chunk({ tool_calls: [{ index: 0, id: 'fixture-wait-1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 30' }) } }] });
        chunk({}, 'tool_calls');
        response.end('data: [DONE]\n\n');
        return;
      }
      // STEPS:n: a reply of n steps, each a short thought and one tool call, then a final answer.
      const steps = /STEPS:(\d+)/u.exec(text);
      if (steps) {
        const done = messages.filter(message => message.role === 'tool').length;
        if (done < Number(steps[1])) {
          chunk({ content: `step ${done + 1} thinking\n` });
          chunk({ tool_calls: [{ index: 0, id: `fixture-step-${done + 1}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) } }] });
          chunk({}, 'tool_calls');
          response.end('data: [DONE]\n\n');
          return;
        }
        chunk({ content: `all ${steps[1]} steps done` });
        chunk({}, 'stop');
        response.end('data: [DONE]\n\n');
        return;
      }
      if (text.includes('TOOL') && !messages.some(message => message.role === 'tool')) {
        chunk({ tool_calls: [{ index: 0, id: 'fixture-call-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: /TOOL:(\S+)/u.exec(text)?.[1] ?? process.env.JOUZU_FIXTURE_FILE ?? 'README.md' }) } }] });
        chunk({}, 'tool_calls');
        response.end('data: [DONE]\n\n');
        return;
      }
      // The user playbook's prompts get the answers a real model gives, so the playbook
      // can run on a throwaway home: a product for "What is A × B?", and a reply in
      // Japanese when the runtime instructs Japanese replies.
      const product = /What is (\d+) × (\d+)\?/.exec(text);
      const japanese = system.includes('Response language: Japanese (ja)');
      // "tool finished" answers the request that carries a tool's result, not every later turn of that session.
      const answer = messages.at(-1)?.role === 'tool' ? 'tool finished'
        : product ? String(Number(product[1]) * Number(product[2]))
        : japanese ? 'あかです。'
        : `fixture reply: ${text}`;
      chunk({ content: answer });
      chunk({}, 'stop');
      response.end('data: [DONE]\n\n');
    });
  };
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, requests, port: server.address().port, setFault: next => { fault = next ?? {}; if (!fault.hang) { for (const drop of held) drop(); held.clear(); } } })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startFixtureServer(Number(process.env.JOUZU_FIXTURE_PORT ?? 43123));
  console.log(port);
}
