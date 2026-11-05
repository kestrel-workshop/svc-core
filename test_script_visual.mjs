import { validarScript, generarScriptVisual, MAX_SCRIPT_CHARS } from "./lib/scriptVisual.js";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`ok   ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`); }
}

const good = `var DURATION = 10000;
function animateScene(scene, t) {
  var w = scene.width, h = scene.height, u = t / DURATION;
  scene.clear();
  scene.drawRectangle(0, 0, w, h, "#0b0e14");
  var pts = [];
  for (var i = 0; i <= 120; i++) { var x = i / 120; pts.push([w * 0.1 + w * 0.8 * x, h * 0.5 - h * 0.3 * Math.sin(2 * Math.PI * (x * 2 - u))]); }
  scene.drawPolyline(pts, "#7fd0e8", 2.5);
  scene.drawLine(w * 0.1, h * 0.5, w * 0.9, h * 0.5, "#555", 1);
  scene.drawCircle(w * 0.1 + w * 0.8 * u, h * 0.5, 5, "#fff");
  scene.drawText("y = sin(2π(2x − t))", w * 0.1, h * 0.12, Math.max(12, Math.min(w, h) * 0.04), "#e8eefc", "left", "middle");
  scene.drawText("t = " + (t / 1000).toFixed(1), w * 0.1, h * 0.9, 12, "#aaa", "left", "middle");
}`;

check("valid script passes", validarScript(good).ok, JSON.stringify(validarScript(good)));
check("too short fails", !validarScript("function animateScene(){}").ok);
check("too long fails", !validarScript(good + "\n//" + "x".repeat(MAX_SCRIPT_CHARS)).ok);
check("document access fails", !validarScript(good + "\nvar a = document.body;").ok);
check("fetch fails", !validarScript(good + "\nfetch('x');").ok);
check("syntax error fails", !validarScript(good + "\nfunction (").ok);
check("missing animateScene fails", !validarScript(good.replace("animateScene", "other")).ok);
check("throwing frame fails", !validarScript(good.replace("scene.clear();", "scene.clear(); undefinedFunction();")).ok);
check("infinite loop fails", !validarScript(good.replace("scene.clear();", "scene.clear(); while (true) {}")).ok);
check("no text fails", !validarScript(good.replace(/scene\.drawText\([^;]*;/g, "")).ok);
check("non-string fails", !validarScript(null).ok);

let calls = 0;
const fake = async () => {
  calls += 1;
  return calls === 1 ? { script: "function animateScene(){ throw new Error('x'); }".padEnd(400, " ") } : { script: good };
};
const result = await generarScriptVisual("Calculo", "Derivadas", "es", { llamar: fake });
check("retry returns valid script", result.script === good.trim() && calls === 2, `calls=${calls}`);

let failed = false;
try {
  await generarScriptVisual("Calculo", "Derivadas", "es", { llamar: async () => ({ script: "x" }) });
} catch {
  failed = true;
}
check("gives up after attempts", failed);

if (failures > 0) { console.log(`${failures} failed`); process.exit(1); }
console.log("all passed");
