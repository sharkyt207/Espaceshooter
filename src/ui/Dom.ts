/**
 * Dom - minimal element helpers.
 *
 * The UI is plain DOM rather than a framework: it keeps the bundle tiny, keeps
 * text crisp at any render scale, and gives us native touch handling and
 * accessibility for free. These helpers exist only to keep the screen code
 * readable - there is no virtual DOM and no reconciliation.
 */

export type Attrs = {
  class?: string;
  id?: string;
  text?: string;
  html?: string;
  title?: string;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  [key: string]: unknown;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key === 'style') Object.assign(node.style, value as Partial<CSSStyleDeclaration>);
    else if (key === 'dataset') Object.assign(node.dataset, value as Record<string, string>);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Button with a pointer handler that never double-fires on touch devices. */
export function button(
  label: string,
  onTap: () => void,
  className = 'btn',
  attrs: Attrs = {},
): HTMLButtonElement {
  const node = el('button', { class: className, type: 'button', ...attrs }, [label]);
  node.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onTap();
  });
  return node;
}

/** Formats a currency amount with thin separators. */
export function money(amount: number): string {
  return `${Math.round(amount).toLocaleString('de-DE')} ¤`;
}

/** Formats seconds as m:ss, or h:mm:ss beyond an hour. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function weight(kg: number): string {
  return `${kg.toFixed(1)} kg`;
}

/** Horizontal progress bar with an optional label. */
export function bar(fraction: number, color: string, label?: string): HTMLElement {
  const clamped = Math.max(0, Math.min(1, fraction));
  return el('div', { class: 'bar' }, [
    el('div', { class: 'bar-fill', style: { width: `${clamped * 100}%`, background: color } }),
    label ? el('span', { class: 'bar-label', text: label }) : null,
  ]);
}
