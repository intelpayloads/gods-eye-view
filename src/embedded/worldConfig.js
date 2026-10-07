/**
 * The World Model block at the top of the embedded layer panel (DWM-189).
 *
 * The world model is not a layer to switch on: every row below it reads it.
 * This block is what the application is connected to -- the head it follows,
 * the revision on it and how old that is, how many products it holds and how
 * many simulation runs sit beside it -- refreshed on a timer. It has no
 * toggle; it is the configuration the rows run on.
 */
import { SIM_HEAD_PREFIX } from '../layers/worldModel/simulationRuns.js';
import { HEAD } from '../layers/worldModel/view.js';

export const WORLD_CONFIG_REFRESH_MS = 15_000;

/** "42 s ago", "3 min ago", "2 h ago". */
export function formatAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'age unknown';
  if (seconds < 60) return `${Math.round(seconds)} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/** The block's lines from one status read (`null` status = unreachable). */
export function worldConfigLines({ status, heads, error, discovery }) {
  if (!status) {
    return {
      state: 'down',
      lines: [
        `backplane unreachable${error ? `: ${error}` : ''}`,
        'connector rows keep their last data',
      ],
    };
  }
  const head = status.head ?? {};
  const runs = Object.keys(heads ?? {}).filter((name) =>
    name.startsWith(SIM_HEAD_PREFIX),
  ).length;
  const bindings = status.bindings?.length ?? 0;
  const runLabel = `${runs} simulation run${runs === 1 ? '' : 's'}`;
  const failed = discovery?.error;
  return {
    state: failed ? 'partial' : 'ok',
    lines: [
      `${head.name ?? HEAD} · rev ${String(head.revision_id ?? '—').slice(0, 8)} · ${formatAge(head.age_seconds)}`,
      failed
        ? `${bindings} products · ${runLabel} · product rows not loaded (${failed}); reload to retry`
        : `${bindings} products · ${discovery?.count ?? 0} drawn as layers · ${runLabel}`,
    ],
  };
}

/**
 * Mount the block before `before` inside its parent. Returns `{ refresh,
 * remove }`: `refresh` re-reads now (the product count is known only once
 * discovery finishes), `remove` stops the timer and takes the block out.
 * @param {object} options
 * @param {HTMLElement} options.before The layer list the block heads.
 * @param {object} options.source The host's ProjectionSource.
 * @param {() => {count: number, error: string|null}} options.discovery
 *   Product layers registered, or why discovery failed.
 */
export function mountWorldConfig({
  before,
  source,
  discovery = () => ({ count: 0, error: null }),
  head = HEAD,
  refreshMs = WORLD_CONFIG_REFRESH_MS,
}) {
  const document = before.ownerDocument;
  const block = document.createElement('div');
  block.className = 'world-config';
  block.dataset.state = 'pending';
  const title = document.createElement('div');
  title.className = 'world-config-title';
  const dot = document.createElement('span');
  dot.className = 'world-config-dot';
  const name = document.createElement('span');
  name.textContent = 'World Model';
  title.append(dot, name);
  const body = document.createElement('div');
  block.append(title, body);
  before.parentNode.insertBefore(block, before);

  const controller = new AbortController();
  const render = ({ state, lines }) => {
    block.dataset.state = state;
    body.replaceChildren(
      ...lines.map((text) => {
        const line = document.createElement('div');
        line.className = 'world-config-line';
        line.textContent = text;
        line.title = text;
        return line;
      }),
    );
  };
  const refresh = async () => {
    try {
      const [status, heads] = await Promise.all([
        source.getStatus({ head, signal: controller.signal }),
        typeof source.getHeads === 'function'
          ? source.getHeads({ signal: controller.signal })
          : {},
      ]);
      if (!controller.signal.aborted)
        render(worldConfigLines({ status, heads, discovery: discovery() }));
    } catch (error) {
      if (!controller.signal.aborted)
        render(
          worldConfigLines({
            status: null,
            error: error?.message || String(error),
          }),
        );
    }
  };
  render({ state: 'pending', lines: ['connecting…'] });
  void refresh();
  const timer = setInterval(refresh, refreshMs);
  return {
    refresh,
    remove() {
      controller.abort();
      clearInterval(timer);
      block.remove();
    },
  };
}
