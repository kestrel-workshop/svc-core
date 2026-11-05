export function tokenize(text) {
  const plain = String(text || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const out = new Set();
  for (const word of plain.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)) {
      const chars = [...word];
      if (chars.length === 1) out.add(word);
      for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
    } else if (word.length > 1 || /\p{N}/u.test(word)) {
      out.add(word);
    }
  }
  return out;
}
