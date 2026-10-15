import '@primer/css/dist/primer.css';
import './styles.css';
import { formatMonth } from '../shared/format';
import { METRIC_META } from '../shared/metrics-meta';
import type { HistoryFile, Manifest, MonthFile, TargetIndex, TeamMonth } from '../shared/types';
import { METRIC_KEYS } from '../shared/types';
import { loadHistory, loadIndex, loadManifest, loadMonth } from './data';
import { renderMethodology } from './methodology';
import { labelFor, levelName, renderPane } from './pane';
import { renderPeople } from './people-table';
import { baselines, scoreOf } from './scores';
import { createStore, readHash, type State, storedWeights } from './state';
import { escapeHtml, renderLegend, renderTreemap } from './treemap';
import { setupWeights } from './weights';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Loaded {
  index: TargetIndex;
  month: MonthFile;
  history: HistoryFile;
}

function banner(kind: 'warn' | 'error' | 'info', html: string) {
  const cls = kind === 'warn' ? 'flash-warn' : kind === 'error' ? 'flash-error' : '';
  return `<div class="flash ${cls} mb-2">${html}</div>`;
}

function applyBranding(m: Manifest) {
  const b = m.branding;
  document.title = b.title;
  $('brand-title').textContent = b.title;
  $('brand-subtitle').textContent = b.subtitle ?? '';
  if (b.logo) {
    const img = document.createElement('img');
    img.src = /^(https?:|data:)/.test(b.logo) ? b.logo : `./${b.logo}`;
    img.alt = '';
    $('brand-logo').replaceChildren(img);
  }
  $('footer-text').textContent = b.footer ?? '';
  $('generated-at').textContent = `Data generated ${new Date(m.generated_at).toLocaleString()}`;
}

async function main() {
  let manifest: Manifest;
  try {
    manifest = await loadManifest();
  } catch (e) {
    $('banners').innerHTML = banner(
      'error',
      `<strong>No dashboard data found.</strong> Run the <em>Collect Copilot usage</em> and <em>Build dashboard</em> workflows (or <code>npm run testdata</code> locally). <span class="color-fg-muted">${escapeHtml(String(e))}</span>`,
    );
    return;
  }
  applyBranding(manifest);
  if (!manifest.targets.length) {
    $('banners').innerHTML = banner('error', 'The configuration has no targets.');
    return;
  }

  const hash = readHash();
  const target = manifest.targets.some((t) => t.slug === hash.target) ? hash.target! : manifest.targets[0].slug;
  const store = createStore({
    target,
    month: hash.month ?? '',
    team: hash.team ?? null,
    color: hash.color ?? 'composite',
    weights: hash.weights ?? storedWeights() ?? { ...manifest.weights },
    unassigned: hash.unassigned ?? false,
  });

  // Target switcher (only when there is more than one org).
  const targetSelect = $<HTMLSelectElement>('target-select');
  $('target-label').textContent = manifest.scope === 'enterprise' ? 'Enterprise' : 'Organization';
  targetSelect.innerHTML = manifest.targets.map((t) => `<option value="${escapeHtml(t.slug)}">${escapeHtml(t.label)}</option>`).join('');
  $('target-control').hidden = manifest.targets.length < 2;
  targetSelect.addEventListener('change', () => store.set({ target: targetSelect.value, month: '', team: null }));

  const colorSelect = $<HTMLSelectElement>('color-select');
  colorSelect.innerHTML =
    `<option value="composite">Overall score</option>` + METRIC_KEYS.map((k) => `<option value="${k}">${METRIC_META[k].label}</option>`).join('');
  colorSelect.addEventListener('change', () => store.set({ color: colorSelect.value as State['color'] }));

  const monthSelect = $<HTMLSelectElement>('month-select');
  monthSelect.addEventListener('change', () => store.set({ month: monthSelect.value }));

  const unassigned = $<HTMLInputElement>('unassigned-toggle');
  unassigned.addEventListener('change', () => store.set({ unassigned: unassigned.checked }));

  const weights = setupWeights({
    button: $<HTMLButtonElement>('weights-button'),
    popover: $('weights-popover'),
    summary: $('weights-summary'),
    defaults: manifest.weights,
    get: () => store.get().weights,
    onChange: (w) => store.set({ weights: w }),
  });

  let loaded: Loaded | null = null;
  let loadSeq = 0;
  let silent = false;

  async function load(s: State): Promise<Loaded | null> {
    const seq = ++loadSeq;
    const index = await loadIndex(s.target);
    if (!index.months.length) {
      $('banners').innerHTML = banner('warn', `No data has been collected for <strong>${escapeHtml(index.label)}</strong> yet.`);
      return null;
    }
    const months = index.months.map((m) => m.month);
    let month = months.includes(s.month) ? s.month : months.at(-1)!;
    // Prefer the latest complete month over a just-started one with only a few days of data.
    if (!s.month && months.length > 1) {
      const latest = index.months.at(-1)!;
      if (!latest.coverage.complete && latest.coverage.days_collected < 7) month = months.at(-2)!;
    }
    const [mf, history] = await Promise.all([loadMonth(s.target, month), loadHistory(s.target)]);
    if (seq !== loadSeq) return null;
    monthSelect.innerHTML = [...index.months]
      .reverse()
      .map((m) => `<option value="${m.month}">${formatMonth(m.month)}${m.coverage.complete ? '' : ' (partial)'}</option>`)
      .join('');
    monthSelect.value = month;
    if (month !== s.month) {
      silent = true;
      store.set({ month });
      silent = false;
    }
    return { index, month: mf, history };
  }

  function render() {
    if (!loaded) return;
    const s = store.get();
    const { month, history, index } = loaded;
    targetSelect.value = s.target;
    colorSelect.value = s.color;
    unassigned.checked = s.unassigned;
    weights.update();

    const teams: TeamMonth[] = [...month.teams];
    if (s.unassigned && month.unassigned && month.unassigned.seats > 0) teams.push(month.unassigned);
    const base = baselines(month.teams, s.weights);
    const scoreFn = (t: TeamMonth) => scoreOf(t.subscores, s.color, s.weights);
    const colorBase = s.color === 'composite' ? base.composite : base.sub[s.color];
    const team = teams.find((t) => t.id === s.team) ?? null;
    if (s.team && !team) {
      store.set({ team: null });
      return;
    }

    const banners: string[] = [];
    const cov = month.coverage;
    if (!cov.complete)
      banners.push(
        banner(
          'warn',
          `<strong>${formatMonth(month.month)} is partial</strong> — ${cov.days_collected} of ${cov.days_expected} days collected${
            cov.last_day ? ` (through ${cov.last_day})` : ''
          }. Scores may still change.`,
        ),
      );
    if (month.org.token_source === 'estimated' || month.org.token_source === 'mixed')
      banners.push(
        banner(
          'info',
          `Token counts are ${month.org.token_source === 'estimated' ? '' : 'partly '}<strong>estimated</strong> from AI credits for usage without reported token counts. See “Data sources &amp; caveats”.`,
        ),
      );
    $('banners').innerHTML = banners.join('');

    const colorLabel = s.color === 'composite' ? 'Overall score' : METRIC_META[s.color].label;
    $('map-title').textContent = `${index.label} · ${formatMonth(month.month)}`;
    renderLegend($('legend'), teams.map(scoreFn), colorBase, colorLabel);
    const onSelect = (id: string | null) => store.set({ team: id });
    renderTreemap($('treemap'), { teams, score: scoreFn, base: colorBase, selected: s.team, levelName: (l) => levelName(manifest, l), onSelect });
    renderPane($('pane'), { manifest, month, teams: month.teams, team, weights: s.weights, base, history, onSelect });
    renderPeople($('people'), {
      manifest,
      team,
      weights: s.weights,
      base,
      workingDays: cov.working_days,
      monthLabel: formatMonth(month.month),
    });
    renderMethodology($('methodology'), manifest, s.weights);
  }

  async function reload() {
    try {
      const r = await load(store.get());
      if (r) {
        loaded = r;
        render();
      }
    } catch (e) {
      $('banners').innerHTML = banner('error', `Could not load data for <strong>${escapeHtml(labelFor(manifest, store.get().target))}</strong>: ${escapeHtml(String(e))}`);
    }
  }

  store.subscribe((s, prev) => {
    if (silent) return;
    if (s.target !== prev.target || (s.month !== prev.month && loaded?.month.month !== s.month)) {
      void reload();
    } else {
      render();
    }
  });
  window.addEventListener('hashchange', () => {
    const h = readHash();
    const patch: Partial<State> = {};
    if (h.target && h.target !== store.get().target && manifest.targets.some((t) => t.slug === h.target)) patch.target = h.target;
    if (h.month && h.month !== store.get().month) patch.month = h.month;
    if ((h.team ?? null) !== store.get().team) patch.team = h.team ?? null;
    if (Object.keys(patch).length) store.set(patch);
  });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', render);
  await reload();
}

void main();
