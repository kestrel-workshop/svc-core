import { leerJSON, escribirJSON, keyMaterias } from "./kv.js";
import { readSubject } from "./pages.js";
import { tokenize } from "./tokens.js";

export const SHARDS = 256;
export const TOKEN_CAP = 200;
const TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export function shardOf(token) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % SHARDS;
}

export function shardKey(language, n) {
  return `tokidx:${language}:${n}`;
}

async function readShard(language, n) {
  const key = shardKey(language, n);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.data;
  const data = (await leerJSON(key)) || {};
  cache.set(key, { t: Date.now(), data });
  return data;
}

function groupByShard(tokens) {
  const byShard = new Map();
  for (const token of tokens) {
    const n = shardOf(token);
    const list = byShard.get(n) || [];
    list.push(token);
    byShard.set(n, list);
  }
  return byShard;
}

function addToEntry(data, token, subjectId) {
  const current = data[token];
  if (current === "*") return false;
  const list = Array.isArray(current) ? current : [];
  if (list.includes(subjectId)) return false;
  if (list.length >= TOKEN_CAP) {
    data[token] = "*";
    return true;
  }
  list.push(subjectId);
  data[token] = list;
  return true;
}

export async function lookupSubjects(language, termTokens) {
  const scores = new Map();
  const byShard = groupByShard(termTokens);
  const shards = await Promise.all([...byShard.keys()].map((n) => readShard(language, n)));
  [...byShard.values()].forEach((tokens, i) => {
    for (const token of tokens) {
      const entry = shards[i][token];
      if (!Array.isArray(entry)) continue;
      for (const subjectId of entry) scores.set(subjectId, (scores.get(subjectId) || 0) + 1);
    }
  });
  return scores;
}

export async function indexTopic(language, subjectId, title) {
  const byShard = groupByShard(tokenize(title));
  for (const [n, tokens] of byShard) {
    const key = shardKey(language, n);
    const data = (await leerJSON(key)) || {};
    let changed = false;
    for (const token of tokens) if (addToEntry(data, token, subjectId)) changed = true;
    if (changed) {
      await escribirJSON(key, data);
      cache.delete(key);
    }
  }
}

export async function buildWordIndex(language, { apply = false, log = () => {} } = {}) {
  const index = await leerJSON(keyMaterias(language));
  const subjects = (index?.materias || []).filter((m) => m?.id);
  const shards = new Map();
  let topics = 0;
  for (let i = 0; i < subjects.length; i += 8) {
    await Promise.all(subjects.slice(i, i + 8).map(async (subject) => {
      const data = await readSubject(subject.id, language);
      for (const topic of Array.isArray(data?.temas) ? data.temas : []) {
        if (!topic?.titulo) continue;
        topics += 1;
        for (const token of tokenize(topic.titulo)) {
          const n = shardOf(token);
          const shard = shards.get(n) || {};
          addToEntry(shard, token, subject.id);
          shards.set(n, shard);
        }
      }
    }));
    log(`[${language}] ${Math.min(i + 8, subjects.length)}/${subjects.length} subjects read`);
  }
  let written = 0;
  if (apply) {
    for (const [n, data] of shards) {
      await escribirJSON(shardKey(language, n), data);
      cache.delete(shardKey(language, n));
      written += 1;
    }
  }
  return { subjects: subjects.length, topics, shards: shards.size, written };
}
