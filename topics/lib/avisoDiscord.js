import { fetchConTimeout } from "./fetchTimeout.js";

export async function notifyDiscord(message) {
  const workerUrl = process.env.WORKER_URL;
  const key = process.env.WORKER_UPLOAD_KEY;
  if (!workerUrl || !key) return false;
  try {
    const resp = await fetchConTimeout(
      `${workerUrl}/default/aviso-log`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ message: String(message).slice(0, 1900) }),
      },
      15000
    );
    return resp.ok;
  } catch (err) {
    console.warn(`[discord] notification failed: ${err.message}`);
    return false;
  }
}
