export function parseGeositeRef(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const at = trimmed.indexOf('@');
  if (at === -1) return { tag: trimmed.toLowerCase(), attr: null };
  const tag = trimmed.slice(0, at).trim();
  const attr = trimmed.slice(at + 1).trim();
  if (!tag || !attr) return null;
  return { tag: tag.toLowerCase(), attr: attr.toLowerCase() };
}

export function formatGeositeRef(ref) {
  if (!ref || typeof ref.tag !== 'string') return '';
  const tag = ref.tag.toLowerCase();
  return ref.attr ? `${tag}@${ref.attr.toLowerCase()}` : tag;
}
