import { compositeScore } from '../shared/scoring';
import type { Manifest, MetricKey, PersonMonth, TeamMonth, Weights } from '../shared/types';
import { METRIC_KEYS } from '../shared/types';
import { mixBar } from './pane';
import { type Baselines, formatCompact, formatMetric, formatUsd, verdict } from './scores';
import { escapeHtml } from './treemap';

type SortKey = 'key' | 'maturity' | 'score' | 'active_days' | 'tokens' | 'cost_usd' | MetricKey;
let sort: { key: SortKey; dir: 1 | -1 } = { key: 'score', dir: -1 };

export interface PeopleInput {
  manifest: Manifest;
  team: TeamMonth | null;
  weights: Weights;
  base: Baselines;
  workingDays: number;
  monthLabel: string;
}

export function renderPeople(el: HTMLElement, input: PeopleInput) {
  const { team, manifest } = input;
  const head = `<h2 id="people-title" class="section__title">Team members</h2>`;
  if (!team) {
    el.innerHTML = `${head}<div class="Box"><div class="blankslate blankslate-narrow"><p>Select a team tile to list its members with person-level metrics.</p></div></div>`;
    return;
  }
  const value = (p: PersonMonth, k: SortKey): number | string => {
    if (k === 'key') return p.key.toLowerCase();
    if (k === 'score') return compositeScore(p.subscores, input.weights);
    if (k === 'maturity' || k === 'active_days' || k === 'tokens' || k === 'cost_usd') return p[k];
    return p.metrics[k] ?? -Infinity;
  };
  const rows = [...team.people].sort((a, b) => {
    const va = value(a, sort.key);
    const vb = value(b, sort.key);
    return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
  });

  const th = (k: SortKey, label: string, num = true) => {
    const active = sort.key === k;
    return `<th scope="col" class="${num ? 'num' : ''}" aria-sort="${active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}">
      <button type="button" class="th-sort" data-sort="${k}">${label}${active ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button></th>`;
  };
  const cell = (p: PersonMonth, k: MetricKey) => {
    const sub = p.subscores[k];
    const v = sub == null ? 'none' : verdict(sub, input.base.sub[k]);
    return `<td class="num cell--${v}" title="Score ${sub == null ? '–' : sub.toFixed(0)} (org avg ${input.base.sub[k].toFixed(0)})">${formatMetric(k, p.metrics[k])}</td>`;
  };
  const level = (n: number) => manifest.maturity_levels.find((l) => l.level === n)?.name ?? '';

  el.innerHTML = `${head}
    <div class="Box">
      <div class="Box-header d-flex flex-items-center flex-justify-between">
        <h3 class="Box-title">${escapeHtml(team.name)} <span class="Counter">${team.people.length}</span></h3>
        <span class="color-fg-muted f6">${escapeHtml(input.monthLabel)} · ${input.workingDays} working days · cells coloured vs. the org average${
          manifest.pseudonymized ? ' · names pseudonymized' : ''
        }</span>
      </div>
      <div class="table-wrap">
        <table class="people">
          <thead><tr>
            ${th('key', 'Developer', false)}
            ${th('maturity', 'Level')}
            ${th('score', 'Score')}
            ${th('active_days', 'Active days')}
            ${th('active_day_ratio', 'Active %')}
            ${th('tokens', 'Tokens')}
            ${th('cost_usd', 'Spend')}
            ${th('tokens_per_dollar', 'Tokens / $')}
            ${th('model_mix_health', 'Mix health')}
            <th scope="col">Model mix</th>
            <th scope="col">Source</th>
          </tr></thead>
          <tbody>
            ${rows
              .map((p) => {
                const s = compositeScore(p.subscores, input.weights);
                return `<tr>
                  <th scope="row" class="people__name">${escapeHtml(p.key)}</th>
                  <td class="num"><span class="Label level__badge--l${p.maturity}" title="${escapeHtml(level(p.maturity))}">L${p.maturity}</span></td>
                  <td class="num cell--${verdict(s, input.base.composite)}">${s.toFixed(0)}</td>
                  <td class="num">${p.active_days}</td>
                  ${cell(p, 'active_day_ratio')}
                  <td class="num">${formatCompact(p.tokens)}</td>
                  <td class="num">${formatUsd(p.cost_usd)}</td>
                  ${cell(p, 'tokens_per_dollar')}
                  ${cell(p, 'model_mix_health')}
                  <td class="people__mix">${p.interactions ? mixBar(p.model_shares) : '<span class="color-fg-muted">–</span>'}</td>
                  <td class="f6 color-fg-muted">${p.token_source}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="Box-footer f6 color-fg-muted">Token volume is scored at team level (median over active members); the person-level score uses each person's own monthly tokens.</div>
    </div>`;
  el.querySelectorAll<HTMLButtonElement>('[data-sort]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.sort as SortKey;
      sort = sort.key === k ? { key: k, dir: (sort.dir * -1) as 1 | -1 } : { key: k, dir: k === 'key' ? 1 : -1 };
      renderPeople(el, input);
    }),
  );
}

export { METRIC_KEYS };
