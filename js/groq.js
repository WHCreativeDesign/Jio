/* Groq chat completions (OpenAI-compatible) with SSE streaming. */
(function (global) {
  'use strict';
  const URL = 'https://api.groq.com/openai/v1/chat/completions';

  const MODELS = [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', note: 'balanced' },
    { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', note: 'reasoning' },
    { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2', note: 'creative' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', note: 'fast' },
  ];

  async function stream({ key, model, messages, signal, onToken }) {
    const res = await fetch(URL, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, stream: true, temperature: 0.7, max_tokens: 4096 }),
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = (await res.json()).error?.message || msg; } catch (e) {}
      const err = new Error(msg); err.status = res.status; throw err;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return text;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) { text += delta; onToken(delta, text); }
        } catch (e) {}
      }
    }
    return text;
  }

  global.Groq = { MODELS, stream };
})(window);
