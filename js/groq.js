/* Model catalogue. The live list comes from Groq via the edge function; this is the
   seed shown before it answers, and the fallback if it can't be reached.
   Groq retires models regularly — llama-3.1-8b-instant, llama-3.3-70b-versatile,
   qwen/qwen3-32b and the kimi-k2 snapshots were all decommissioned — so nothing
   here is hardcoded as the only source of truth. */
(function (global) {
  'use strict';

  const SEED = [
    'openai/gpt-oss-20b',
    'openai/gpt-oss-120b',
  ];

  // preferred order; anything else lands after these, alphabetically
  const RANK = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];

  const PRETTY = {
    'openai/gpt-oss-20b': 'GPT-OSS 20B',
    'openai/gpt-oss-120b': 'GPT-OSS 120B',
  };

  /* "meta-llama/llama-4-maverick-17b" -> "Llama 4 Maverick 17B" */
  function label(id) {
    if (PRETTY[id]) return PRETTY[id];
    return id.split('/').pop()
      .replace(/[-_]/g, ' ')
      .replace(/\b(\d+)b\b/gi, (_, n) => n + 'B')
      .replace(/\b[a-z]/g, c => c.toUpperCase())
      .replace(/\bGpt\b/g, 'GPT')
      .replace(/\bOss\b/g, 'OSS')
      .replace(/\bAi\b/g, 'AI');
  }

  function sort(ids) {
    return ids.slice().sort((a, b) => {
      const ra = RANK.indexOf(a), rb = RANK.indexOf(b);
      if (ra !== -1 || rb !== -1) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
      return a.localeCompare(b);
    });
  }

  global.Groq = {
    SEED,
    label,
    sort,
    MODELS: SEED.map(id => ({ id, name: label(id) })),
  };
})(window);
