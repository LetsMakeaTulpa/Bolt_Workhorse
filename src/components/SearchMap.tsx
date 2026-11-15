import { useEffect, useRef } from 'react';
import { ENGINE_CATALOG } from '../lib/engines';
import type { Source } from '../types';

/**
 * Live 3D cluster map of a search.
 *
 * Each engine owns a hub on a Fibonacci sphere; every source orbits its engine's hub.
 * Nodes ignite as results arrive (so a search visibly fills the sphere), hubs pulse while
 * engines are still working, and the whole cloud turns slowly. Hand-rolled projection in
 * 2D canvas: no three.js, no new dependency, and it stays cheap at ~60 nodes.
 */

const GROUP_COLORS: Record<string, string> = {
  Web: '#d6d9dd',
  Academic: '#b8bcc2',
  Community: '#9ca1a8',
  'Deep web': '#82878e',
  'Dark web': '#6a6f76',
  OSINT: '#c4c8ce',
};

const baseEngine = (engine: string) => (engine || 'unknown').split('+')[0].trim();

const engineGroup = (engine: string) => ENGINE_CATALOG.find((item) => item.id === baseEngine(engine))?.group ?? 'Web';

const engineLabel = (engine: string) => ENGINE_CATALOG.find((item) => item.id === baseEngine(engine))?.label ?? baseEngine(engine);

interface Node {
  url: string;
  title: string;
  engine: string;
  group: string;
  born: number;
  ox: number;
  oy: number;
  oz: number;
  phase: number;
}

type Vec = { x: number; y: number; z: number };

/**
 * Hubs sit on a vertical ring with alternating depth: the panel is tall and narrow, so this
 * spreads engines down the column instead of piling them into one ball at the centre.
 */
function ringHub(index: number, count: number): Vec {
  if (count <= 1) return { x: 0, y: 0, z: 0 };
  const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
  return {
    x: Math.cos(angle) * 0.72,
    y: Math.sin(angle) * 0.9,
    z: index % 2 === 0 ? 0.28 : -0.28,
  };
}

export function SearchMap({ results, isSearching }: { results: Source[]; isSearching: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const hubsRef = useRef<Map<string, Vec>>(new Map());
  const searchingRef = useRef(isSearching);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const projectedRef = useRef<{ node: Node; sx: number; sy: number }[]>([]);

  searchingRef.current = isSearching;

  useEffect(() => {
    const now = performance.now();
    const known = new Map(nodesRef.current.map((node) => [node.url, node]));
    const next: Node[] = [];

    for (const result of results) {
      const existing = known.get(result.url);
      if (existing) {
        next.push(existing);
        continue;
      }
      const engine = result.source_engine || 'unknown';
      next.push({
        url: result.url,
        title: result.title,
        engine,
        group: engineGroup(engine),
        born: now,
        ox: (Math.random() - 0.5) * 0.9,
        oy: (Math.random() - 0.5) * 0.9,
        oz: (Math.random() - 0.5) * 0.9,
        phase: Math.random() * Math.PI * 2,
      });
    }

    const engines = [...new Set(next.map((node) => node.engine))];
    const hubs = new Map<string, Vec>();
    engines.forEach((engine, index) => hubs.set(engine, ringHub(index, engines.length)));
    hubsRef.current = hubs;
    nodesRef.current = next;
  }, [results]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 1;
    let height = 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let frame = 0;
    const started = performance.now();

    const draw = (now: number) => {
      const elapsed = now - started;
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width * 0.44, height * 0.4);
      const yaw = elapsed * 0.00022;
      const pitch = -0.32;
      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);
      const cosPitch = Math.cos(pitch);
      const sinPitch = Math.sin(pitch);

      const project = (v: Vec) => {
        const x = v.x * cosYaw - v.z * sinYaw;
        const z1 = v.x * sinYaw + v.z * cosYaw;
        const y = v.y * cosPitch - z1 * sinPitch;
        const z = v.y * sinPitch + z1 * cosPitch;
        const scale = 2.6 / (2.6 + z);
        return { sx: cx + x * radius * scale, sy: cy + y * radius * scale, z, scale };
      };

      ctx.clearRect(0, 0, width, height);

      // faint orbital shell
      ctx.strokeStyle = 'rgba(201,206,212,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius * 0.98, radius * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();

      const hubs = hubsRef.current;
      const nodes = nodesRef.current;
      const scanning = searchingRef.current;
      const projected: { node: Node; sx: number; sy: number; depth: number }[] = [];

      // hub → node links
      for (const node of nodes) {
        const hub = hubs.get(node.engine);
        if (!hub) continue;
        const from = project(hub);
        const drift = 0.44;
        const wobble = Math.sin(elapsed * 0.0006 + node.phase) * 0.06;
        const position: Vec = {
          x: hub.x + node.ox * drift + wobble,
          y: hub.y + node.oy * drift + wobble * 0.6,
          z: hub.z + node.oz * drift,
        };
        const to = project(position);
        const age = Math.min(1, (now - node.born) / 520);
        const color = GROUP_COLORS[node.group] ?? GROUP_COLORS.Web;
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.10 * age * to.scale;
        ctx.beginPath();
        ctx.moveTo(from.sx, from.sy);
        ctx.lineTo(to.sx, to.sy);
        ctx.stroke();
        ctx.globalAlpha = 1;
        projected.push({ node, sx: to.sx, sy: to.sy, depth: to.z });
      }

      // hubs with labels
      for (const [engine, hub] of hubs) {
        const count = nodes.filter((node) => node.engine === engine).length;
        const point = project(hub);
        const color = GROUP_COLORS[engineGroup(engine)] ?? GROUP_COLORS.Web;
        const pulse = scanning ? 0.55 + 0.45 * Math.sin(elapsed * 0.004 + count) : 0.55;
        ctx.globalAlpha = point.scale;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(point.sx, point.sy, 2.6 + count * 0.16, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.9 * pulse;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(point.sx, point.sy, 5 + count * 0.2 + (scanning ? Math.sin(elapsed * 0.004) * 1.6 : 0), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = color;
        ctx.font = '9px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        const shortLabel = engineLabel(engine).replace(/\s*\(.*\)$/, '').toUpperCase();
        ctx.fillText(`${shortLabel} ${count}`, point.sx, point.sy - 9);
        ctx.globalAlpha = 1;
      }

      // nodes, far to near
      projected.sort((a, b) => b.depth - a.depth);
      for (const item of projected) {
        const age = Math.min(1, (now - item.node.born) / 520);
        const color = GROUP_COLORS[item.node.group] ?? GROUP_COLORS.Web;
        const size = (1.5 + 2.2 * item.depth * 0) + 2.4 * age;
        ctx.globalAlpha = 0.35 + 0.65 * age;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(item.sx, item.sy, size, 0, Math.PI * 2);
        ctx.fill();
        if (age < 1) {
          ctx.globalAlpha = (1 - age) * 0.8;
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.arc(item.sx, item.sy, 3 + (1 - age) * 14, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // scan sweep while searching
      if (scanning) {
        const sweep = (elapsed * 0.00035) % 1;
        const y = cy - radius * 0.5 + sweep * radius;
        const gradient = ctx.createLinearGradient(0, y - 12, 0, y + 12);
        gradient.addColorStop(0, 'rgba(201,206,212,0)');
        gradient.addColorStop(0.5, 'rgba(201,206,212,0.16)');
        gradient.addColorStop(1, 'rgba(201,206,212,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(cx - radius, y - 12, radius * 2, 24);
      }

      // hover label
      const hover = hoverRef.current;
      if (hover && projected.length > 0) {
        let nearest: { node: Node; sx: number; sy: number } | null = null;
        let best = 14;
        for (const item of projected) {
          const distance = Math.hypot(item.sx - hover.x, item.sy - hover.y);
          if (distance < best) {
            best = distance;
            nearest = { node: item.node, sx: item.sx, sy: item.sy };
          }
        }
        if (nearest) {
          const label = nearest.node.title.length > 38 ? `${nearest.node.title.slice(0, 38)}…` : nearest.node.title;
          ctx.font = '9px Inter, system-ui, sans-serif';
          const textWidth = ctx.measureText(label).width;
          const boxWidth = Math.min(width - 8, textWidth + 10);
          const boxX = Math.min(Math.max(4, nearest.sx - boxWidth / 2), width - boxWidth - 4);
          const boxY = Math.max(4, nearest.sy - 22);
          ctx.fillStyle = 'rgba(18,18,20,0.94)';
          ctx.strokeStyle = 'rgba(58,58,64,1)';
          ctx.beginPath();
          ctx.roundRect(boxX, boxY, boxWidth, 16, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#e3e4e6';
          ctx.textAlign = 'left';
          ctx.fillText(label, boxX + 5, boxY + 11);
        }
      }

      projectedRef.current = projected.map((item) => ({ node: item.node, sx: item.sx, sy: item.sy }));
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);

    const onMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      hoverRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onLeave = () => {
      hoverRef.current = null;
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  const engines = [...new Set(nodesRef.current.map((node) => node.engine))].filter(Boolean);
  const groups = [...new Set(engines.map(engineGroup))];

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1">
        <canvas
          ref={canvasRef}
          className="h-full w-full"
          aria-label={`Cluster map of ${results.length} sources across ${engines.length} engines`}
          role="img"
        />
        {results.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
            <span className="text-[11px] text-text-secondary">Cluster map</span>
            <span className="text-[10px] text-text-muted">Run a search to light it up</span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border-subtle px-3 py-2">
        {groups.length === 0 ? (
          <span className="text-[10px] text-text-muted">
            {isSearching ? 'Scanning engines…' : 'No clusters yet'}
          </span>
        ) : (
          groups.map((group) => (
            <span key={group} className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-text-muted">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: GROUP_COLORS[group] }} />
              {group}
            </span>
          ))
        )}
        <span className="ml-auto text-[9px] text-text-muted">
          {results.length} sources · {engines.length} engines
        </span>
      </div>
    </div>
  );
}
