const tails = new Map();

export function withKey(key, fn) {
  const previous = tails.get(key) || Promise.resolve();
  const run = previous.then(() => fn());
  const tail = run.catch(() => {});
  tails.set(key, tail);
  tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
