#!/usr/bin/env node
/**
 * Flash-MoE Bridge for Paperclip
 * Translates Paperclip HTTP adapter → Flash-MoE OpenAI API
 * Port 3199 → Flash-MoE port 8090
 */
import http from 'node:http';
import fs from 'node:fs';

const FLASH_MOE_URL = 'http://127.0.0.1:8090/v1/chat/completions';
const PORT = 3199;
const MAX_TOKENS = 200;

/**
 * Extract a clean human-readable prompt from Paperclip's context object.
 * Logs the raw context for debugging.
 */
function extractPrompt(context) {
  // Log raw context for debugging
  const logLine = `[${new Date().toISOString()}] ${JSON.stringify(context).slice(0, 2000)}\n`;
  fs.appendFileSync('/tmp/bridge-context.log', logLine);

  if (typeof context === 'string') return context;
  if (!context || typeof context !== 'object') return 'Hello';

  // Deep search for issue title/body in any nested structure
  const findField = (obj, ...keys) => {
    for (const key of keys) {
      if (obj[key] && typeof obj[key] === 'string') return obj[key];
    }
    // Search one level deeper
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        for (const key of keys) {
          if (val[key] && typeof val[key] === 'string') return val[key];
        }
      }
    }
    return null;
  };

  const title = findField(context, 'issueTitle', 'title', 'taskTitle', 'name');
  const body = findField(context, 'issueBody', 'body', 'description', 'taskBody', 'taskDescription');
  
  if (title || body) {
    const prompt = [title, body].filter(Boolean).join('\n\n');
    if (prompt.length > 10) return prompt;
  }

  // Check for open issues list
  if (Array.isArray(context.openIssues) && context.openIssues.length > 0) {
    const tasks = context.openIssues.map(i => {
      const t = i.title || i.issueTitle || '';
      const b = i.body || i.issueBody || i.description || '';
      return b ? `${t}: ${b}` : t;
    }).filter(Boolean);
    if (tasks.length > 0) return `Complete these tasks:\n${tasks.map(t => `- ${t}`).join('\n')}`;
  }

  // Heartbeat with no issues
  if (context.wakeSource === 'heartbeat' || context.wakeSource === 'on_demand') {
    return 'Provide a brief status update. Say you are ready for tasks.';
  }

  // Direct fields
  if (context.task) return context.task;
  if (context.prompt) return context.prompt;
  if (context.message) return context.message;

  return 'Provide a brief status update on your readiness.';
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model: 'qwen3.5-397b-a17b' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const payload = JSON.parse(body);
    const { context, runId } = payload;

    const prompt = extractPrompt(context);
    console.log(`[bridge] Run ${(runId || '?').slice(0, 8)}: "${prompt.slice(0, 100)}"`);
    const startMs = Date.now();

    const chatReq = {
      model: 'qwen3.5-397b-a17b',
      messages: [
        { role: 'system', content: 'You are a sports betting research assistant. Be concise and direct. Answer the question factually.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: MAX_TOKENS,
      stream: false
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);

    const moeRes = await fetch(FLASH_MOE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatReq),
      signal: controller.signal
    });

    clearTimeout(timeout);
    const moeText = await moeRes.text();
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

    let fullContent = '';
    for (const line of moeText.split('\n')) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const chunk = JSON.parse(line.slice(6));
          const delta = chunk.choices?.[0]?.delta?.content || '';
          fullContent += delta;
        } catch {}
      }
    }

    fullContent = fullContent
      .replace(/Ġ/g, ' ')
      .replace(/Ċ/g, '\n')
      .replace(/<unk>/g, '')
      .replace(/<\|im_start\|>/g, '')
      .replace(/<\|im_end\|>/g, '')
      .trim();

    const thinkEnd = fullContent.indexOf('</think>');
    if (thinkEnd !== -1) {
      fullContent = fullContent.slice(thinkEnd + 8).trim();
    }

    console.log(`[bridge] ✅ ${elapsed}s: "${fullContent.slice(0, 120)}"`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      summary: fullContent || 'Model generated empty response',
      result: fullContent,
      model: 'qwen3.5-397b-a17b',
      generationTime: `${elapsed}s`
    }));

  } catch (err) {
    console.error(`[bridge] ❌ Error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] Flash-MoE bridge on http://127.0.0.1:${PORT}`);
  console.log(`[bridge] → Flash-MoE at ${FLASH_MOE_URL} (max ${MAX_TOKENS} tokens)`);
  console.log(`[bridge] Context log: /tmp/bridge-context.log`);
});
