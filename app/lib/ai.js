// The AI brain. Two routes, both chosen by the person in Settings:
//   - local: Ollama running on this computer (free, nothing leaves the machine)
//   - key:   any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, etc.)
//            or Anthropic, using the person's own API key.
// Only the emails needed to answer a question are ever sent to the chosen AI.

const http = require('node:http');

async function ollamaModels() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags');
    if (!res.ok) return [];
    const j = await res.json();
    return (j.models || []).map((m) => m.name);
  } catch (e) {
    return [];
  }
}

async function ollamaChat({ model, messages, onToken }) {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let full = '';
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const t = j.message?.content || '';
        if (t) { full += t; onToken && onToken(t); }
      } catch (e) {}
    }
  }
  return full;
}

async function openaiChat({ baseUrl, apiKey, model, messages, onToken }) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok) throw new Error(`AI error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let full = '';
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const t = j.choices?.[0]?.delta?.content || '';
        if (t) { full += t; onToken && onToken(t); }
      } catch (e) {}
    }
  }
  return full;
}

async function anthropicChat({ apiKey, model, messages, onToken }) {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const msgs = messages.filter((m) => m.role !== 'system');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, system, messages: msgs, max_tokens: 1500, stream: true }),
  });
  if (!res.ok) throw new Error(`Claude error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let full = '';
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      try {
        const j = JSON.parse(s.slice(5).trim());
        const t = j.delta?.text || '';
        if (t) { full += t; onToken && onToken(t); }
      } catch (e) {}
    }
  }
  return full;
}

// Unified entry. cfg = {provider, model, apiKey, baseUrl}
async function chat(cfg, messages, onToken) {
  if (cfg.provider === 'ollama') return ollamaChat({ ...cfg, messages, onToken });
  if (cfg.provider === 'anthropic') return anthropicChat({ ...cfg, messages, onToken });
  // openai + any compatible endpoint
  return openaiChat({ ...cfg, messages, onToken });
}

module.exports = { chat, ollamaModels };
