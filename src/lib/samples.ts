import type { GroupId, PathSegment, PatternObject, Project } from '../types';
import { ellipsePath, rectanglePath, uid } from './path';

function object(id: string, name: string, path: PathSegment[], style: Partial<PatternObject> = {}): PatternObject {
  return {
    id,
    name,
    path,
    fill: '#2d7ff9',
    stroke: '#12376d',
    strokeWidth: 3,
    opacity: 1,
    ...style
  };
}

function baseProject(group: GroupId, name: string, width: number, height: number, objects: PatternObject[]): Project {
  return {
    id: uid('project'),
    name,
    group,
    cellWidth: width,
    cellHeight: height,
    objects,
    updatedAt: Date.now()
  };
}

export function p6mSample(): Project {
  const w = 280;
  const h = (Math.sqrt(3) / 2) * w;
  // The p6m fundamental chamber is the triangle (0,0)-(w/6,0)-(w/2,h/3).
  const ribbon = rectanglePath(24, 8, 110, 20);
  const arcDot = ellipsePath(38, 47, 14, 9);
  const transparentLeaf = ellipsePath(73, 17, 10, 31);
  return baseProject(
    'p6m',
    '六重旋转 + 镜面 / 滑移',
    w,
    h,
    [
      object(uid('object'), '跨边界蓝带', ribbon, {
        fill: '#2563eb',
        stroke: '#0f172a',
        strokeWidth: 3,
        opacity: 0.88
      }),
      object(uid('object'), '旋转中心圆点', arcDot, {
        fill: '#f59e0b',
        stroke: '#78350f',
        strokeWidth: 2,
        opacity: 1
      }),
      object(uid('object'), '透明边缘叶片', transparentLeaf, {
        fill: '#14b8a6',
        stroke: '#134e4a',
        strokeWidth: 2,
        opacity: 0.42
      })
    ]
  );
}

export function glideSample(): Project {
  const w = 260;
  const h = 200;
  // pg fundamental half is y: 0..h/2. For the exported tile to actually repeat,
  // every motif must (a) stay strictly inside the half so the glide image closes
  // it smoothly at y = 0 and y = h/2, and (b) cross the left/right edges with the
  // same cross-section (this feather enters at x<0 and leaves at x>w at the same
  // y range), so horizontal translation joins without a step.
  // Flat horizontal ribbon crossing BOTH x-edges with identical straight vertical
  // ends (y=24..40): horizontal translation joins seamlessly, and because its
  // edges are horizontal the glide image (mirror at y=0 + shift w/2) joins it
  // smoothly across the y=0 and y=h/2 seams as well.
  const ribbon = [
    { type: 'M' as const, x: -40, y: 24 },
    { type: 'L' as const, x: w + 40, y: 24 },
    { type: 'L' as const, x: w + 40, y: 40 },
    { type: 'L' as const, x: -40, y: 40 },
    { type: 'Z' as const }
  ];
  // An interior feather entirely inside the fundamental half; its glide reflection
  // fills the opposite half upside down, demonstrating the pg symmetry without
  // touching any periodic boundary.
  const feather = [
    { type: 'M' as const, x: 40, y: 62 },
    { type: 'C' as const, cx1: 80, cy1: 52, cx2: 120, cy2: 54, x: 156, y: 66 },
    { type: 'C' as const, cx1: 120, cy1: 80, cx2: 80, cy2: 82, x: 40, y: 72 },
    { type: 'Z' as const }
  ];
  const dot = ellipsePath(212, 76, 11, 11);
  return baseProject(
    'pg',
    '滑移反射羽毛',
    w,
    h,
    [
      object(uid('object'), '跨左右边界横带', ribbon, {
        fill: '#dc2626',
        stroke: '#450a0a',
        strokeWidth: 3,
        opacity: 0.9
      }),
      object(uid('object'), '滑移羽毛', feather, {
        fill: '#f97316',
        stroke: '#7c2d12',
        strokeWidth: 2,
        opacity: 0.85
      }),
      object(uid('object'), '滑移点', dot, {
        fill: '#fde047',
        stroke: '#713f12',
        strokeWidth: 2,
        opacity: 0.78
      })
    ]
  );
}

export function rotationSample(): Project {
  const w = 240;
  // p4 ignores height and uses a square conventional cell.
  const wedge = [
    { type: 'M' as const, x: 10, y: 8 },
    { type: 'L' as const, x: 104, y: 0 },
    { type: 'Q' as const, cx: 76, cy: 38, x: 22, y: 58 },
    { type: 'C' as const, cx1: 5, cy1: 40, cx2: 7, cy2: 20, x: 10, y: 8 },
    { type: 'Z' as const }
  ];
  const glassTile = rectanglePath(24, 74, 72, 34);
  return baseProject(
    'p4m',
    '90° 旋转与对角反射',
    w,
    w,
    [
      object(uid('object'), '四向楔形', wedge, {
        fill: '#7c3aed',
        stroke: '#2e1065',
        strokeWidth: 3,
        opacity: 0.86
      }),
      object(uid('object'), '半透明方片', glassTile, {
        fill: '#06b6d4',
        stroke: '#083344',
        strokeWidth: 2,
        opacity: 0.38
      })
    ]
  );
}

export function defaultProject(): Project {
  return p6mSample();
}

/**
 * p1 sample specifically for seam audit acceptance: a semi-transparent ribbon with
 * a visible stroke whose single source path crosses BOTH periodic vertical edges
 * (x = 0 and x = w). Its cross-section at the two edges is identical, so the
 * geometry mask and premultiplied composite must agree across the left/right seam
 * after horizontal translation — while deliberately breaking (e.g. dragging a node
 * on one side) must fail and point back to this unique source object.
 */
export function seamP1Sample(): Project {
  const w = 260;
  const h = 200;
  const ribbon = [
    { type: 'M' as const, x: -34, y: 82 },
    { type: 'L' as const, x: w + 34, y: 82 },
    { type: 'L' as const, x: w + 34, y: 112 },
    { type: 'L' as const, x: -34, y: 112 },
    { type: 'Z' as const }
  ];
  const inner = ellipsePath(w / 2, h / 2 + 34, 26, 15);
  return baseProject(
    'p1',
    'p1 跨左右边界透明路径',
    w,
    h,
    [
      object(uid('object'), '跨边界透明描边带', ribbon, {
        fill: '#14b8a6',
        stroke: '#134e4a',
        strokeWidth: 4,
        opacity: 0.45
      }),
      object(uid('object'), '内部圆点', inner, {
        fill: '#f59e0b',
        stroke: '#78350f',
        strokeWidth: 2,
        opacity: 0.9
      })
    ]
  );
}
