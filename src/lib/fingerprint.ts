import type { Project } from '../types';

/**
 * Content fingerprint of everything that can change what the pattern looks like or
 * how its orbit instances are generated: group, cell size, and every object's path
 * geometry and style. Project name, id and updatedAt are deliberately excluded —
 * renaming or the debounced auto-save must not invalidate an audit.
 */
export function contentFingerprint(project: Project): string {
  const parts: Array<string | number> = [project.group, project.cellWidth, project.cellHeight];
  for (const item of project.objects) {
    parts.push('O', item.id, item.fill, item.stroke, item.strokeWidth, item.opacity);
    for (const segment of item.path) {
      switch (segment.type) {
        case 'M':
        case 'L':
          parts.push(segment.type, num(segment.x), num(segment.y));
          break;
        case 'Q':
          parts.push(segment.type, num(segment.cx), num(segment.cy), num(segment.x), num(segment.y));
          break;
        case 'C':
          parts.push(
            segment.type,
            num(segment.cx1),
            num(segment.cy1),
            num(segment.cx2),
            num(segment.cy2),
            num(segment.x),
            num(segment.y)
          );
          break;
        case 'Z':
          parts.push('Z');
          break;
      }
    }
    parts.push('/');
  }
  return `fp2:${fnv1a(parts.join('|'))}`;
}

function num(value: number): string {
  // Round float drift from node edits so equivalent geometry hashes identically.
  return (Math.round(value * 1e6) / 1e6).toString();
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
