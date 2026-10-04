import type { Project } from '../../types';

/**
 * Bump when the audit interpretation changes. A report produced under an older schema can
 * never be displayed as "passed" after migration; it is forced to stale.
 */
export const AUDIT_SCHEMA_VERSION = 1;

/**
 * Content fingerprint of everything the seam composite depends on: group, lattice size,
 * every path (commands and coordinates) and every style field. Metadata such as updatedAt
 * is deliberately excluded: autosaves that only touch timestamps do not invalidate audits.
 */
export function contentFingerprint(project: Project): string {
  const payload = {
    v: AUDIT_SCHEMA_VERSION,
    g: project.group,
    w: Math.round(project.cellWidth * 1000) / 1000,
    h: Math.round(project.cellHeight * 1000) / 1000,
    o: project.objects.map((item) => [
      item.id,
      item.name,
      item.fill,
      item.stroke,
      item.strokeWidth,
      item.opacity,
      item.path.map((segment) => {
        switch (segment.type) {
          case 'M':
          case 'L':
            return [segment.type, r(segment.x), r(segment.y)];
          case 'Q':
            return [segment.type, r(segment.cx), r(segment.cy), r(segment.x), r(segment.y)];
          case 'C':
            return [
              segment.type,
              r(segment.cx1),
              r(segment.cy1),
              r(segment.cx2),
              r(segment.cy2),
              r(segment.x),
              r(segment.y)
            ];
          case 'Z':
            return ['Z'];
        }
      })
    ])
  };
  return fnv1a(JSON.stringify(payload));
}

function r(value: number): number {
  // Normalize -0 and float dust from interactive transforms.
  if (Math.abs(value) < 1e-9) return 0;
  return Math.round(value * 1e6) / 1e6;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
