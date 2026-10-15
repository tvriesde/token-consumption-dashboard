import type { MetricKey, Weights } from '../shared/types';
import { METRIC_KEYS } from '../shared/types';

export type ColorBy = 'composite' | MetricKey;

export interface State {
  target: string;
  month: string;
  team: string | null;
  color: ColorBy;
  weights: Weights;
  unassigned: boolean;
}

type Listener = (s: State, prev: State) => void;

const WEIGHTS_KEY = 'cmd.weights';

export function parseWeights(text: string | null | undefined): Weights | null {
  if (!text) return null;
  const parts = text.split(',').map(Number);
  if (parts.length !== METRIC_KEYS.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.every((n) => n === 0)) return null;
  return Object.fromEntries(METRIC_KEYS.map((k, i) => [k, parts[i]])) as Weights;
}

export const formatWeights = (w: Weights) => METRIC_KEYS.map((k) => Math.round(w[k])).join(',');

export function readHash(): Partial<State> {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const out: Partial<State> = {};
  if (p.get('t')) out.target = p.get('t')!;
  if (p.get('m')) out.month = p.get('m')!;
  if (p.get('team')) out.team = p.get('team')!;
  const c = p.get('c');
  if (c && (c === 'composite' || (METRIC_KEYS as string[]).includes(c))) out.color = c as ColorBy;
  const w = parseWeights(p.get('w'));
  if (w) out.weights = w;
  if (p.get('u') === '1') out.unassigned = true;
  return out;
}

export function storedWeights(): Weights | null {
  try {
    return parseWeights(localStorage.getItem(WEIGHTS_KEY));
  } catch {
    return null;
  }
}

export function createStore(initial: State) {
  let state = initial;
  const listeners: Listener[] = [];
  const writeHash = () => {
    const p = new URLSearchParams();
    p.set('t', state.target);
    if (state.month) p.set('m', state.month);
    if (state.team) p.set('team', state.team);
    if (state.color !== 'composite') p.set('c', state.color);
    p.set('w', formatWeights(state.weights));
    if (state.unassigned) p.set('u', '1');
    const next = '#' + p.toString();
    if (location.hash !== next) history.replaceState(null, '', next);
  };
  return {
    get: () => state,
    set(patch: Partial<State>) {
      const prev = state;
      state = { ...state, ...patch };
      if (patch.weights) {
        try {
          localStorage.setItem(WEIGHTS_KEY, formatWeights(state.weights));
        } catch {
          /* private mode */
        }
      }
      writeHash();
      for (const l of listeners) l(state, prev);
    },
    subscribe(l: Listener) {
      listeners.push(l);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
