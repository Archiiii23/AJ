const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function nanoid(size = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let out = "";
  for (let i = 0; i < size; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export function prefixedId(prefix: string, size = 12): string {
  return `${prefix}_${nanoid(size)}`;
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "")
      .slice(0, 60) || nanoid(8)
  );
}
