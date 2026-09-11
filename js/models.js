/* Provider + model catalogue for the client.

   The live list comes from the edge function, which asks each provider what it
   actually serves — nothing here is the source of truth, because every one of
   these vendors retires model names on their own schedule. This file is the seed
   shown before the real list lands, the fallback if it can't be reached, and the
   bits the browser needs that the server doesn't: display names and the key
   format for each provider's donate box. */
(function (global) {
  'use strict';

  const PROVIDERS = {
    groq: {
      name: 'Groq', hint: 'gsk_…', test: /^gsk_[A-Za-z0-9]{20,}$/,
      keys: 'https://console.groq.com/keys',
    },
    nvidia: {
      name: 'NVIDIA', hint: 'nvapi-…', test: /^nvapi-[A-Za-z0-9_-]{20,}$/,
      keys: 'https://build.nvidia.com/',
    },
    gemini: {
      name: 'Gemini', hint: 'AIza…', test: /^AIza[A-Za-z0-9_-]{30,}$/,
      keys: 'https://aistudio.google.com/app/apikey',
    },
    cohere: {
      name: 'Cohere', hint: '40 characters', test: /^[A-Za-z0-9]{32,}$/,
      keys: 'https://dashboard.cohere.com/api-keys',
    },
  };
  const ORDER = ['groq', 'nvidia', 'gemini', 'cohere'];

  // qwen3.8-27b is the one jio aims at everywhere; auto falls to each provider's
  // closest equivalent when groq is out of headroom.
  const SEED = ['auto', 'groq:qwen/qwen3.8-27b', 'groq:openai/gpt-oss-120b'];

  const PRETTY = {
    'qwen/qwen3.8-27b': 'Qwen3.8 27B',
    'qwen/qwen3.6-27b': 'Qwen3.6 27B',
    'openai/gpt-oss-20b': 'GPT-OSS 20B',
    'openai/gpt-oss-120b': 'GPT-OSS 120B',
  };

  const providerOf = (id) => {
    const i = id.indexOf(':');
    return i === -1 ? 'groq' : id.slice(0, i);
  };
  const modelOf = (id) => {
    const i = id.indexOf(':');
    return i === -1 ? id : id.slice(i + 1);
  };

  /* "meta-llama/llama-4-maverick-17b" -> "Llama 4 Maverick 17B" */
  function label(id) {
    if (id === 'auto') return 'Auto';
    const m = modelOf(id);
    if (PRETTY[m]) return PRETTY[m];
    return m.replace(/^models\//, '').split('/').pop()
      .replace(/[-_]/g, ' ')
      .replace(/\b(\d+)b\b/gi, (_, n) => n + 'B')
      .replace(/\b[a-z]/g, c => c.toUpperCase())
      .replace(/\bGpt\b/g, 'GPT')
      .replace(/\bOss\b/g, 'OSS')
      .replace(/\bAi\b/g, 'AI')
      .replace(/\bIt\b/g, 'IT');
  }

  /* Group ids into [provider, ids[]] pairs for the dropdown's optgroups. The
     server already returns each provider's list best-first, so order is kept. */
  function group(ids) {
    const by = new Map();
    ids.filter(id => id !== 'auto').forEach(id => {
      const p = providerOf(id);
      if (!by.has(p)) by.set(p, []);
      by.get(p).push(id);
    });
    return ORDER.filter(p => by.has(p)).map(p => [p, by.get(p)]);
  }

  global.Models = { PROVIDERS, ORDER, SEED, label, group, providerOf, modelOf };
})(window);
