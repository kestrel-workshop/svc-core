import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function addCost({ costUsd, tokensIn, tokensOut, model }) {
  const job = storage.getStore();
  if (!job) return;
  job.costUsd += costUsd;
  job.tokensIn += tokensIn;
  job.tokensOut += tokensOut;
  job.calls += 1;
  job.models[model] = (job.models[model] || 0) + costUsd;
}

function reportJob(job) {
  try {
    const { COUNT_URL, COUNT_SECRET } = process.env;
    if (!COUNT_URL || !COUNT_SECRET) return;
    fetch(`${COUNT_URL.replace(/\/+$/, "")}/costo-trabajo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${COUNT_SECRET}` },
      body: JSON.stringify({
        action: job.action,
        topic: job.topic,
        ok: job.ok,
        cost_usd: Math.round(job.costUsd * 1e6) / 1e6,
        tokens_in: Math.round(job.tokensIn),
        tokens_out: Math.round(job.tokensOut),
        calls: job.calls,
        seconds: Math.round((Date.now() - job.startedAt) / 1000),
        models: job.models,
      }),
      signal: AbortSignal.timeout(5000),
    }).catch((e) => console.warn(`[trabajo] could not report job cost: ${e.message}`));
  } catch (e) {
    console.warn(`[trabajo] unexpected error: ${e.message}`);
  }
}

function jobUsage(job) {
  return {
    cost_usd: Math.round(job.costUsd * 1e6) / 1e6,
    tokens_in: Math.round(job.tokensIn),
    tokens_out: Math.round(job.tokensOut),
    calls: job.calls,
  };
}

export async function trackJob(action, topic, fn) {
  const job = {
    action,
    topic,
    ok: true,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    calls: 0,
    models: {},
    startedAt: Date.now(),
  };
  try {
    const result = await storage.run(job, fn);
    job.ok = result?.ok !== false;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return { ...result, usage: jobUsage(job) };
    }
    return result;
  } catch (err) {
    job.ok = false;
    throw err;
  } finally {
    reportJob(job);
  }
}
