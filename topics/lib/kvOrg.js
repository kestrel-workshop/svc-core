// Cliente del KV de organización (namespace "organization_JSON"): guarda, una sola vez y sin depender del idioma,
// la dificultad, los temas previos, la materia y el área de cada tema, y en qué idiomas se generó.
// Usa la misma cuenta y token que kv.js; solo cambia el namespace:
//   CLOUDFLARE_ORG_NAMESPACE_ID  (opcional: si falta, la organización queda desactivada y el servicio sigue como antes)
import { fetchConTimeout } from "./fetchTimeout.js";

const TIMEOUT_MS = 15_000;

export function orgHabilitada() {
  return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ORG_NAMESPACE_ID);
}

function baseUrl(key) {
  return `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_ORG_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
}

export async function leerOrgJSON(key) {
  if (!orgHabilitada()) throw new Error("Falta CLOUDFLARE_ORG_NAMESPACE_ID (KV de organización)");
  const resp = await fetchConTimeout(baseUrl(key), { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } }, TIMEOUT_MS);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Fallo al leer KV de organización (${key}): ${resp.status} ${await resp.text()}`);
  return JSON.parse(await resp.text());
}

export async function escribirOrgJSON(key, valor) {
  if (!orgHabilitada()) throw new Error("Falta CLOUDFLARE_ORG_NAMESPACE_ID (KV de organización)");
  const resp = await fetchConTimeout(
    baseUrl(key),
    { method: "PUT", headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(valor) },
    TIMEOUT_MS
  );
  if (!resp.ok) throw new Error(`Fallo al escribir KV de organización (${key}): ${resp.status} ${await resp.text()}`);
}
