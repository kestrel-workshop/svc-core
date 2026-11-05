import { leerJSON, escribirJSON, keyMateria } from "./kv.js";

export const PAGE_SIZE = 500;
export const PAGING_THRESHOLD = 1000;
const MAX_KEY_BYTES = 480;

export function pageKey(key, n) {
  return key.replace(/\.json$/, `.p${n}.json`);
}

export function pageCount(body) {
  return body && Number.isInteger(body.paginas) && body.paginas > 0 ? body.paginas : 0;
}

export function slugKey(language, slug) {
  return `slug:${language}:${slug}`;
}

function joinTopics(main, pages) {
  const topics = Array.isArray(main.temas) ? main.temas.slice() : [];
  for (const page of pages) if (Array.isArray(page?.temas)) for (const t of page.temas) topics.push(t);
  const joined = { ...main, temas: topics };
  delete joined.paginas;
  return joined;
}

export async function readSubject(subjectId, language) {
  const key = keyMateria(subjectId, language);
  const main = await leerJSON(key);
  const count = pageCount(main);
  if (!count) return main;
  const pages = [];
  for (let from = 1; from <= count; from += 8) {
    const batch = [];
    for (let i = from; i < from + 8 && i <= count; i++) batch.push(leerJSON(pageKey(key, i)));
    pages.push(...(await Promise.all(batch)));
  }
  return joinTopics(main, pages);
}

export async function saveSubject(subjectId, language, data) {
  const key = keyMateria(subjectId, language);
  const topics = Array.isArray(data.temas) ? data.temas : [];
  const previous = await leerJSON(key);
  if (!pageCount(previous) && topics.length < PAGING_THRESHOLD) {
    await escribirJSON(key, data);
    return { paged: false, pages: 0 };
  }
  const chunks = [];
  for (let i = 0; i < topics.length; i += PAGE_SIZE) chunks.push(topics.slice(i, i + PAGE_SIZE));
  if (!chunks.length) chunks.push([]);
  for (let i = 0; i < chunks.length; i++) await escribirJSON(pageKey(key, i + 1), { temas: chunks[i] });
  const main = { ...data, paginas: chunks.length };
  delete main.temas;
  await escribirJSON(key, main);
  return { paged: true, pages: chunks.length };
}

export async function appendToPagedSubject(subjectId, language, main, topic) {
  const key = keyMateria(subjectId, language);
  let count = pageCount(main);
  const last = await leerJSON(pageKey(key, count));
  let topics = Array.isArray(last?.temas) ? last.temas : [];
  if (topics.length >= PAGE_SIZE) {
    count += 1;
    topics = [];
  }
  topics.push(topic);
  await escribirJSON(pageKey(key, count), { temas: topics });
  if (count !== pageCount(main)) await escribirJSON(key, { ...main, paginas: count });
}

export async function findSlug(language, slug) {
  const key = slugKey(language, slug);
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) return null;
  const value = await leerJSON(key);
  return value && typeof value.materia === "string" ? value.materia : null;
}

export async function recordSlug(language, slug, subjectId) {
  const key = slugKey(language, slug);
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) return false;
  if (await leerJSON(key)) return false;
  await escribirJSON(key, { materia: subjectId });
  return true;
}
