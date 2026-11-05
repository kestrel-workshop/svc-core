import assert from "node:assert/strict";
import { validarPreguntas } from "./lib/validarEstructura.js";

const question = {
  enunciado: "2 + 2?",
  opciones: ["3", "4", "5", "6"],
  respuesta_correcta: 1,
  explicacion: "Sum.",
};
const model = (premium) => ({ premium, preguntas: [question] });

const good = { modelos: [model(false), model(false), model(false), model(true), model(true), model(true)] };
assert.equal(validarPreguntas(good).ok, true);

const allRegular = { modelos: Array.from({ length: 6 }, () => model(false)) };
const noPremium = validarPreguntas(allRegular);
assert.equal(noPremium.ok, false);
assert.match(noPremium.errores.join(" "), /3 con premium=false y 3 con premium=true/);

const fiveOne = { modelos: [model(false), model(false), model(false), model(false), model(false), model(true)] };
assert.equal(validarPreguntas(fiveOne).ok, false);

const fourTwo = { modelos: [model(false), model(false), model(false), model(false), model(true), model(true)] };
assert.equal(validarPreguntas(fourTwo).ok, false);

console.log("ok");
