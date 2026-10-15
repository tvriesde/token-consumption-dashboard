import { METRIC_META } from '../shared/metrics-meta';
import type { Weights } from '../shared/types';
import { METRIC_KEYS } from '../shared/types';

export function weightsSummary(w: Weights, defaults: Weights): string {
  const same = METRIC_KEYS.every((k) => Math.round(w[k]) === Math.round(defaults[k]));
  if (same) return METRIC_KEYS.every((k) => defaults[k] === defaults[METRIC_KEYS[0]]) ? 'Equal' : 'Default';
  const sum = METRIC_KEYS.reduce((s, k) => s + w[k], 0) || 1;
  return METRIC_KEYS.map((k) => Math.round((w[k] / sum) * 100)).join(' / ');
}

export function setupWeights(opts: {
  button: HTMLButtonElement;
  popover: HTMLElement;
  summary: HTMLElement;
  defaults: Weights;
  get: () => Weights;
  onChange: (w: Weights) => void;
}) {
  const { button, popover, summary, defaults, get, onChange } = opts;

  const render = () => {
    const w = get();
    const sum = METRIC_KEYS.reduce((s, k) => s + w[k], 0) || 1;
    popover.innerHTML = `
      <div class="Box-header py-2"><strong>Metric weights</strong></div>
      <div class="Box-body">
        ${METRIC_KEYS.map(
          (k) => `
          <label class="weight">
            <span class="weight__label">${METRIC_META[k].label}</span>
            <input type="range" min="0" max="100" step="5" value="${Math.round(w[k])}" data-key="${k}" aria-describedby="wv-${k}" />
            <output id="wv-${k}" class="weight__value">${Math.round((w[k] / sum) * 100)}%</output>
          </label>`,
        ).join('')}
        <p class="note">Shares are normalized; all four at 0 is not allowed.</p>
      </div>
      <div class="Box-footer py-2 d-flex flex-justify-between">
        <button type="button" class="btn btn-sm" data-action="reset">Reset</button>
        <button type="button" class="btn btn-sm btn-primary" data-action="close">Done</button>
      </div>`;
    popover.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((input) =>
      input.addEventListener('input', () => {
        const next = { ...get(), [input.dataset.key!]: Number(input.value) } as Weights;
        if (METRIC_KEYS.every((k) => next[k] === 0)) {
          input.value = '5';
          next[input.dataset.key as keyof Weights] = 5;
        }
        onChange(next);
        const s = METRIC_KEYS.reduce((a, k) => a + next[k], 0) || 1;
        for (const k of METRIC_KEYS) popover.querySelector(`#wv-${k}`)!.textContent = `${Math.round((next[k] / s) * 100)}%`;
      }),
    );
    popover.querySelector('[data-action=reset]')!.addEventListener('click', () => {
      onChange({ ...defaults });
      render();
    });
    popover.querySelector('[data-action=close]')!.addEventListener('click', () => toggle(false));
  };

  const toggle = (open: boolean) => {
    popover.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      render();
      popover.querySelector<HTMLInputElement>('input')?.focus();
    }
  };

  button.addEventListener('click', () => toggle(Boolean(popover.hidden)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) {
      toggle(false);
      button.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!popover.hidden && !popover.contains(e.target as Node) && !button.contains(e.target as Node)) toggle(false);
  });

  const update = () => (summary.textContent = weightsSummary(get(), defaults));
  update();
  return { update };
}
