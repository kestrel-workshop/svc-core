import { fetchConTimeout } from "../lib/fetchTimeout.js";

export async function markGraphDirty() {
  if (!process.env.WORKER_URL || !process.env.WORKER_UPLOAD_KEY) return false;
  try {
    const resp = await fetchConTimeout(
      `${process.env.WORKER_URL}/default/graph-dirty`,
      { method: "POST", headers: { Authorization: `Bearer ${process.env.WORKER_UPLOAD_KEY}`, "Content-Type": "application/json" }, body: "{}" },
      15000
    );
    return resp.ok;
  } catch (err) {
    console.warn(`[graph] dirty mark failed: ${err.message}`);
    return false;
  }
}
