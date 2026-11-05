import { fetchConTimeout } from "./fetchTimeout.js";

export async function reportNoticeResult(aviso, termino, idioma, result) {
  const workerUrl = process.env.WORKER_URL;
  const key = process.env.WORKER_UPLOAD_KEY;
  if (!aviso || !aviso.userId || !workerUrl || !key) return false;
  const body = JSON.stringify({
    userId: aviso.userId,
    noticeId: aviso.noticeId || null,
    source: aviso.source || "free",
    termino,
    idioma,
    result,
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetchConTimeout(
        `${workerUrl}/default/aviso-listo`,
        { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body },
        20000
      );
      if (resp.ok) return true;
      console.warn(`[aviso-listo] the Worker answered ${resp.status} (attempt ${attempt})`);
    } catch (err) {
      console.warn(`[aviso-listo] attempt ${attempt} failed: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
  return false;
}
