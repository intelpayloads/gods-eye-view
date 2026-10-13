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
 * The block's refresh, without the DOM. `/status` can take minutes on a busy
 * backplane (DWM-221), so it is never what the block waits on to say what it
 * is connected to, and never re-asked while a read is out:
 *  - `GET /heads` (cheap) every refresh: the head and its revision show at
 *    once, and a moved head is how a new status read is decided;
 *  - one `GET /status` at a time, again only once the head has moved; in
 *    between, the last answer is shown with its age carried forward.
 * A source without `getHeads` re-reads status each refresh, one at a time.
 * Returns `refresh()`: a promise of this refresh's lines landing.
 */
export function createWorldConfigRefresh({
  source,
  head = HEAD,
  discovery = () => ({ count: 0, error: null }),
  render,
  signal,
  now = () => Date.now(),
}) {
  let last = null; // { status, heads, readAt }
  let reading = null;
  const show = (heads) => {
    const status = last.status;
    const age = status.head?.age_seconds;
    render(
      worldConfigLines({
        status: {
          ...status,
          head: {
            ...status.head,
            age_seconds: Number.isFinite(age)
              ? age + (now() - last.readAt) / 1000
              : age,
          },
        },
        heads: heads ?? last.heads,
        discovery: discovery(),
      }),
    );
  };
  const down = (error) =>
    render(
      worldConfigLines({
        status: null,
        error: error?.message || String(error),
      }),
    );
  const readStatus = (heads) => {
    reading ??= source
      .getStatus({ head, signal })
      .then(
        (status) => {
          last = { status, heads, readAt: now() };
          if (!signal?.aborted) show(heads);
        },
        (error) => {
          if (!signal?.aborted && !last) down(error);
        },
      )
      .finally(() => {
        reading = null;
      });
    return reading;
  };
  return async () => {
    if (typeof source.getHeads !== 'function') return readStatus({});
    let heads;
    try {
      heads = await source.getHeads({ signal });
    } catch (error) {
      if (!signal?.aborted) down(error);
      return;
    }
    if (signal?.aborted) return;
    const revisionId = heads?.[head];
    const moved = !last || last.status?.head?.revision_id !== revisionId;
    if (last) show(heads);
    else
      render({
        state: 'pending',
        lines: [
          `${head} · rev ${String(revisionId ?? '—').slice(0, 8)}`,
          'reading world facts…',
        ],
      });
    if (moved) return readStatus(heads);
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
  const refresh = createWorldConfigRefresh({
    source,
    head,
    discovery,
    render,
    signal: controller.signal,
  });
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
