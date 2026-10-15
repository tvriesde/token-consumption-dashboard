import type { HistoryFile, Manifest, MonthFile, TargetIndex } from '../shared/types';

const cache = new Map<string, Promise<unknown>>();
const embeddedJson = document.getElementById('dashboard-data')?.textContent;
const embeddedData = embeddedJson ? (JSON.parse(embeddedJson) as Record<string, unknown>) : null;

async function getJson<T>(path: string): Promise<T> {
  let p = cache.get(path) as Promise<T> | undefined;
  if (!p) {
    if (embeddedData) {
      if (!Object.hasOwn(embeddedData, path)) throw new Error(`Embedded dashboard data is missing ${path}`);
      p = Promise.resolve(embeddedData[path] as T);
    } else {
      p = fetch(`./data/${path}`, { cache: 'no-cache' }).then(async (r) => {
        if (!r.ok) throw new Error(`Could not load data/${path} (HTTP ${r.status})`);
        return (await r.json()) as T;
      });
    }
    cache.set(path, p);
    p.catch(() => cache.delete(path));
  }
  return p;
}

export const loadManifest = () => getJson<Manifest>('manifest.json');
export const loadIndex = (target: string) => getJson<TargetIndex>(`${encodeURIComponent(target)}/index.json`);
export const loadMonth = (target: string, month: string) => getJson<MonthFile>(`${encodeURIComponent(target)}/${month}.json`);
export const loadHistory = (target: string) => getJson<HistoryFile>(`${encodeURIComponent(target)}/history.json`);
