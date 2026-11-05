import assert from "node:assert/strict";

Object.assign(process.env, {
  CLOUDFLARE_ACCOUNT_ID: "acc",
  CLOUDFLARE_API_TOKEN: "tok",
  ANTHROPIC_API_KEY: "key",
  SERVICE_KEY: "svc",
});
delete process.env.CLOUDFLARE_NAMESPACE_ID;
delete process.env.WORKER_URL;
delete process.env.WORKER_UPLOAD_KEY;

const kv = new Map();
const workerCalls = [];
const aiCalls = [];
let duplicate = false;
let rejectTopic = false;

kv.set("materias.json", JSON.stringify({ materias: [{ id: "probabilidad", titulo: "Probabilidad", grupo: "Estadística", json: "probabilidad.json", implementada: true }] }));
kv.set("probabilidad.json", JSON.stringify({ temas: [
  { id: "distribucion-normal", titulo: "Distribución normal", dificultad: 4, nivel: 4, requiere: [] },
  { id: "distribucion-exponencial", titulo: "Distribución exponencial", dificultad: 3, nivel: 4, requiere: [] },
] }));

const reply = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t) }], usage: { input_tokens: 1, output_tokens: 1 } });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.anthropic.com")) {
    const body = JSON.parse(opts.body);
    const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    aiCalls.push({ model: body.model, kind: system.slice(0, 30) });
    if (system.includes("Traducís términos cortos")) return reply(text("Distribución de Laplace"));
    if (system.includes("clasificador de temas")) return reply(text({ materia: "probabilidad", esNueva: false, confianza: "alta" }));
    if (system.includes("validador de temas nuevos")) {
      if (rejectTopic) return reply(text({ esValido: false, esDuplicado: false, razon: "no existe" }));
      if (duplicate) return reply(text({ esValido: true, esDuplicado: true, tituloExistenteEquivalente: "Distribución normal" }));
      return reply(text({ esValido: true, esDuplicado: false, tituloNormalizado: "Distribución de Laplace", moldePractica: "modelo2", notas: "n" }));
    }
    if (system.includes("ordena una biblioteca")) {
      return reply(text({ temas: { "distribucion-de-laplace": { puntaje: 60, nivel: 5, requiere: ["distribucion-exponencial"] } } }));
    }
    return reply(text("OK"));
  }
  if (u.includes("/storage/kv/")) {
    const key = decodeURIComponent(u.split("/values/")[1] || "");
    if (opts.method === "PUT") { kv.set(key, typeof opts.body === "string" ? opts.body : String(opts.body)); return reply({ success: true }); }
    if (opts.method === "DELETE") { kv.delete(key); return reply({ success: true }); }
    return kv.has(key) ? reply(kv.get(key)) : reply("", 404);
  }
  if (u.includes("arch-upload-worker")) {
    workerCalls.push({ url: u, auth: opts.headers?.Authorization, body: opts.body ? JSON.parse(opts.body) : null });
    return reply({ ok: true });
  }
  return reply({});
};

const { procesarAvisoTema } = await import("./topics/avisoTema.js");
const { generarFormulaConReintentos, formulaRetry } = await import("./topics/formulaPostAviso.js");
const { reportNoticeResult } = await import("./topics/lib/avisoResultado.js");

assert.equal(process.env.CLOUDFLARE_NAMESPACE_ID, "880a85c0c7604468abd6ef66b4bed2f9");
assert.equal(process.env.WORKER_UPLOAD_KEY, "svc");

const created = await procesarAvisoTema({ termino: "Distribución de Laplace.", idioma: "es" });
assert.equal(created.status, 200);
assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
assert.equal(created.payload.materia, "probabilidad");
assert.equal(created.payload.titulo, "Distribución de Laplace");
const saved = JSON.parse(kv.get("probabilidad.json")).temas.find((t) => t.id === "distribucion-de-laplace");
assert.ok(saved, "the topic is stored in the subject");
assert.equal(saved.nivel, 5);
assert.equal(saved.dificultad >= 1, true);
assert.deepEqual(saved.requiere, ["distribucion-exponencial"]);
assert.ok(aiCalls.length > 0 && aiCalls.every((c) => c.model.startsWith("claude-")), "only Claude models are used");

duplicate = true;
const dup = await procesarAvisoTema({ termino: "Normal", idioma: "es" });
assert.equal(dup.payload.ok, false);
assert.match(dup.payload.motivo, /Ya existe como "Distribución normal"/);

duplicate = false;
rejectTopic = true;
const rejected = await procesarAvisoTema({ termino: "asdf", idioma: "es" });
assert.equal(rejected.payload.ok, false);

const missing = await procesarAvisoTema({ idioma: "es" });
assert.equal(missing.status, 400);

assert.equal(await reportNoticeResult({ userId: "u1", noticeId: "n1", source: "free" }, "Laplace", "es", created.payload), true);
const report = workerCalls.find((c) => c.url.endsWith("/default/aviso-listo"));
assert.ok(report, "the result is reported to the Worker");
assert.equal(report.auth, "Bearer svc");
assert.equal(report.body.userId, "u1");

formulaRetry.delays = [5, 5];
let attempts = 0;
const flaky = async () => { attempts++; if (attempts < 3) throw new Error("boom"); return { ok: true }; };
assert.equal(await generarFormulaConReintentos({ materia: "probabilidad", tema: "Distribución de Laplace" }, flaky), true);
assert.equal(attempts, 3);

workerCalls.length = 0;
const failing = async () => ({ ok: false, errores: ["x"] });
assert.equal(await generarFormulaConReintentos({ materia: "probabilidad", tema: "Distribución de Laplace" }, failing), false);
const note = workerCalls.find((c) => c.url.endsWith("/default/aviso-log"));
assert.ok(note, "a failure is notified through the Worker");
assert.match(note.body.message, /could not be generated/);

console.log("probar_aviso_tema: ok");
