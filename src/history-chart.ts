import * as d3 from 'd3';
import { formatMonth } from '../shared/format';
import type { DailyPoint } from '../shared/types';
import { escapeHtml } from './treemap';

export interface Series {
  name: string;
  values: (number | null)[];
  color: string;
  width?: number;
  dash?: string;
}

/** Monthly line chart (0–100 score scale). */
export function renderHistoryChart(el: HTMLElement, months: string[], series: Series[], current: string) {
  el.replaceChildren();
  if (months.length < 2) {
    el.innerHTML = `<p class="note">History appears once more than one month has been collected.</p>`;
    if (months.length === 0) return;
  }
  const width = Math.max(240, el.clientWidth || 320);
  const height = 170;
  const m = { top: 10, right: 12, bottom: 22, left: 28 };
  const x = d3
    .scalePoint<string>()
    .domain(months)
    .range([m.left, width - m.right])
    .padding(months.length === 1 ? 0.5 : 0.1);
  const y = d3.scaleLinear().domain([0, 100]).range([height - m.bottom, m.top]);

  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('class', 'chart').attr('role', 'img');
  svg.append('title').text('Score per month');
  svg
    .append('g')
    .attr('class', 'chart__grid')
    .selectAll('line')
    .data([0, 25, 50, 75, 100])
    .join('line')
    .attr('x1', m.left)
    .attr('x2', width - m.right)
    .attr('y1', (d) => y(d))
    .attr('y2', (d) => y(d));
  svg
    .append('g')
    .attr('class', 'chart__axis')
    .attr('transform', `translate(${m.left - 4},0)`)
    .call(d3.axisLeft(y).tickValues([0, 50, 100]).tickSize(0))
    .call((g) => g.select('.domain').remove());
  const step = Math.ceil(months.length / Math.max(1, Math.floor((width - m.left) / 60)));
  svg
    .append('g')
    .attr('class', 'chart__axis')
    .attr('transform', `translate(0,${height - m.bottom + 4})`)
    .call(
      d3
        .axisBottom(x)
        .tickSize(0)
        .tickValues(months.filter((_, i) => i % step === 0 || months[i] === current))
        .tickFormat((d) => formatMonth(d).replace(/ (\d{2})(\d{2})$/, " '$2")),
    )
    .call((g) => g.select('.domain').remove());

  if (x(current) != null) {
    svg
      .append('line')
      .attr('class', 'chart__cursor')
      .attr('x1', x(current)!)
      .attr('x2', x(current)!)
      .attr('y1', m.top)
      .attr('y2', height - m.bottom);
  }

  const line = d3
    .line<number | null>()
    .defined((d) => d != null)
    .x((_, i) => x(months[i])!)
    .y((d) => y(d ?? 0));
  for (const s of series) {
    svg
      .append('path')
      .attr('d', line(s.values))
      .attr('fill', 'none')
      .attr('stroke', s.color)
      .attr('stroke-width', s.width ?? 1.5)
      .attr('stroke-dasharray', s.dash ?? null)
      .attr('stroke-linejoin', 'round');
    svg
      .append('g')
      .selectAll('circle')
      .data(s.values.map((v, i) => ({ v, i })).filter((d) => d.v != null))
      .join('circle')
      .attr('cx', (d) => x(months[d.i])!)
      .attr('cy', (d) => y(d.v!))
      .attr('r', (s.width ?? 1.5) + 1)
      .attr('fill', s.color)
      .append('title')
      .text((d) => `${s.name} · ${formatMonth(months[d.i])}: ${d.v!.toFixed(1)}`);
  }

  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  legend.innerHTML = series
    .map(
      (s) =>
        `<span class="chart-legend__item"><svg width="16" height="8" aria-hidden="true"><line x1="0" x2="16" y1="4" y2="4" stroke="${s.color}" stroke-width="${s.width ?? 1.5}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/></svg>${escapeHtml(s.name)}</span>`,
    )
    .join('');
  el.appendChild(legend);
}

/** Daily active users bars for the selected month. */
export function renderDaily(el: HTMLElement, daily: DailyPoint[], seats: number) {
  el.replaceChildren();
  if (!daily.length) return;
  const width = Math.max(240, el.clientWidth || 320);
  const height = 56;
  const x = d3
    .scaleBand<string>()
    .domain(daily.map((d) => d.day))
    .range([0, width])
    .padding(0.15);
  const y = d3
    .scaleLinear()
    .domain([0, Math.max(seats, d3.max(daily, (d) => d.active_users) ?? 1)])
    .range([height, 2]);
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('class', 'chart chart--daily').attr('role', 'img');
  svg.append('title').text('Active developers per day');
  svg
    .selectAll('rect')
    .data(daily)
    .join('rect')
    .attr('x', (d) => x(d.day)!)
    .attr('width', x.bandwidth())
    .attr('y', (d) => y(d.active_users))
    .attr('height', (d) => height - y(d.active_users))
    .attr('rx', 1)
    .append('title')
    .text((d) => `${d.day}: ${d.active_users} active · ${d3.format('.3~s')(d.tokens)} tokens · $${d.cost_usd.toFixed(2)}`);
}
