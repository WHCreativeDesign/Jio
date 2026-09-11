/* Model list. Requests go through the Supabase edge function, which holds the key pool. */
(function (global) {
  'use strict';
  global.Groq = {
    MODELS: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', note: 'balanced' },
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', note: 'reasoning' },
      { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2', note: 'creative' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', note: 'fast' },
    ],
  };
})(window);
