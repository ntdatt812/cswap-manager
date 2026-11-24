type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Builds an object from only the defined entries, so normalized data never has explicit `undefined` keys. */
export function compact<T extends object>(entries: { [K in keyof T]: T[K] | undefined }): T {
  const result: Partial<Mutable<T>> = {};
  for (const key of Object.keys(entries) as Array<keyof T>) {
    const value = entries[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}
