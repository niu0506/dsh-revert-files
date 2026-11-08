/**
 * 客户端侧的检查，用 `node test/client.test.mjs` 运行。
 *
 * 浏览器侧依赖它并不拥有的随包标记——消息行上带哈希后缀的 `_actions`
 * 操作条、`data-chat-turn` 行属性，以及
 * `data-conversation-session` Conversation 根节点。一个最小的
 * DOM 与 React 桩代替随包的 Chat，好让这些假设在这里
 * 大声失败，而不是在浏览器里悄无声息地失败：
 *
 * - 撤回控件经 portal/传送门进入该行的操作条，紧挨着
 *   复制控件；没有操作条时则回退到气泡上方的座位；
 * - 一次点击会向 Host 请求一份计划并打开确认卡片，且只有
 *   卡片的确认控件才会执行撤回；
 * - 已回滚的轮次只会在该会话的 Conversation 内被隐藏，
 *   前提是其日志携带 Host 的回滚检查点。
 */
import fs from 'node:fs';

// --- 最小 DOM -----------------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.className = '';
    this.attributes = {};
    this.textContent = '';
    this.style = {};
  }
  appendChild(node) {
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  remove() {
    if (this.parentElement === null) return;
    const list = this.parentElement.children;
    list.splice(list.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  closest(selector) {
    const name = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
    let node = this;
    while (node !== null) {
      if (name !== undefined && node.hasAttribute(name)) return node;
      node = node.parentElement;
    }
    return null;
  }
  querySelector(selector) {
    const name = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
    const walk = (node) => {
      for (const child of node.children) {
        if (name !== undefined && child.hasAttribute(name)) return child;
        const found = walk(child);
        if (found !== null) return found;
      }
      return null;
    };
    return walk(this);
  }
}

const created = [];
const observerCallbacks = [];
const roots = [];
const document = {
  head: { appendChild: (node) => created.push(node) },
  querySelector: (selector) => {
    const match = /data-plugin-css="([^"]+)"/.exec(selector);
    if (match === null) return null;
    return created.find((node) => node.dataset.pluginCss === match[1]) ?? null;
  },
  createElement: (tag) => {
    const element = new El(tag);
    element.ownerDocument = document;
    return element;
  },
  querySelectorAll: () => roots,
  body: new El('body'),
};

// --- 最小 React ---------------------------------------------------------
const Fragment = Symbol('fragment');
const frames = new Map();
const pendingEffects = [];
let current = null;
let tree = null;
let scheduled = false;
const container = new El('div');
container.setAttribute('data-chat-flow-kind', 'user');

const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } });
/** 最近一次渲染过程创建的元素，用于按过程断言。 */
let passNodes = [];

function renderChild(child, parent) {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const item of child) renderChild(item, parent);
    return;
  }
  if (typeof child === 'string' || typeof child === 'number') {
    parent.textContent += String(child);
    return;
  }
  if (child.portal !== undefined) {
    renderChild(child.portal, child.container);
    return;
  }
  const { type, props } = child;
  if (typeof type === 'function') {
    const owner = current;
    const frame = frames.get(type) ?? { hooks: [], index: 0 };
    frame.index = 0;
    frames.set(type, frame);
    current = frame;
    const out = type(props);
    current = owner;
    renderChild(out, parent);
    return;
  }
  if (type === Fragment) {
    renderChild(props.children, parent);
    return;
  }
  const node = document.createElement(type);
  node.__props = props;
  passNodes.push(node);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'children' || key === 'ref') continue;
    if (key === 'className') node.className = value;
    else if (typeof value === 'string') node.setAttribute(key, value);
  }
  parent.appendChild(node);
  if (props?.ref !== undefined && props?.ref !== null) props.ref.current = node;
  renderChild(props?.children, node);
}

const schedule = () => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    mount();
  });
};
const mount = () => {
  passNodes = [];
  current = null;
  renderChild(tree, container);
  const effects = pendingEffects.splice(0, pendingEffects.length);
  for (const effect of effects) effect();
};

const React = {
  createElement,
  Fragment,
  memo: (component) => component,
  useRef: (initial) => {
    const frame = current;
    const index = frame.index++;
    frame.hooks[index] ??= { current: initial };
    return frame.hooks[index];
  },
  useState: (initial) => {
    const frame = current;
    const index = frame.index++;
    if (!(index in frame.hooks)) frame.hooks[index] = typeof initial === 'function' ? initial() : initial;
    const set = (value) => {
      const next = typeof value === 'function' ? value(frame.hooks[index]) : value;
      if (next === frame.hooks[index]) return;
      frame.hooks[index] = next;
      schedule();
    };
    return [frame.hooks[index], set];
  },
  useCallback: (callback) => {
    current.index += 1;
    return callback;
  },
  useEffect: (effect, deps) => {
    const frame = current;
    const index = frame.index++;
    const previous = frame.hooks[index];
    const changed = previous === undefined || deps === undefined || deps.some((dep, at) => dep !== previous.deps[at]);
    frame.hooks[index] = { deps: deps ?? [] };
    if (changed) pendingEffects.push(effect);
  },
  useLayoutEffect: (effect, deps) => {
    const frame = current;
    const index = frame.index++;
    const previous = frame.hooks[index];
    const changed = previous === undefined || deps === undefined || deps.some((dep, at) => dep !== previous.deps[at]);
    frame.hooks[index] = { deps: deps ?? [] };
    if (changed) pendingEffects.push(effect);
  },
};

const portals = [];
const reactDom = {
  createPortal: (node, target) => {
    portals.push({ node, target });
    return { portal: node, container: target };
  },
};

// --- 加载客户端侧 --------------------------------------------------
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
let plugin;
new Function('window', 'document', 'MutationObserver', 'Element', source)(
  {
    __ModuleLoader__: {
      load: ({ factory }) =>
        (plugin = factory((id) => {
          if (id === 'react') return React;
          if (id === 'react-dom') return reactDom;
          throw new Error(`unexpected require: ${id}`);
        })),
    },
  },
  document,
  class {
    constructor(callback) {
      observerCallbacks.push(callback);
    }
    observe() {}
    disconnect() {}
  },
  El,
);

const sessionId = 'session-1';
const entries = [];
const journalListeners = new Set();
let boundSession;
/**
 * 真实的客户端会话形状：`eventSource` 是随包 Chat（因而也是本插件）
 * 订阅并读取的快照 store，而
 * `events` 只是会重连的远程日志流，它既不暴露
 * `getSnapshot` 也不暴露 `subscribe`。下面的诱饵有意保持无 store：
 * 一旦回退成读取 `events`，就会得到空窗口并
 * 在这里失败，而不是在浏览器里悄无声息地什么都不隐藏。
 */
const remoteJournalStream = { open: () => {}, restart: () => {}, dispose: () => {} };
const eventSource = () => ({
  getSnapshot: () => ({ entries }),
  subscribe: (listener) => {
    journalListeners.add(listener);
    return () => journalListeners.delete(listener);
  },
});
const fakeSession = { eventSource: eventSource(), events: remoteJournalStream };
const commands = [];
let lifecycleSeq = 0;
const commandSession = {
  eventSource: eventSource(),
  events: remoteJournalStream,
  command: (line) => {
    commands.push(line);
    // Host 会在该调用落定之前持久记录两行生命周期日志。
    const commandId = `cmd-${commands.length}`;
    entries.push({
      event: {
        type: 'command/run',
        seq: (lifecycleSeq += 1),
        data: { commandId, name: 'revert', args: line.replace(/^\/revert\s*/, '') },
      },
    });
    entries.push({
      event: {
        type: 'command/done',
        seq: (lifecycleSeq += 1),
        data: {
          commandId,
          kind: 'success',
          text: line.includes('--plan') ? 'PLAN: revert this turn?' : 'RESTORED turn 4',
        },
      },
    });
    publish();
    return Promise.resolve({ ok: true, value: { matched: true } });
  },
};
const remount = () => {
  for (const callback of observerCallbacks) callback([{ type: 'childList', addedNodes: [new El('div')] }]);
};
const publish = () => {
  for (const listener of journalListeners) listener();
};

let turnComponent;
let overlayComponent;
let menuRegistration;
/** Client 为某条 Host 命令自己的 Chat 行所注册的条目。 */
let commandRowEntry;
/** 删除流程可能选作命令承载的那些会话，以及它们的行。 */
const carrierId = 'session-2';
let carrierSession;
let snapshotIds = [sessionId, carrierId];
let refreshes = 0;
/** Client 依次请求绑定的每一个会话 id。 */
const askedFor = [];
plugin.apply({
  sessions: {
    binding: (id) => {
      askedFor.push(id);
      if (id === sessionId && boundSession !== undefined) return { session: boundSession };
      if (id === carrierId && carrierSession !== undefined) return { session: carrierSession };
      return undefined;
    },
    list: {
      getSnapshot: () => ({ ids: snapshotIds, byId: { [carrierId]: { retainedBy: { mainView: 1 } } } }),
    },
    refresh: () => {
      refreshes += 1;
      return Promise.resolve();
    },
  },
  effect: (run) => run(),
  locale: { register: () => () => {}, bind: () => (key) => key },
  contextMenus: {
    register: (input) => {
      menuRegistration = input;
      return () => {};
    },
  },
  slots: {
    inject: (_name, run) => run(),
    register: (seat, component) => {
      if (seat.name === 'conversation.chat.user.before') turnComponent = component;
      if (seat.name === 'shell.overlay') overlayComponent = component;
      if (seat.name === 'conversation.chat.commandview') commandRowEntry = { seat, component };
      return () => {};
    },
  },
});

// --- 一个随包形状的用户行 -------------------------------------------
const chat = {
  nodes: {
    values: () => [{ kind: 'user', data: { source: { rpcId: 'r1' } }, location: { kind: 'turn', turn: { turn: 4 } } }],
  },
};
const rowProps = {
  kind: 'user',
  source: { rpcId: 'r1' },
  sessionId: 'session-1',
  useChat: (select) => select(chat),
  t: (key) => key,
};
const Row = () =>
  createElement(
    'div',
    { className: 'AkCqbG_userRow' },
    createElement(turnComponent, rowProps),
    createElement('div', { className: 'ZITbJG_actions AkCqbG_actions' }, createElement('button')),
  );

tree = createElement(Row);
mount();
await new Promise((resolve) => setTimeout(resolve, 0));

const row = container.children[0];
const strip = row.children.find((child) => String(child.className).includes('_actions'));
const seat = strip === undefined ? null : strip.querySelector('[data-revert-files-seat]');
const results = [];
const check = (label, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`);

check('the action strip is found from the seat', strip !== undefined);
check('the seat lands in the action strip', seat !== null);
check('the seat follows the copy control', seat !== null && strip.children.indexOf(seat) === strip.children.length - 1);
check('the last pass renders no fallback', passNodes.every((node) => node.className !== 'dshrvturn'));
check('the hidden seat takes no layout', row.children.some((child) => child.className === 'dshrvanchor'));

const portal = portals.find((entry) => entry.target === seat);
check('the control is portalled into the seat', portal !== undefined);
check('the portalled control is a revert button', portal?.node?.type === 'button');
check('the control is labelled for the row it belongs to', portal?.node?.props?.title === 'action.title');

boundSession = commandSession;
portal?.node?.props?.onClick?.();
await new Promise((resolve) => setTimeout(resolve, 0));
check('clicking asks for a plan instead of executing', commands.length === 1 && commands[0] === '/revert --turn 4 --plan', JSON.stringify(commands));

const card = document.body.querySelector('[role="dialog"]') ?? document.body.children.find((child) => child.className === 'dshrvoverlay')?.children.find((child) => child.className === 'dshrvcard');
check('the confirmation card opens', card !== undefined && card !== null);
const cardText = card === undefined || card === null ? '' : card.children.map((child) => child.textContent).join('|');
check('the card shows the Host plan', cardText.includes('PLAN: revert this turn?'), cardText);
const findClass = (node, className) => {
  if (String(node.className).includes(className)) return node;
  for (const child of node.children) {
    const found = findClass(child, className);
    if (found !== null) return found;
  }
  return null;
};
const confirmButton = card === undefined || card === null ? null : findClass(card, 'dshrvprimary');
check('the card offers a confirm control', confirmButton !== null);

confirmButton?.__props?.onClick?.();
await new Promise((resolve) => setTimeout(resolve, 0));
check('confirming executes the revert', commands[1] === '/revert --turn 4', JSON.stringify(commands));
check('the card closes after confirming', passNodes.every((node) => node.className !== 'dshrvoverlay'));

// 取消后撤回不会被执行。
const sent = commands.length;
container.children.length = 0;
frames.clear();
tree = createElement(Row);
mount();
await new Promise((resolve) => setTimeout(resolve, 0));
const again = container.children[0].children.find((child) => String(child.className).includes('_actions'));
again?.querySelector('[data-revert-files-seat]')?.children.find((child) => child.tagName === 'BUTTON')?.__props?.onClick?.();
await new Promise((resolve) => setTimeout(resolve, 0));
const cancelButton = document.body.children.at(-1)?.children[0]?.children.at(-1)?.children.find((child) => String(child.className) === 'dshrvbtn');
cancelButton?.__props?.onClick?.();
await new Promise((resolve) => setTimeout(resolve, 0));
check('cancelling sends nothing further', commands.length === sent + 1, JSON.stringify(commands));
check('cancelling closes the card', passNodes.every((node) => node.className !== 'dshrvoverlay'));

// 缺少操作条的行保留气泡上方的回退座位。
const plain = new El('div');
plain.setAttribute('data-chat-flow-kind', 'user');
const PlainRow = () => createElement('div', { className: 'AkCqbG_userRow' }, createElement(turnComponent, rowProps));
tree = createElement(PlainRow);
container.children.length = 0;
frames.clear();
mount();
await new Promise((resolve) => setTimeout(resolve, 0));
const plainRow = container.children[0];
check('a row without a strip keeps the fallback', plainRow.children.some((child) => child.className === 'dshrvturn'));

// --- 已回滚的轮次从转录中消失 ------------------------
const rules = () => {
  const tag = created.find((node) => node.dataset.pluginCss?.endsWith('/rolled-back-turns.css'));
  return tag === undefined ? '' : tag.textContent;
};
/** Host 检查点的形状：一次空的 `user/message` surface 替换。 */
const rollback = (from, to, kind = 'revert-files') => ({
  event: {
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 7, endSeq: 9 },
    data: { id: `${kind}-${from}`, role: 'user', content: [], source: { kind, from, to } },
  },
});
/** 旧版 Host 构建写成空 developer 消息的检查点。 */
const legacyRollback = (from, to, kind = 'revert-files') => ({
  event: {
    type: 'developer/message',
    surfaceOp: { op: 'replace', startSeq: 7, endSeq: 9 },
    data: { message: { id: `${kind}-${from}`, role: 'developer', content: [], source: { kind, from, to } } },
  },
});

roots.push({ getAttribute: () => sessionId });
boundSession = fakeSession;
remount();
check('no rules before any rollback survives', rules() === '', JSON.stringify(rules()));
check(
  'the journal is read from eventSource, not the remote stream',
  remoteJournalStream.getSnapshot === undefined && fakeSession.eventSource.getSnapshot().entries === entries,
);

entries.push(rollback(2, 2));
publish();
check('hides a rolled-back turn', rules().includes(`[data-conversation-session="${sessionId}"] [data-chat-turn="2"]`), rules());

entries.push({
  event: {
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 },
    data: { id: 'summary', role: 'user', content: [], source: { kind: 'compact-checkpoint' } },
  },
});
publish();
check('ignores another plugin\'s replacement checkpoint', !rules().includes('data-chat-turn="3"'), rules());

entries.push(rollback(4, 5));
publish();
check(
  'accumulates later rollbacks',
  ['2', '4', '5'].every((turn) => rules().includes(`data-chat-turn="${turn}"`)),
  rules(),
);
check(
  'rules stay scoped to their Session',
  rules().split('\n').every((line) => line.startsWith(`[data-conversation-session="${sessionId}"]`)),
  rules(),
);

entries.push(legacyRollback(6, 6));
publish();
check('still honors an older developer/message checkpoint', rules().includes('data-chat-turn="6"'), rules());

roots.pop();
remount();
check('rules clear once the Conversation unmounts', rules() === '', rules());

// --- 被 Host 拒绝的预览不提供任何可确认的内容 -------------------
// 一份回答为 `kind: 'error'` 的计划——该轮次没有快照、报告无法
// 定位某个文件——意味着同样的点击只会再次失败，而且
// 撤回不可撤销。卡片会展示 Host 自己的报告并去掉
// 那个破坏性控件，与删除卡片完全一致。
const refusedPlanSession = {
  eventSource: fakeSession.eventSource,
  events: remoteJournalStream,
  command: (line) => {
    commands.push(line);
    const commandId = `refused-${commands.length}`;
    entries.push({
      event: {
        type: 'command/run',
        seq: (lifecycleSeq += 1),
        data: { commandId, name: 'revert', args: line.replace(/^\/revert\s*/, '') },
      },
    });
    entries.push({
      event: {
        type: 'command/done',
        seq: (lifecycleSeq += 1),
        data: { commandId, kind: 'error', text: 'NO SNAPSHOT' },
      },
    });
    publish();
    return Promise.resolve({ ok: true, value: { matched: true } });
  },
};
boundSession = refusedPlanSession;
container.children.length = 0;
frames.clear();
tree = createElement(Row);
mount();
await new Promise((resolve) => setTimeout(resolve, 0));
const beforeRefused = commands.length;
portals.at(-1)?.node?.props?.onClick?.();
await new Promise((resolve) => setTimeout(resolve, 0));
const refusedSent = commands.length;
const refusedPlanCard = passNodes.find((node) => node.className === 'dshrvcard');
const refusedPlanText =
  refusedPlanCard === undefined ? '' : refusedPlanCard.children.map((child) => child.textContent).join('|');
check('a refused preview shows the Host report', refusedPlanText.includes('NO SNAPSHOT'), refusedPlanText);
check(
  'a refused preview offers no confirm control',
  passNodes.every((node) => !String(node.className).includes('dshrvprimary')),
  JSON.stringify(passNodes.map((node) => node.className)),
);
check(
  'a refused preview sends the plan and nothing else',
  refusedSent === beforeRefused + 1 && commands.at(-1) === '/revert --turn 4 --plan',
  JSON.stringify(commands.slice(beforeRefused)),
);
findClass(refusedPlanCard ?? new El('div'), 'dshrvbtn')?.__props?.onClick?.();
await new Promise((resolve) => setTimeout(resolve, 0));
check('closing a refused preview sends nothing', commands.length === refusedSent, JSON.stringify(commands));

// --- 被拒绝的执行绝不能读作成功 ------------------------------
// `session.command` 只报告是否被接纳，因此结果必须来自
// Host 的 `command/done` 行；否则一次拒绝会被标记为 "reverted"。
const failedExecuteSession = {
  eventSource: fakeSession.eventSource,
  events: remoteJournalStream,
  command: (line) => {
    commands.push(line);
    const commandId = `failed-${commands.length}`;
    const plan = line.includes('--plan');
    entries.push({
      event: {
        type: 'command/run',
        seq: (lifecycleSeq += 1),
        data: { commandId, name: 'revert', args: line.replace(/^\/revert\s*/, '') },
      },
    });
    entries.push({
      event: {
        type: 'command/done',
        seq: (lifecycleSeq += 1),
        data: plan ? { commandId, kind: 'success', text: 'PLAN: revert this turn?' } : { commandId, kind: 'error', text: 'REVERT REFUSED' },
      },
    });
    publish();
    return Promise.resolve({ ok: true, value: { matched: true } });
  },
};
boundSession = failedExecuteSession;
container.children.length = 0;
frames.clear();
tree = createElement(Row);
mount();
await new Promise((resolve) => setTimeout(resolve, 0));
portals.at(-1)?.node?.props?.onClick?.();
await new Promise((resolve) => setTimeout(resolve, 0));
const failedConfirm = passNodes.find((node) => String(node.className).includes('dshrvprimary'));
check('a readable plan still offers a confirm control', failedConfirm !== undefined);
failedConfirm?.__props?.onClick?.();
await new Promise((resolve) => setTimeout(resolve, 0));
const afterFailure = portals.at(-1)?.node;
check(
  'a refused revert shows the Host report',
  afterFailure?.props?.title === 'REVERT REFUSED',
  JSON.stringify(afterFailure?.props?.title),
);
check(
  'a refused revert is labelled as failed',
  String(afterFailure?.props?.children ?? '').includes('action.failed'),
  JSON.stringify(afterFailure?.props?.children),
);

// --- 删除会话是 Host 操作，在浏览器中确认 -------
// 该行菜单自己的条目会打开确认卡片；在这张卡片的确认控件
// 运行之前什么都不会被移除，而拒绝该检查的 Host（该
// 会话仍驻留在此次 DSH 运行中）会展示出来，而不是给出一个
// 只会失败的确认。
const deleteCommands = [];
let deletePlanKind = 'success';
let carrierAdmission = { ok: true, value: { matched: true } };
carrierSession = {
  eventSource: eventSource(),
  events: remoteJournalStream,
  command: (line) => {
    deleteCommands.push(line);
    // 没有该命令（或没有任何命令可达）的 Host 不会记录生命周期日志。
    if (carrierAdmission.ok !== true || carrierAdmission.value?.matched !== true) return Promise.resolve(carrierAdmission);
    const commandId = `del-${deleteCommands.length}`;
    entries.push({
      event: {
        type: 'command/run',
        seq: (lifecycleSeq += 1),
        data: { commandId, name: 'delete-session', args: line.replace(/^\/delete-session\s*/, '') },
      },
    });
    entries.push({
      event: {
        type: 'command/done',
        seq: (lifecycleSeq += 1),
        data: {
          commandId,
          kind: line.includes('--plan') ? deletePlanKind : 'success',
          text: line.includes('--plan') ? 'PLAN: remove session-1?' : 'DELETED session-1',
        },
      },
    });
    publish();
    return Promise.resolve(carrierAdmission);
  },
};
const Overlay = () => createElement(overlayComponent, { t: (key) => key });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const cardOf = () => passNodes.find((node) => node.className === 'dshrvcard');
const buttonOf = () => passNodes.find((node) => String(node.className).includes('dshrvprimary'));
/** 卡片自身的文案：标题和正文在其子节点上，而不是卡片节点上。 */
const cardTextOf = (card) => (card === undefined ? '' : card.children.map((child) => child.textContent).join('|'));

container.children.length = 0;
document.body.children.length = 0;
frames.clear();
askedFor.length = 0;
tree = createElement(Overlay);
mount();
await tick();

const actions = menuRegistration?.resolve({ sessionId, displayTitle: 'Rollback demo' }) ?? [];
check(
  'the Session row menu offers permanent deletion',
  actions.length === 1 && actions[0].id === 'delete' && actions[0].danger === true,
  JSON.stringify(actions.map((action) => action.id)),
);
check('the deletion entry is labelled for its locale', actions[0]?.label === 'menu.deleteSession', String(actions[0]?.label));
check('the deletion entry follows the shipped archive entry', menuRegistration?.order > 600, String(menuRegistration?.order));
check(
  'the deletion command renders no card of its own in Chat',
  commandRowEntry?.seat?.key === 'delete-session' &&
    commandRowEntry.component({ node: { name: 'delete-session', args: ` --id ${sessionId} --plan` } }) === null,
  JSON.stringify(commandRowEntry?.seat),
);

actions[0]?.run();
await tick();
check(
  'a deletion click asks the Host to inspect the Session first',
  deleteCommands.length === 1 && deleteCommands[0] === `/delete-session --id ${sessionId} --plan`,
  JSON.stringify(deleteCommands),
);
check(
  'the command runs in a carrier Session, never in the target',
  askedFor.includes(carrierId) && !askedFor.includes(sessionId),
  JSON.stringify(askedFor),
);
const deleteCard = cardOf();
check(
  'the confirmation card shows the Host inspection',
  cardTextOf(deleteCard).includes('PLAN: remove session-1?'),
  cardTextOf(deleteCard),
);
check('a deletable Session offers a confirm control', buttonOf() !== undefined);

buttonOf()?.__props?.onClick?.();
await tick();
check('confirming executes the deletion once', deleteCommands[1] === `/delete-session --id ${sessionId}`, JSON.stringify(deleteCommands));
check('the card closes once the Host removed the Session', cardOf() === undefined);
check('the Session baseline is re-pulled after a deletion', refreshes === 1, String(refreshes));

// 拒绝该检查的 Host 仍会用它的原因作答。
deletePlanKind = 'error';
menuRegistration.resolve({ sessionId, displayTitle: 'Rollback demo' })[0].run();
await tick();
const refusedCard = cardOf();
check(
  'a refused inspection is shown in the card',
  cardTextOf(refusedCard).includes('PLAN: remove session-1?'),
  cardTextOf(refusedCard),
);
check('a refused deletion offers no confirm control', refusedCard !== undefined && buttonOf() === undefined);
passNodes.find((node) => node.className === 'dshrvbtn')?.__props?.onClick?.();
await tick();

// 没有另一个会话可以承载该命令时，流程会预先拒绝，
// 而不是打开它即将移除的那个会话。
deletePlanKind = 'success';
snapshotIds = [sessionId];
menuRegistration.resolve({ sessionId, displayTitle: 'Rollback demo' })[0].run();
await tick();
const carrierlessCard = cardOf();
check(
  'a deletion with no carrier Session is refused',
  cardTextOf(carrierlessCard).includes('delete.noCarrier'),
  cardTextOf(carrierlessCard),
);

// 从未加载该命令的 Host（DSH 未重启）与一行从未
// 到达任何 Agent 的文本，会与仅仅速度慢的 Host 区分开。
snapshotIds = [sessionId, carrierId];
carrierAdmission = { ok: true, value: { matched: false } };
menuRegistration.resolve({ sessionId, displayTitle: 'Rollback demo' })[0].run();
await tick();
const unloadedCard = cardOf();
check(
  'a host without the command names that cause',
  cardTextOf(unloadedCard).includes('delete.unavailable'),
  cardTextOf(unloadedCard),
);
check('an unloaded command offers no confirm control', unloadedCard !== undefined && buttonOf() === undefined);
passNodes.find((node) => node.className === 'dshrvbtn')?.__props?.onClick?.();
await tick();

carrierAdmission = { ok: false, value: { matched: false } };
menuRegistration.resolve({ sessionId, displayTitle: 'Rollback demo' })[0].run();
await tick();
const unreachableCard = cardOf();
check(
  'a line that reached no Agent names that cause',
  cardTextOf(unreachableCard).includes('delete.unreachable'),
  cardTextOf(unreachableCard),
);
carrierAdmission = { ok: true, value: { matched: true } };

for (const line of results) console.log(line);
const passed = results.every((line) => line.startsWith('PASS'));
console.log(passed ? 'ALL PASS' : 'FAILURES');
if (!passed) process.exitCode = 1;
