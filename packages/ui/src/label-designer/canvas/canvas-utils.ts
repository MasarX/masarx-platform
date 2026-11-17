import type { TemplateBlock } from "./canvas-types";

/** Move block one position forward (higher z-index). */
export function bringForward(blocks: TemplateBlock[], index: number): TemplateBlock[] {
  if (index < 0 || index >= blocks.length - 1) return blocks;
  const next = [...blocks];
  [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
  return next;
}

/** Move block one position backward (lower z-index). */
export function sendBackward(blocks: TemplateBlock[], index: number): TemplateBlock[] {
  if (index <= 0 || index >= blocks.length) return blocks;
  const next = [...blocks];
  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
  return next;
}

/** Move block to the top of the stack. */
export function bringToFront(blocks: TemplateBlock[], index: number): TemplateBlock[] {
  if (index < 0 || index >= blocks.length) return blocks;
  const next = [...blocks];
  const [item] = next.splice(index, 1);
  next.push(item!);
  return next;
}

/** Move block to the bottom of the stack. */
export function sendToBack(blocks: TemplateBlock[], index: number): TemplateBlock[] {
  if (index < 0 || index >= blocks.length) return blocks;
  const next = [...blocks];
  const [item] = next.splice(index, 1);
  next.unshift(item!);
  return next;
}
