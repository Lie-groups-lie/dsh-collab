import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import contract from '../runtime-contract.json' with { type: 'json' };
import { deadlineFor } from '../core/deadline.mjs';

export function readPricing(filename) {
  if (!filename) return {};
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (value.schema !== 1 || !/^[A-Z]{3}$/.test(value.currency || '') || !value.routes || typeof value.routes !== 'object') throw new Error('Invalid pricing registry; schema, ISO currency and routes are required');
  for (const rates of Object.values(value.routes)) for (const key of ['input', 'output']) {
    if (!Number.isSafeInteger(rates[key]) || rates[key] < 0 || rates[key] > 1000000000) throw new Error('Pricing rates must be micro-currency units per million tokens');
  }
  return Object.fromEntries(Object.entries(value.routes).map(([route, rates]) => [route, { ...rates, currency: value.currency }]));
}

// The LLM stream boundary also sees compaction, title requests and loop retries.
// Requests are immutable in DSH: reject inadmissible envelopes, never rewrite them.
export async function* budgetedStream({ store, ctx, pricing }, options, next) {
  const task = options.sessionId && store.get(options.sessionId);
  if (!task?.policy) { yield* next(); return; }
  const policy = task.policy;
  if (options.provider !== policy.provider || options.model !== policy.model) throw new Error('Managed model route differs from enforced policy');
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > policy.maxOutputTokens) throw new Error('Managed auxiliary request exceeds output policy');
  const root = store.root(task.id);
  const key = `stream-${randomUUID()}`;
  // Provider context capacity is a conservative input reservation, not a cheap
  // tokenizer estimate. Unused capacity is released only after reported usage.
  store.reserve(task.id, key, options.maxTokens, { requireFull: true, inputTokens: contract.contextWindow,
    rates: pricing[`${options.provider}/${options.model}`], purpose: options.purpose });
  const deadline = deadlineFor(store, task.id);
  const remaining = deadline.at === null ? null : deadline.at - Date.now();
  const timer = remaining == null ? null : setTimeout(() => ctx.agents.get(task.id)?.cancel({ kind: 'hook', reason: 'DSH collaboration deadline exceeded' }), Math.max(1, Math.min(remaining, 2147483647)));
  timer?.unref?.();
  let usage;
  try {
    for await (const chunk of next()) {
      if (chunk.type === 'usage') usage = chunk.usage;
      yield chunk;
    }
  } finally { clearTimeout(timer); store.settle(task.id, key, usage); }
}
