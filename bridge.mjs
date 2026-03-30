#!/usr/bin/env node
/**
 * Flash-MoE Bridge for Paperclip
 * 
 * Translates Paperclip HTTP adapter calls → OpenAI chat completion API
 * Runs on port 3199, forwards to Flash-MoE on port 8090
 */

import http from 'node:http';

const FLASH_MOE_URL = 'http://127.0.0.1:8090/v1/chat/completions';
const PORT = 3199;

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

    // Extract the task/prompt from Paperclip context
    const prompt = context?.task || context?.prompt || context?.message || 
                   (typeof context === 'string' ? context : JSON.stringify(context));

    console.log(`[bridge] Run ${runId}: "${prompt.slice(0, 100)}..."`);

    // Build chat completion request
    const chatReq = {
      model: 'qwen3.5-397b-a17b',
      messages: [
        { role: 'system', content: 'You are a helpful research assistant. Be concise and direct.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 512,
      stream: false
    };

    // Call Flash-MoE
    const moeRes = await fetch(FLASH_MOE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatReq)
    });

    const moeText = await moeRes.text();
    
    // Parse SSE stream response
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

    // Clean up GPT-2 encoding artifacts
    fullContent = fullContent
      .replace(/Ġ/g, ' ')
      .replace(/Ċ/g, '\n')
      .replace(/<unk>/g, '')
      .trim();

    console.log(`[bridge] Response: "${fullContent.slice(0, 100)}..."`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      summary: fullContent || 'No response from model',
      result: fullContent,
      model: 'qwen3.5-397b-a17b',
      tokens: fullContent.split(/\s+/).length
    }));

  } catch (err) {
    console.error(`[bridge] Error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] Flash-MoE bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`[bridge] Forwarding to Flash-MoE at ${FLASH_MOE_URL}`);
});
