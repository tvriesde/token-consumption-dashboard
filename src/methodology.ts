import { METRIC_META } from '../shared/metrics-meta';
import type { Manifest, MetricKey, Weights } from '../shared/types';
import { METRIC_KEYS, SCORED_TIERS } from '../shared/types';
import { TIER_COLORS } from './pane';
import { formatMetric } from './scores';
import { escapeHtml } from './treemap';

const targetText = (k: MetricKey, v: number) => formatMetric(k, v);

export function renderMethodology(el: HTMLElement, m: Manifest, weights: Weights) {
  const wsum = METRIC_KEYS.reduce((s, k) => s + weights[k], 0) || 1;
  const levels = [...m.maturity_levels].sort((a, b) => a.level - b.level);
  const reqKeys = METRIC_KEYS.filter((k) => levels.some((l) => l.min[k] != null));
  const scopeText = m.scope === 'enterprise' ? 'the enterprise' : 'each organization';

  el.innerHTML = `
    <h2 id="methodology-title" class="section__title">How the scores work</h2>
    <div class="method-grid">
      ${METRIC_KEYS.map(
        (k) => `
        <div class="Box method-card">
          <div class="Box-header method-card__head" style="--metric-color:var(--metric-${k})">
            <h3 class="Box-title">${METRIC_META[k].label}</h3>
            <span class="Label">${Math.round((weights[k] / wsum) * 100)}% weight</span>
          </div>
          <div class="Box-body">
            <p>${escapeHtml(METRIC_META[k].description)}</p>
            <dl class="method-dl">
              <dt>Formula</dt><dd><code>${escapeHtml(METRIC_META[k].formula)}</code></dd>
              <dt>Target (= 100)</dt><dd>${targetText(k, m.metric_targets[k])}</dd>
              <dt>Scoring</dt><dd>${escapeHtml(METRIC_META[k].scoring)}</dd>
            </dl>
          </div>
        </div>`,
      ).join('')}
    </div>

    <div class="method-cols">
      <div class="Box">
        <div class="Box-header"><h3 class="Box-title">Score &amp; colour</h3></div>
        <div class="Box-body">
          <p>Every metric is converted to a 0–100 sub-score. The <strong>team score</strong> is the weighted average of the four sub-scores
          (missing data counts as 0). Weights default to equal and can be changed with the <em>Weights</em> control — your choice is kept in this browser and in the URL.</p>
          <p><strong>Tile size</strong> is the number of Copilot seats in the team. <strong>Tile colour</strong> compares the team with the
          <strong>org average</strong> (seat-weighted mean of all teams shown): <span class="swatch swatch--good"></span> green is above,
          <span class="swatch swatch--bad"></span> red is below, grey is within ±2 points. Selecting a tile colours each metric in the side panel the same way, so it is clear where a team can improve.</p>
        </div>
      </div>
      <div class="Box">
        <div class="Box-header"><h3 class="Box-title">Healthy model mix</h3></div>
        <div class="Box-body">
          <p>Models are grouped into tiers by name pattern. The target mix below scores 100; drifting away from it lowers the model-mix score.</p>
          <ul class="tier-list">
            ${SCORED_TIERS.map((t) => {
              const rule = m.model_tiers.find((r) => r.tier === t);
              return `<li><span class="swatch" style="background:${TIER_COLORS[t]}"></span><strong>${t[0].toUpperCase() + t.slice(1)}</strong> — target ${Math.round(
                m.model_mix_target[t] * 100,
              )}%<br><span class="f6 color-fg-muted">${escapeHtml((rule?.patterns ?? []).join(', '))}</span></li>`;
            }).join('')}
            <li><span class="swatch" style="background:${TIER_COLORS.unclassified}"></span><strong>Unclassified</strong> — models matching no pattern (ignored in the score).</li>
          </ul>
        </div>
      </div>
    </div>

    <div class="Box mt-3">
      <div class="Box-header"><h3 class="Box-title">Maturity levels</h3></div>
      <div class="Box-body p-0 table-wrap">
        <p class="px-3 pt-3">Maturity uses <strong>fixed thresholds</strong> (not relative to the org average). A team or person reaches a level when it meets all minimums of that level and every level below it.</p>
        <table class="levels-table">
          <thead><tr><th scope="col">Level</th><th scope="col">Description</th>${reqKeys.map((k) => `<th scope="col" class="num">${METRIC_META[k].short}</th>`).join('')}</tr></thead>
          <tbody>
            ${levels
              .map(
                (l) => `<tr>
                <th scope="row"><span class="Label level__badge--l${l.level}">L${l.level}</span> ${escapeHtml(l.name)}</th>
                <td>${escapeHtml(l.description)}</td>
                ${reqKeys.map((k) => `<td class="num">${l.min[k] != null ? '≥ ' + formatMetric(k, l.min[k]!) : '–'}</td>`).join('')}
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>

    <details class="Box mt-3 data-notes">
      <summary class="Box-header"><h3 class="Box-title d-inline">Data sources &amp; caveats</h3></summary>
      <div class="Box-body">
        <ul>
          <li>Data comes from the GitHub Copilot usage metrics API (daily user and user-team reports) for ${scopeText}, collected daily by a GitHub Actions workflow and stored in the repository. Because GitHub only keeps a rolling 28-day window, each day is stored individually so complete calendar months can be reconstructed.</li>
          <li><strong>Tokens</strong> are taken from token counts reported by GitHub where available. Otherwise they are estimated from AI credits (1 credit = $${m.pricing.usd_per_credit}) using list prices per tier
            (${(['frontier', 'standard', 'lightweight'] as const).map((t) => `${t} $${m.pricing.estimate_usd_per_million_tokens[t]}/M`).join(', ')}). The token source of every team and person is shown.</li>
          <li><strong>Teams with fewer than 5 Copilot seats</strong> are not reported by GitHub; their members appear under “Not in a reported team” (toggle <em>Show unassigned</em>).</li>
          <li>A month marked <em>partial</em> is still in progress or has missing days; active-day ratios are computed against the working days collected so far.</li>
          ${m.pseudonymized ? '<li>Developer names are <strong>pseudonymized</strong> with a keyed hash; the same person keeps the same alias across months.</li>' : ''}
        </ul>
      </div>
    </details>`;
}
