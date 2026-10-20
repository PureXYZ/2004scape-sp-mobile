#!/usr/bin/env node
// A local stand-in for the Claude Messages API (POST /v1/messages), for testing the app's online chat model
// (ios/LostCity/OnlineModel.swift, BotChatModel.swift) without a real key or a real call. It checks every request the way
// docs/ARCHITECTURE.md §7.1 says the app sends it (the fields checked against the official API documentation: see the
// header of OnlineModel.swift) and answers by the key the request carries:
//
//   key contains   answer
//   "bad"          401 authentication_error
//   "rate"         429 rate_limit_error            "busy"     529 overloaded_error
//   "broke"        500 api_error                   "nomodel"  403 permission_error
//   "refuse"       200, stop_reason "refusal", empty content, stop_details {type, category, explanation}
//   "empty"        200, no text block              "slow"     the answer after 10 s (the app gives up after 8)
//   anything else  200 with one text block: a 2004 chat line (the cache written on the first request, read after)
//
// A request that does not look like the app's gets a 400 invalid_request_error naming what is wrong (and counts as a
// failure in GET /requests). GET /requests: every request so far ({key: only its last 4 characters, headers, body,
// problems, status}); POST /reset clears them.
//
//   node web/test/lm/mock-claude.mjs [--port 47590]       (or import { startMockClaude } from this file)
import http from 'node:http';

export const EXPECTED = Object.freeze({
    path: '/v1/messages',
    version: '2023-06-01',
    model: 'claude-haiku-5-5',
    maxTokens: 60
});

/** What is wrong with a request, as a list (empty: it is what the app should send). */
export function problemsOf(req, body) {
    const problems = [];
    if (req.method !== 'POST') problems.push(`method ${req.method}`);
    if (req.url !== EXPECTED.path) problems.push(`path ${req.url}`);
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || !key) problems.push('no x-api-key');
    if (req.headers['anthropic-version'] !== EXPECTED.version) problems.push(`anthropic-version ${req.headers['anthropic-version']}`);
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) problems.push(`content-type ${req.headers['content-type']}`);
    if (!body || typeof body !== 'object') {
        problems.push('the body is not JSON');
        return problems;
    }
    const known = new Set(['model', 'max_tokens', 'thinking', 'output_config', 'system', 'messages']);
    for (const field of Object.keys(body)) {
        if (!known.has(field)) problems.push(`unexpected field ${field}`);
    }
    if (body.model !== EXPECTED.model) problems.push(`model ${body.model}`);
    if (body.max_tokens !== EXPECTED.maxTokens) problems.push(`max_tokens ${body.max_tokens}`);
    if (body.thinking?.type !== 'disabled' || Object.keys(body.thinking).length !== 1) problems.push(`thinking ${JSON.stringify(body.thinking)}`);
    if (body.output_config?.effort !== 'low') problems.push(`output_config ${JSON.stringify(body.output_config)}`);
    const system = body.system;
    if (!Array.isArray(system) || system.length < 1 || system.length > 2) {
        problems.push('system is not 1-2 text blocks');
    } else {
        system.forEach((block, i) => {
            if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text) problems.push(`system[${i}] is not a non-empty text block`);
        });
        if (system[0]?.cache_control?.type !== 'ephemeral') problems.push('system[0] has no cache_control ephemeral');
        if (system[1]?.cache_control) problems.push('system[1] has cache_control');
    }
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length !== 1 || messages[0]?.role !== 'user' || typeof messages[0]?.content !== 'string' || !messages[0].content) {
        problems.push('messages is not one user turn with text');
    }
    return problems;
}

const LINES = ['hey whats up', 'lol nm u', 'just chillin at the bank', 'sup m8', 'not much, u?'];

export async function startMockClaude({ port = 47590, slowMs = 10000 } = {}) {
    const requests = [];
    let replies = 0;
    let cached = false;
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => (raw += chunk));
        req.on('end', () => {
            if (req.method === 'GET' && req.url === '/requests') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(requests));
                return;
            }
            if (req.method === 'POST' && req.url === '/reset') {
                requests.length = 0;
                cached = false;
                res.writeHead(204);
                res.end();
                return;
            }
            let body = null;
            try {
                body = JSON.parse(raw);
            } catch {
                body = null;
            }
            const problems = problemsOf(req, body);
            const key = String(req.headers['x-api-key'] ?? '');
            const record = { key: key.slice(-4), headers: { 'anthropic-version': req.headers['anthropic-version'], 'content-type': req.headers['content-type'] }, body, problems, status: 0 };
            requests.push(record);
            const send = (status, json, delay = 0) => {
                record.status = status;
                setTimeout(() => {
                    if (res.destroyed) return;
                    res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_mock${requests.length}` });
                    res.end(JSON.stringify(json));
                }, delay);
            };
            const error = (status, type, message) => send(status, { type: 'error', error: { type, message }, request_id: `req_mock${requests.length}` });
            if (problems.length) {
                error(400, 'invalid_request_error', problems.join('; '));
            } else if (key.includes('bad')) {
                error(401, 'authentication_error', 'invalid x-api-key');
            } else if (key.includes('rate')) {
                error(429, 'rate_limit_error', 'rate limited');
            } else if (key.includes('busy')) {
                error(529, 'overloaded_error', 'Overloaded');
            } else if (key.includes('broke')) {
                error(500, 'api_error', 'internal error');
            } else if (key.includes('nomodel')) {
                error(403, 'permission_error', 'not allowed');
            } else {
                const usage = { input_tokens: 180, output_tokens: key.includes('refuse') || key.includes('empty') ? 0 : 6, cache_creation_input_tokens: cached ? 0 : 700, cache_read_input_tokens: cached ? 700 : 0 };
                cached = true;
                const message = { id: `msg_mock${requests.length}`, type: 'message', role: 'assistant', model: EXPECTED.model, content: [], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage };
                if (key.includes('refuse')) {
                    send(200, { ...message, stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: 'This request was declined.' } });
                } else if (key.includes('empty')) {
                    send(200, message);
                } else {
                    send(200, { ...message, content: [{ type: 'text', text: LINES[replies++ % LINES.length] }] }, key.includes('slow') ? slowMs : 0);
                }
            }
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    return {
        url: `http://127.0.0.1:${port}${EXPECTED.path}`,
        requests,
        close: () => new Promise(resolve => server.close(() => resolve()))
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const portIndex = process.argv.indexOf('--port');
    const mock = await startMockClaude({ port: portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 47590 });
    console.log(`mock Claude API at ${mock.url} (GET /requests, POST /reset)`);
}
