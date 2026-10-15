import * as d3 from 'd3';
import type { TeamMonth } from '../shared/types';
import { colorScale, textOn } from './scores';

export interface TreemapInput {
  teams: TeamMonth[];
  score: (t: TeamMonth) => number;
  base: number;
  selected: string | null;
  levelName: (level: number) => string;
  onSelect: (id: string | null) => void;
}

let last: TreemapInput | null = null;
let observer: ResizeObserver | null = null;

export function renderTreemap(el: HTMLElement, input: TreemapInput) {
  last = input;
  if (!observer) {
    let w = el.clientWidth;
    observer = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - w) > 4 && last) {
        w = el.clientWidth;
        draw(el, last);
      }
    });
    observer.observe(el);
  }
  draw(el, input);
}

function draw(el: HTMLElement, { teams, score, base, selected, levelName, onSelect }: TreemapInput) {
  el.replaceChildren();
  if (!teams.length) {
    el.innerHTML = '<div class="blankslate"><h3 class="blankslate-heading">No teams for this period</h3><p>No team membership was reported (teams with fewer than 5 Copilot seats are not reported by GitHub).</p></div>';
    return;
  }
  const width = el.clientWidth || 800;
  const height = Math.max(380, Math.min(640, Math.round(width * 0.62)));
  el.style.height = `${height}px`;

  const scores = teams.map(score);
  const color = colorScale(scores, base);
  const root = d3
    .hierarchy<{ children?: TeamMonth[] } | TeamMonth>({ children: teams })
    .sum((d) => ('seats' in d ? Math.max(1, d.seats) : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  d3.treemap<{ children?: TeamMonth[] } | TeamMonth>().size([width, height]).paddingInner(4).round(true).tile(d3.treemapSquarify.ratio(1.3))(root);

  for (const leaf of root.leaves() as d3.HierarchyRectangularNode<TeamMonth>[]) {
    const t = leaf.data;
    const s = score(t);
    const bg = color(s);
    const w = leaf.x1 - leaf.x0;
    const h = leaf.y1 - leaf.y0;
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile' + (selected === t.id ? ' tile--selected' : '') + (selected && selected !== t.id ? ' tile--dimmed' : '');
    tile.setAttribute('role', 'listitem');
    tile.setAttribute('aria-pressed', String(selected === t.id));
    tile.style.cssText = `left:${leaf.x0}px;top:${leaf.y0}px;width:${w}px;height:${h}px;background:${bg};color:${textOn(bg)}`;
    const delta = s - base;
    tile.title = `${t.name}\nScore ${s.toFixed(1)} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)} vs org average ${base.toFixed(1)})\nL${t.maturity} ${levelName(t.maturity)} · ${t.seats} seats · ${t.active} active`;
    const compact = w < 120 || h < 70;
    tile.innerHTML = `
      <span class="tile__name">${escapeHtml(t.name)}</span>
      <span class="tile__score">${s.toFixed(0)}</span>
      ${compact ? '' : `<span class="tile__meta"><span class="tile__level">L${t.maturity}</span> ${t.seats} seats</span>`}`;
    tile.addEventListener('click', () => onSelect(selected === t.id ? null : t.id));
    el.appendChild(tile);
  }
}

export function renderLegend(el: HTMLElement, scores: number[], base: number, label: string) {
  const color = colorScale(scores, base);
  const lo = Math.min(...scores, base);
  const hi = Math.max(...scores, base);
  const stops = d3.range(0, 1.0001, 0.1).map((f) => `${color(lo + (hi - lo) * f)} ${Math.round(f * 100)}%`);
  el.innerHTML = `
    <span class="legend__label">${escapeHtml(label)}</span>
    <span class="legend__end">${lo.toFixed(0)}</span>
    <span class="legend__bar" style="background:linear-gradient(90deg, ${stops.join(',')})"></span>
    <span class="legend__end">${hi.toFixed(0)}</span>
    <span class="legend__note">org avg ${base.toFixed(0)} · size = seats</span>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
