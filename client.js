/**
 * revert-files 插件的浏览器半边。
 *
 * 两个控件，一个操作：
 *
 * - 每个用户消息行上的“撤回”控件。该行的所属座位
 *   （`conversation.chat.user.before`）只交出持久化的消息 `source`，
 *   别的什么都不给，所以轮次号是拿这个 source 与
 *   该行所构建的用户节点做匹配、从 Chat 快照里反查出来的。
 *   该控件被传送到该行自己的操作条里，紧挨着复制控件，
 *   当找不到那条操作条时，就退回气泡上方的座位。
 *   随后它把 `/revert --turn N` 转交给会话，宿主便从该轮次
 *   之前拍下的 Git 快照恢复整个工作区，
 *   并把对话本身回滚。
 * - 点击绝不直接执行：客户端先通过同一条命令向宿主索取 `--plan`
 *   报告，打开一张列出将要回退的文件的确认卡片，
 *   只有在卡片被确认后才执行。计划文本读取自宿主
 *   追加的 `command/done` 行，因为一条命令的结果
 *   本身不携带数据。
 * - 宿主回滚所隐藏的那些轮次，由浏览器半边与已加载
 *   日志保持同步的会话级规则从聊天记录中移除，
 *   因为在出厂 Chat 中替换副本只保留在模型侧。
 *   宿主为每次回滚标记一条空的 `user/message` 替换，
 *   并在其 source 中携带被隐藏的轮次范围。
 * - 变更审查标签页自带的单文件控件
 *   （`deliverables.review.file.actions`），它转发
 *   该文件自己的坐标，只恢复那一个文件。
 *
 * 一切依赖所属者 props 的地方都是防御式的：无法解析出
 * 轮次的行什么都不渲染，而不是渲染一个坏掉的控件。
 */

window.__ModuleLoader__.load({
  id: '@local/revert-files',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;

    const NS = '@local/revert-files';
    /** 宿主用来标记一次对话回滚的消息 source 类型。 */
    const ROLLBACK_SOURCE_KIND = 'revert-files';

    /** 中文字典。 */
    const zh = {
      'action.revert': '撤回',
      'action.reverting': '撤回中…',
      'action.done': '已撤回',
      'action.failed': '撤回失败',
      'action.title': '把工作区恢复到这条消息发出之前（整轮回退，基于 Git 快照）',
      'action.checking': '检查中…',
      'dialog.turn.title': '撤回这一轮？',
      'dialog.file.title': '撤回该文件？',
      'dialog.confirm': '确认撤回',
      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'dialog.fallback': '将还原本轮修改的文件，并撤回这一轮开始的对话内容（不可撤销）。',
      'dialog.noHost': '宿主没有回报预览（可能正忙），无法确认这一步；请稍后再试。',
      'file.revert': '撤回',
      'file.reverting': '撤回中…',
      'file.done': '已撤回',
      'file.failed': '撤回失败',
      'file.title': '把该文件恢复到本轮修改之前的内容',
      'file.checking': '检查中…',
      'menu.deleteSession': '删除会话（永久）',
      'delete.title': '永久删除这个会话？',
      'delete.confirm': '永久删除',
      'delete.cancel': '取消',
      'delete.close': '关闭',
      'delete.planning': '正在检查这个会话…',
      'delete.deleting': '正在删除…',
      'delete.failed': '删除失败',
      'delete.noCarrier': '删除需要另一个会话来承载这条命令，请先打开任意一个其它会话。',
      'delete.noHost': '宿主接受了删除命令，但没有回报检查结果（可能正忙）。',
      'delete.unavailable': '宿主还没有装配删除命令 —— 宿主半边的改动要重启 DSH 才生效。',
      'delete.unreachable': '删除命令没能送进承载会话，请先打开任意一个已有对话的会话再试。',
      'delete.cancelled': '已取消。',
    };

    /** 操作条控件、确认卡片，以及气泡上方的回退控件。 */
    const CSS = `
.dshrvanchor{display:none}
.dshrvact{height:calc(28px + var(--dsh-content-font-delta,0px));padding:0 10px;border-radius:var(--dsw-radius-sm);border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;cursor:pointer;transition:color .12s,background .12s}
.dshrvact:hover:not(:disabled){color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.dshrvact:disabled{cursor:default;opacity:.6}
.dshrvoverlay{position:fixed;inset:0;z-index:1000;padding:24px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,#00000080)}
.dshrvcard{display:flex;flex-direction:column;gap:12px;width:min(560px,100%);max-height:min(70vh,560px);padding:16px;border-radius:var(--dsw-radius-lg,12px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));box-shadow:0 16px 40px #00000029}
.dshrvtitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshrvplan{min-height:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshrvdialogactions{display:flex;justify-content:flex-end;gap:8px}
.dshrvbtn{height:28px;padding:0 12px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;transition:background .12s,opacity .12s}
.dshrvbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshrvbtn:disabled{cursor:default;opacity:.6}
.dshrvbtn.dshrvprimary{border-color:transparent;background:var(--dsw-alias-state-error-primary,#d95050);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dshrvbtn.dshrvprimary:hover:not(:disabled){background:var(--dsw-alias-state-error-primary,#d95050);opacity:.88}
.dshrvfile{height:24px;min-width:52px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:22px;cursor:pointer;transition:color .12s,background .12s}
.dshrvfile:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshrvfile:disabled{cursor:default;opacity:.6}
.dshrvturn{display:flex;justify-content:flex-end;width:100%;line-height:0}
.dshrvturn button{height:22px;padding:0 8px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:20px;transition:color .12s,background .12s}
.dshrvturn button:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshrvturn button:disabled{cursor:default;opacity:.6}
`;
    const CSS_ID = `${NS}/user-turn-control.css`;
    const HIDDEN_CSS_ID = `${NS}/rolled-back-turns.css`;
    /** 一次回滚所隐藏轮次数的上限，用作失控保护。 */
    const MAX_HIDDEN_TURNS = 1000;

    /** 只安装一次控件的样式表，样式内容变化时重绘它。 */
    function installStyles() {
      if (typeof document === 'undefined') return;
      const installed = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`);
      if (installed !== null) {
        // 模块重载而页面未重载时，旧的标签会继续存活。
        if (installed.textContent !== CSS) installed.textContent = CSS;
        return;
      }
      const tag = document.createElement('style');
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** 转义一个值，供双引号属性选择器内使用。 */
    const selectorValue = (value) => String(value).replace(/["\\]/g, '\\$&');

    /**
     * 会话的客户端事件窗口。一个会话绑定 —— 以及它所承载的
     * 会话 —— 会暴露 `eventSource`，即出厂 Chat 自己订阅
     * 并读取的那个快照存储。`session.events` 只是那个会重连的
     * 远程日志流：它既不提供 `getSnapshot` 也不提供
     * `subscribe`，所以读它只会得到空窗口，
     * 一切由日志驱动的功能都会静默失效。保留它，
     * 是作为在旧版客户端中该存储以那个名字暴露时的最后手段回退。
     * @param owner - 一个会话绑定或一个会话。
     * @returns 事件源；两种形态都不存在时为 undefined。
     */
    function journalOf(owner) {
      try {
        return owner?.eventSource ?? owner?.session?.eventSource ?? owner?.events ?? owner?.session?.events;
      } catch {
        return undefined;
      }
    }

    /** 一个会话已加载日志窗口中的每个事件，已从其记录中解包。 */
    function journalEvents(owner) {
      const source = journalOf(owner);
      const snapshot = typeof source?.getSnapshot === 'function' ? source.getSnapshot() : undefined;
      const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
      const events = [];
      for (const entry of entries) {
        const event = isRecord(entry) && isRecord(entry.event) ? entry.event : entry;
        if (isRecord(event)) events.push(event);
      }
      return events;
    }

    /** 日志所持有的最新事件 seq，空窗口时为 -1。 */
    function lastSeqOf(owner) {
      let last = -1;
      for (const event of journalEvents(owner)) {
        if (Number.isSafeInteger(event.seq) && event.seq > last) last = event.seq;
      }
      return last;
    }

    /**
     * 一次表层替换所携带的回滚 source；对其它任何事件都返回 undefined。
     * 宿主每次撤回都会落下一个空的 `user/message` 检查点，
     * 因为没有轮次处于打开状态时，只有用户消息才能替换
     * 一个表层区段；来自旧版本的 `developer/message` 检查点
     * 仍会被识别。
     * @param event - 一个已加载的日志事件。
     * @returns 携带 `from`/`to` 的 source，否则为 undefined。
     */
    function checkpointSource(event) {
      if (!isRecord(event.surfaceOp) || event.surfaceOp.op !== 'replace') return undefined;
      const data = isRecord(event.data) ? event.data : undefined;
      if (data === undefined) return undefined;
      const source =
        event.type === 'user/message' ? data.source : isRecord(data.message) ? data.message.source : undefined;
      if (!isRecord(source) || source.kind !== ROLLBACK_SOURCE_KIND) return undefined;
      return source;
    }

    /**
     * 已加载日志所携带的每一个对话回滚范围。
     * @param owner - 一个会话绑定或一个会话。
     * @returns `{from, to}` 范围，升序。
     */
    function rollbackRanges(owner) {
      const ranges = [];
      for (const event of journalEvents(owner)) {
        const source = checkpointSource(event);
        if (source === undefined) continue;
        const from = source.from;
        const to = source.to;
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) continue;
        if (from <= 0 || to < from) continue;
        ranges.push({ from, to: Math.min(to, from + MAX_HIDDEN_TURNS - 1) });
      }
      ranges.sort((left, right) => left.from - right.from);
      return ranges;
    }

    /** 这些范围所覆盖的轮次号。 */
    function hiddenTurns(ranges) {
      const turns = new Set();
      for (const range of ranges) {
        for (let turn = range.from; turn <= range.to; turn += 1) turns.add(turn);
      }
      return turns;
    }

    /** 重写那些隐藏已回滚轮次的会话级规则。 */
    function paintHiddenTurns(bySession) {
      if (typeof document === 'undefined') return;
      let tag = document.querySelector(`style[data-plugin-css="${HIDDEN_CSS_ID}"]`);
      if (tag === null) {
        tag = document.createElement('style');
        tag.dataset.plugin = NS;
        tag.dataset.pluginCss = HIDDEN_CSS_ID;
        document.head.appendChild(tag);
      }
      const rules = [];
      for (const [sessionId, turns] of bySession) {
        const scope = `[data-conversation-session="${selectorValue(sessionId)}"]`;
        for (const turn of turns) rules.push(`${scope} [data-chat-turn="${turn}"]{display:none!important}`);
      }
      const text = rules.join('\n');
      if (tag.textContent !== text) tag.textContent = text;
    }

    /**
     * 让页面中挂载的每个对话与其会话事件窗口所携带的回滚
     * 保持同步：聊天记录不得比它所回滚自的模型历史
     * 活得更久。
     * @param sessionsService - 客户端的 Sessions 服务。
     * @returns 一个释放函数，移除该监听器、其订阅及其规则。
     */
    function watchRollbacks(sessionsService) {
      if (typeof document === 'undefined') return () => {};
      /** @type {Map<string, {session: unknown, source: unknown, unsubscribe: (() => void)|undefined, revision: unknown}>} */
      const watched = new Map();
      /** @type {Map<string, Set<number>>} */
      const rules = new Map();

      const drop = (sessionId) => {
        watched.get(sessionId)?.unsubscribe?.();
        watched.delete(sessionId);
        if (rules.delete(sessionId)) paintHiddenTurns(rules);
      };

      const refresh = (sessionId) => {
        let session;
        try {
          session = sessionsService.binding(sessionId)?.session;
        } catch {
          session = undefined;
        }
        if (session === undefined) {
          drop(sessionId);
          return;
        }
        const source = journalOf(session);
        let entry = watched.get(sessionId);
        if (entry === undefined || entry.session !== session || entry.source !== source) {
          entry?.unsubscribe?.();
          const unsubscribe =
            typeof source?.subscribe === 'function' ? source.subscribe(() => refresh(sessionId)) : undefined;
          entry = { session, source, unsubscribe, revision: undefined };
          watched.set(sessionId, entry);
        }
        // DOM 路径会为页面中任何位置的每次变更调用这里，因此未变化的
        // 事件窗口绝不能重扫。`revision` 是存储自己的变更计数器；
        // 不发布该值的存储每次都会被重扫，
        // 而这是安全的方向。
        const revision = typeof source?.getSnapshot === 'function' ? source.getSnapshot()?.revision : undefined;
        if (revision !== undefined && entry.revision === revision) return;
        entry.revision = revision;
        const turns = hiddenTurns(rollbackRanges(session));
        const previous = rules.get(sessionId);
        if (turns.size === 0) {
          if (previous !== undefined) {
            rules.delete(sessionId);
            paintHiddenTurns(rules);
          }
          return;
        }
        if (previous !== undefined && previous.size === turns.size && [...turns].every((turn) => previous.has(turn))) return;
        rules.set(sessionId, turns);
        paintHiddenTurns(rules);
      };

      const mounted = () => {
        const ids = new Set();
        for (const element of document.querySelectorAll('[data-conversation-session]')) {
          const id = element.getAttribute('data-conversation-session');
          if (typeof id === 'string' && id !== '') ids.add(id);
        }
        for (const id of ids) refresh(id);
        for (const id of [...watched.keys()]) if (!ids.has(id)) drop(id);
      };

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') {
            mounted();
            return;
          }
          for (const node of record.addedNodes) {
            if (typeof Element !== 'undefined' && node instanceof Element) {
              mounted();
              return;
            }
          }
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-conversation-session'],
      });
      mounted();
      return () => {
        observer.disconnect();
        for (const entry of watched.values()) entry.unsubscribe?.();
        watched.clear();
        rules.clear();
        paintHiddenTurns(rules);
      };
    }

    /** @param {unknown} value @returns {value is Record<string, unknown>} */
    const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

    /** 客户端在日志中等待宿主计划报告的时长。 */
    const PLAN_TIMEOUT_MS = 2500;
    /**
     * 客户端等待宿主执行报告的时长。整个工作区的恢复
     * 远超计划往返所需的时间，而放弃等待绝不能
     * 把一次成功的撤回变成失败。
     */
    const EXECUTE_TIMEOUT_MS = 15000;
    /** 本插件所驱动的宿主命令。 */
    const COMMAND_NAME = 'revert';
    /** 删除一个会话及其所拥有的一切的宿主命令。 */
    const DELETE_COMMAND_NAME = 'delete-session';

    /**
     * 日志在 `afterSeq` 之后完成的某条宿主命令的最新一次运行，
     * 按类别区分：`--plan` 预览运行，或实际执行运行。
     * 宿主会持久地记录 `command/run`/`command/done` 行，
     * 而命令结果本身不携带数据，所以这里是唯一能读到
     * 结果文本与类别的地方。
     * @param events - 已加载日志窗口中的每个事件。
     * @param afterSeq - 忽略位于该位置及之前的行。
     * @param plan - `--plan` 运行为 true，执行运行为 false。
     * @param name - 要读取其行的宿主命令。
     * @returns `{kind, text}`；宿主尚未作答时为 undefined。
     */
    function commandOutcome(events, afterSeq, plan, name = COMMAND_NAME) {
      const tracked = new Set();
      let outcome;
      for (const event of events) {
        if (!Number.isSafeInteger(event.seq) || event.seq <= afterSeq) continue;
        const data = isRecord(event.data) ? event.data : undefined;
        if (event.type === 'command/run') {
          if (data?.name !== name) continue;
          if (typeof data.args !== 'string' || data.args.includes('--plan') !== plan) continue;
          if (typeof data.commandId === 'string') tracked.add(data.commandId);
        } else if (event.type === 'command/done' && typeof data?.commandId === 'string' && tracked.has(data.commandId)) {
          outcome = {
            kind: typeof data.kind === 'string' ? data.kind : 'success',
            text: typeof data.text === 'string' && data.text !== '' ? data.text : undefined,
          };
        }
      }
      return outcome;
    }

    /** 等待某条宿主命令运行的某一类别到达会话日志。 */
    function waitForCommand(owner, afterSeq, plan, timeoutMs, name = COMMAND_NAME) {
      return new Promise((resolve) => {
        const source = journalOf(owner);
        if (typeof source?.subscribe !== 'function') {
          resolve(undefined);
          return;
        }
        let unsubscribe;
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe?.();
          resolve(value);
        };
        const scan = () => {
          const outcome = commandOutcome(journalEvents(owner), afterSeq, plan, name);
          if (outcome !== undefined) finish(outcome);
        };
        unsubscribe = source.subscribe(scan);
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        scan();
      });
    }

    /**
     * 针对一个会话运行一个任务：该行持有绑定时，借来的绑定就够了；
     * 否则就为这次调用获取一个引用。
     * @param sessionId - 所属会话。
     * @param task - 接收客户端会话。
     * @returns 任务的返回值；无法触达任何会话时为 undefined。
     */
    async function withSession(sessionId, task) {
      let borrowed;
      try {
        borrowed = sessions.binding(sessionId)?.session;
      } catch {
        borrowed = undefined;
      }
      if (borrowed !== undefined && typeof borrowed.command === 'function') {
        try {
          return await task(borrowed);
        } catch {
          return undefined;
        }
      }
      try {
        return await sessions.using(sessionId, { source: 'gateway' }, (reference) => task(reference.binding.session));
      } catch {
        return undefined;
      }
    }

    /**
     * 询问宿主某条命令会改变什么，而不改变任何东西。
     * @param sessionId - 所属会话。
     * @param line - `--plan` 命令行。
     * @param name - 该行所驱动的宿主命令。
     * @returns `{kind, text}` 报告；宿主对该行没有处理者时为
     *   `{kind: 'unavailable'}`；没有会话能承载它时为 `{kind: 'unreachable'}`；
     *   宿主认领了却从未回报时为 undefined。
     */
    async function requestPlan(sessionId, line, name = COMMAND_NAME) {
      const outcome = await withSession(sessionId, async (session) => {
        if (typeof session?.command !== 'function') return { kind: 'unreachable' };
        const after = lastSeqOf(session);
        // 等待在该行发出之前就已布好，所以立即作答的宿主
        // 也不会被错过。
        const waiting = waitForCommand(session, after, true, PLAN_TIMEOUT_MS, name);
        const admission = await session.command(line).catch(() => undefined);
        // 准入判定先行，并立即作答：为一条没有处理者认领的行把日志窗口
        // 等完，只会掩盖真正的原因。
        if (admission?.ok !== true) return { kind: 'unreachable' };
        if (admission.value?.matched !== true) return { kind: 'unavailable' };
        return await waiting;
      });
      return outcome ?? { kind: 'unreachable' };
    }

    /**
     * 一个 Chat 用户节点是否由该行自己的 source 构建而来。
     * @param nodeSource - 该节点的持久化消息 source。
     * @param ownerSource - 该控件为其渲染的 source。
     * @returns 当二者描述同一条消息时为 true。
     */
    function sameSource(nodeSource, ownerSource) {
      if (nodeSource === ownerSource) return true;
      if (!isRecord(nodeSource) || !isRecord(ownerSource)) return false;
      return (
        typeof nodeSource.rpcId === 'string' &&
        nodeSource.rpcId !== '' &&
        nodeSource.rpcId === ownerSource.rpcId
      );
    }

    /**
     * 从该行自己的节点里读出轮次，那是唯一携带它的地方：
     * 座位的所属者 props 止步于 `{source, kind}`。
     * @param snapshot - Chat 快照。
     * @param ownerSource - 该控件为其渲染的 source。
     * @returns 轮次号；无法解析时为 undefined。
     */
    function turnOfSource(snapshot, ownerSource) {
      const nodes = snapshot?.nodes;
      if (nodes === undefined || typeof nodes.values !== 'function') return undefined;
      for (const node of nodes.values()) {
        if (!isRecord(node) || node.kind !== 'user') continue;
        if (!sameSource(isRecord(node.data) ? node.data.source : undefined, ownerSource)) continue;
        const location = node.location;
        if (!isRecord(location)) continue;
        if (location.kind !== 'turn' && location.kind !== 'step') continue;
        const turn = isRecord(location.turn) ? location.turn.turn : undefined;
        return Number.isSafeInteger(turn) && turn > 0 ? turn : undefined;
      }
      return undefined;
    }

    /**
     * 把一条命令行发送给所属会话，并报告宿主对它的处理结果。
     * `session.command` 只报告是否有处理者认领了该行，
     * 否则一次拒绝就会被读成成功；结果本身是宿主追加到
     * 会话里的 `command/done` 行。
     * @param sessionId - 所属会话。
     * @param line - 要执行的命令行。
     * @param name - 该行所驱动的宿主命令。
     * @returns `{status: 'done'|'failed'|'unavailable', text}`，其中 `text` 是
     *   宿主报告，`unavailable` 表示没有处理者认领该行。
     */
    async function runCommand(sessionId, line, name = COMMAND_NAME) {
      const outcome = await withSession(sessionId, async (session) => {
        if (typeof session?.command !== 'function') return undefined;
        const after = lastSeqOf(session);
        const waiting = waitForCommand(session, after, false, EXECUTE_TIMEOUT_MS, name);
        const admission = await session.command(line).catch(() => undefined);
        // 没有处理者认领的行会立即得到答复；只有被认领的行
        // 才值得把日志窗口等完。
        if (admission?.ok !== true || admission.value?.matched !== true) return { status: 'unavailable', text: undefined };
        const report = await waiting;
        // 没有报告意味着等待超时：宿主接受了该行且仍在工作，
        // 所以只有显式错误才算失败。
        if (report !== undefined && report.kind === 'error') return { status: 'failed', text: report.text };
        return { status: 'done', text: report?.text };
      });
      return outcome ?? { status: 'unavailable', text: undefined };
    }

    /**
     * 一张确认卡片：宿主的计划文本，以及一对取消/确认按钮。
     * 通过 body 传送门渲染，这样任何消息行都无法裁剪它。
     * @param props - 卡片文案、计划正文，以及两个结果回调。
     * @returns 卡片的传送门。
     */
    function ConfirmDialog(props) {
      const onKeyDown = React.useCallback(
        (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            props.onCancel();
          }
        },
        [props],
      );
      return createPortal(
        h(
          'div',
          {
            className: 'dshrvoverlay',
            role: 'presentation',
            onClick: (event) => {
              if (event.target === event.currentTarget) props.onCancel();
            },
          },
          h(
            'div',
            { className: 'dshrvcard', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title, onKeyDown },
            h('div', { className: 'dshrvtitle' }, props.title),
            h('div', { className: 'dshrvplan' }, props.body),
            h(
              'div',
              { className: 'dshrvdialogactions' },
              h('button', { type: 'button', className: 'dshrvbtn', onClick: props.onCancel }, props.cancelLabel),
              props.confirmHidden === true
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshrvbtn dshrvprimary',
                      onClick: props.onConfirm,
                      disabled: props.confirmDisabled === true,
                      autoFocus: true,
                    },
                    props.confirmLabel,
                  ),
            ),
          ),
        ),
        document.body,
      );
    }

    /**
     * 一个撤回控件的状态机：询问宿主会改变什么，展示那份计划，
     * 然后才执行。状态依次为 idle → planning → confirm → busy →
     * done | failed，取消则回到 idle。宿主拒绝的预览
     * （没有快照、文件无法定位）或从未回报的预览仍会打开卡片，
     * 但会置上 `refused` 且不提供破坏性控件：
     * 再点一次也只会再次失败，而撤回是不可撤销的。
     * @param sessionId - 所属会话。
     * @param line - 要执行的 `/revert` 命令行。
     * @param planLine - 带 `--plan` 的同一请求。
     * @param unreachableText - 宿主从未回报预览时使用的文案。
     * @returns 状态、计划文本、拒绝标志，以及各个回调。
     */
    function useRevertAction(sessionId, line, planLine, unreachableText) {
      const [state, setState] = React.useState('idle');
      const [plan, setPlan] = React.useState(undefined);
      const [refused, setRefused] = React.useState(false);
      const [failure, setFailure] = React.useState(undefined);
      const mounted = React.useRef(true);
      React.useEffect(
        () => () => {
          mounted.current = false;
        },
        [],
      );
      const settle = React.useCallback((next, detail) => {
        if (!mounted.current) return;
        setFailure(detail);
        setState(next);
      }, []);
      const run = React.useCallback(() => {
        if (line === undefined || planLine === undefined || sessionId === undefined) return;
        setFailure(undefined);
        setRefused(false);
        setState('planning');
        requestPlan(sessionId, planLine).then((report) => {
          if (!mounted.current) return;
          // 完全没有报告，就是宿主从未作答；`kind: 'error'` 则是
          // 宿主自己的拒绝。两者都没有什么可确认的。
          setPlan(report === undefined ? unreachableText : report.text);
          setRefused(report === undefined || report.kind === 'error');
          setState('confirm');
        }, () => settle('failed'));
      }, [line, planLine, sessionId, settle, unreachableText]);
      const cancel = React.useCallback(() => {
        setPlan(undefined);
        setRefused(false);
        setState('idle');
      }, []);
      const confirm = React.useCallback(() => {
        if (line === undefined || sessionId === undefined) return;
        setPlan(undefined);
        setRefused(false);
        setState('busy');
        runCommand(sessionId, line).then((outcome) => settle(outcome.status === 'done' ? 'done' : 'failed', outcome.text));
      }, [line, sessionId, settle]);
      return { state, plan, refused, failure, run, cancel, confirm };
    }

    /** 某个控件状态的标签。 */
    function labelOf(state, prefix, translate) {
      if (state === 'planning') return translate(`${prefix}.checking`);
      if (state === 'busy') return translate(`${prefix}.reverting`);
      if (state === 'done') return translate(`${prefix}.done`);
      if (state === 'failed') return translate(`${prefix}.failed`);
      return translate(`${prefix}.revert`);
    }

    /**
     * 承载某条消息行复制控件的操作条。座位渲染在该行内部，
     * 所以从它向上走到最近的、以该操作条为直接子节点的
     * 祖先，即可找到该行；
     * 流式条目是最后尝试的一层。
     * @param anchor - 本插件在该行中的隐藏座位。
     * @returns 该操作条；标记结构不是预期形态时为 null。
     */
    function actionRowOf(anchor) {
      let node = anchor.parentElement;
      while (node !== null) {
        for (const child of node.children) {
          const name = typeof child.className === 'string' ? child.className : '';
          if (/(^|\s)\S*_actions(\s|$)/.test(name)) return child;
        }
        if (node.hasAttribute('data-chat-flow-kind')) return null;
        node = node.parentElement;
      }
      return null;
    }

    /**
     * 单个用户消息行的撤回控件。所属座位渲染在气泡之前，
     * 所以该控件被传送到该行自己的操作条里，
     * 紧挨着复制控件；找不到操作条的行则保留
     * 气泡上方的座位作为回退。
     * @param props - 所属者的 `{source, kind}` 加上标准座位 props。
     * @returns 该控件；该行的轮次未知时为 null。
     */
    function RevertTurnAction(props) {
      const translate = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? key;
      const source = props.source;
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined;
      const useChat = props.useChat;
      const select = React.useCallback((snapshot) => turnOfSource(snapshot, source), [source]);
      // `useChat` 是座位契约标准 props 的一部分，所以这个条件
      // 在该行的整个生命周期内都是稳定的。
      const turn = typeof useChat === 'function' ? useChat(select) : undefined;
      const line = Number.isSafeInteger(turn) && turn > 0 ? `/revert --turn ${turn}` : undefined;
      const planLine = line === undefined ? undefined : `${line} --plan`;
      const { state, plan, refused, failure, run, cancel, confirm } = useRevertAction(
        sessionId,
        line,
        planLine,
        translate('dialog.noHost'),
      );
      const active = props.kind === 'user' && line !== undefined;
      const anchorRef = React.useRef(null);
      const [host, setHost] = React.useState(null);

      // 操作条属于出厂的该行，所以该行每次变更后都要重新读取它：
      // 行保持挂载时，React 仍可能把它替换掉。
      React.useLayoutEffect(() => {
        if (!active) return undefined;
        const anchor = anchorRef.current;
        if (anchor === null) return undefined;
        const row = anchor.closest('[data-chat-flow-kind]');
        if (row === null) return undefined;
        let seat = null;
        const locate = () => {
          const actions = actionRowOf(anchor);
          if (actions === null) return;
          let slot = actions.querySelector('[data-revert-files-seat]');
          if (slot === null) {
            slot = anchor.ownerDocument.createElement('span');
            slot.setAttribute('data-revert-files-seat', '');
            actions.appendChild(slot);
            seat = slot;
          }
          setHost((current) => (current === slot ? current : slot));
        };
        locate();
        const observer = new MutationObserver(locate);
        observer.observe(row, { childList: true, subtree: true });
        return () => {
          observer.disconnect();
          if (seat !== null && seat.parentNode !== null) seat.remove();
        };
      }, [active]);

      if (props.kind !== 'user') return null;
      if (line === undefined) return null;

      const button = h(
        'button',
        {
          type: 'button',
          className: host === null ? undefined : 'dshrvact',
          title: state === 'failed' && failure !== undefined ? failure : translate('action.title'),
          'aria-label': translate('action.title'),
          disabled: state === 'busy' || state === 'planning',
          onClick: run,
        },
        labelOf(state, 'action', translate),
      );
      const dialog =
        state === 'confirm'
          ? h(ConfirmDialog, {
              title: translate('dialog.turn.title'),
              body: plan ?? translate('dialog.fallback'),
              confirmLabel: translate('dialog.confirm'),
              cancelLabel: translate(refused ? 'dialog.close' : 'dialog.cancel'),
              confirmHidden: refused,
              onCancel: cancel,
              onConfirm: confirm,
            })
          : null;

      return h(
        React.Fragment,
        null,
        h('span', { ref: anchorRef, className: 'dshrvanchor', 'aria-hidden': 'true' }),
        host === null ? h('div', { className: 'dshrvturn' }, button) : createPortal(button, host),
        dialog,
      );
    }

    /**
     * 从审查标签页自己的操作路由中读出会话与文件坐标：
     * `changes.open?sessionId=…&seq=…&index=…`。
     * @param actionUrl - 所属者提供的路由（若提供了的话）。
     * @returns 坐标；路由不是这种形态时为 null。
     */
    function parseCoordinates(actionUrl) {
      if (typeof actionUrl !== 'string') return null;
      const mark = actionUrl.indexOf('?');
      if (mark < 0) return null;
      const params = new URLSearchParams(actionUrl.slice(mark + 1));
      const sessionId = params.get('sessionId');
      const rawSeq = params.get('seq');
      const rawIndex = params.get('index');
      if (sessionId === null || sessionId === '') return null;
      if (rawSeq === null || rawSeq === '' || rawIndex === null || rawIndex === '') return null;
      // `Number('')` 为 0，所以上面的空串检查才是拦住一条没有坐标的路由、
      // 不让它渲染出必然失败的控件的关键。
      const seq = Number(rawSeq);
      const index = Number(rawIndex);
      if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(index)) return null;
      if (seq < 0 || index < 0) return null;
      return { sessionId, seq, index };
    }

    /**
     * 撤回审查标签页正在展示的那个文件。
     * @param props - 所属者的文件路由 props 加上区域设置绑定器。
     * @returns 该控件；路由不可读时为 null。
     */
    function RevertFileAction(props) {
      const translate = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? key;
      const coordinates = React.useMemo(() => parseCoordinates(props.actionUrl), [props.actionUrl]);
      const line =
        coordinates === null ? undefined : `/revert --seq ${coordinates.seq} --index ${coordinates.index}`;
      const planLine = line === undefined ? undefined : `${line} --plan`;
      const { state, plan, refused, failure, run, cancel, confirm } = useRevertAction(
        coordinates?.sessionId,
        line,
        planLine,
        translate('dialog.noHost'),
      );

      if (coordinates === null) return null;

      const busy = state === 'busy' || state === 'planning';
      const dialog =
        state === 'confirm'
          ? h(ConfirmDialog, {
              title: translate('dialog.file.title'),
              body: plan ?? translate('dialog.fallback'),
              confirmLabel: translate('dialog.confirm'),
              cancelLabel: translate(refused ? 'dialog.close' : 'dialog.cancel'),
              confirmHidden: refused,
              onCancel: cancel,
              onConfirm: confirm,
            })
          : null;

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'dshrvfile',
            title: state === 'failed' ? failure ?? translate('file.failed') : translate('file.title'),
            'aria-label': translate('file.title'),
            disabled: busy,
            onClick: run,
          },
          labelOf(state, 'file', translate),
        ),
        dialog,
      );
    }

    /**
     * 此刻能够承载一条删除命令的会话。目标自身绝不是
     * 候选者：会话不能删除自己，而在这里打开它反而会
     * 把它实体化 —— 那正是宿主拒绝移除的状态。
     * 宿主已发布其 Agent 的行会被优先选择，因为临时的
     * 空白会话没有可运行该命令的 Agent。
     * @param targetId - 即将被移除的会话。
     * @returns 承载会话的 id；没有任何可达会话时为 undefined。
     */
    function carrierFor(targetId) {
      let snapshot;
      try {
        snapshot = sessions?.list?.getSnapshot?.();
      } catch {
        snapshot = undefined;
      }
      const ids = Array.isArray(snapshot?.ids) ? snapshot.ids : [];
      const rows = isRecord(snapshot?.byId) ? snapshot.byId : {};
      const candidates = ids.filter((id) => typeof id === 'string' && id !== targetId);
      // 主视图所展示的那一行是最可靠的承载者：它持有活跃的 Agent，
      // 因此无需为了发送该命令而打开新会话。
      const rank = (id) => {
        const row = isRecord(rows[id]) ? rows[id] : {};
        const main = (row.retainedBy?.mainView ?? 0) > 0 ? 2 : 0;
        // 列表快照不携带 Agent 可用性字段 —— 那是管理器状态 ——
        // 所以这里唯一已发布的偏好是保留状态；其余情况由下面的
        // 借来绑定探针覆盖。
        return main;
      };
      const ranked = candidates.map((id) => ({ id, rank: rank(id) })).sort((left, right) => right.rank - left.rank);
      if (ranked.length > 0 && ranked[0].rank > 0) return ranked[0].id;
      for (const id of candidates) {
        try {
          if (typeof sessions?.binding?.(id)?.session?.command === 'function') return id;
        } catch {
          // 没有借来绑定的行只是不算优先的承载者。
        }
      }
      return candidates[0];
    }

    /** 唯一一个等待用户确认的删除请求（如果有）。 */
    let deleteRequest = null;
    /** 正在监听待处理删除的组件。 */
    const deleteSubscribers = new Set();
    /** 待处理的删除，作为供覆盖层组件订阅的值。 */
    function useDeleteRequest() {
      const [value, setValue] = React.useState(deleteRequest);
      React.useEffect(() => {
        deleteSubscribers.add(setValue);
        setValue(deleteRequest);
        return () => {
          deleteSubscribers.delete(setValue);
        };
      }, []);
      return value;
    }
    /** 为某个会话行打开确认。 */
    function requestDeletion(sessionId, displayTitle) {
      deleteRequest = { sessionId, displayTitle };
      for (const subscriber of deleteSubscribers) subscriber(deleteRequest);
    }
    /** 关闭确认，无论其结果如何。 */
    function settleDeletion() {
      deleteRequest = null;
      for (const subscriber of deleteSubscribers) subscriber(null);
    }

    /**
     * 重新拉取宿主的会话基线，这样即使宿主移除某行的移除事件被漏掉，
     * 该行也会离开侧边栏。
     */
    function resyncSessions() {
      try {
        const refreshed = sessions?.refresh?.();
        if (refreshed !== undefined && typeof refreshed.catch === 'function') refreshed.catch(() => undefined);
      } catch {
        // 即使没有基线刷新，宿主自己的移除事件也仍会到达。
      }
    }

    /**
     * 针对一个待处理删除的确认卡片。宿主自己的检查结果就是卡片正文，
     * 因此一个可能不可移除的会话 —— 它仍驻留在本次 DSH 运行中 ——
     * 会在用户做出任何承诺之前说明这一点。
     * @param props - 覆盖层座位提供的区域设置绑定器。
     * @returns 打开的卡片；没有待处理项时为 null。
     */
    function DeleteSessionDialog(props) {
      const translate = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? key;
      const request = useDeleteRequest();
      const [phase, setPhase] = React.useState('idle');
      const [body, setBody] = React.useState(undefined);
      const [failure, setFailure] = React.useState(undefined);
      const sessionId = request?.sessionId;

      // 每次点击一个请求对象，所以对同一个会话的第二次尝试
      // 会重新检查，而不是展示上一次尝试的卡片。
      React.useEffect(() => {
        const target = deleteRequest?.sessionId;
        if (target === undefined) {
          setPhase('idle');
          return undefined;
        }
        let live = true;
        setPhase('planning');
        setBody(undefined);
        setFailure(undefined);
        const carrier = carrierFor(target);
        if (carrier === undefined) {
          setFailure(translate('delete.noCarrier'));
          setPhase('failed');
          return undefined;
        }
        requestPlan(carrier, `/${DELETE_COMMAND_NAME} --id ${target} --plan`, DELETE_COMMAND_NAME).then(
          (report) => {
            if (!live) return;
            // 每一种得不到检查结果的途径都点明自己的原因：宿主没有
            // 这条命令（它没被重启）、命令从未送达 Agent，
            // 以及宿主干脆从未作答。
            if (report === undefined) {
              setFailure(translate('delete.noHost'));
              setPhase('failed');
              return;
            }
            if (report.kind === 'unavailable') {
              setFailure(translate('delete.unavailable'));
              setPhase('failed');
              return;
            }
            if (report.kind === 'unreachable') {
              setFailure(translate('delete.unreachable'));
              setPhase('failed');
              return;
            }
            const title = typeof deleteRequest?.displayTitle === 'string' ? deleteRequest.displayTitle : '';
            setBody(`${title === '' ? '' : `会话标题：${title}\n`}${report.text ?? ''}`);
            // 被拒绝的检查会报告 `error`；此时卡片只提供关闭。
            setPhase(report.kind === 'error' ? 'refused' : 'confirm');
          },
          () => {
            if (!live) return;
            setFailure(translate('delete.failed'));
            setPhase('failed');
          },
        );
        return () => {
          live = false;
        };
      }, [request]);

      const confirm = React.useCallback(() => {
        if (sessionId === undefined) return;
        const carrier = carrierFor(sessionId);
        if (carrier === undefined) {
          setFailure(translate('delete.noCarrier'));
          setPhase('failed');
          return;
        }
        setPhase('deleting');
        runCommand(carrier, `/${DELETE_COMMAND_NAME} --id ${sessionId}`, DELETE_COMMAND_NAME).then((outcome) => {
          if (outcome.status === 'done') {
            settleDeletion();
            resyncSessions();
            return;
          }
          setFailure(outcome.status === 'unavailable' ? translate('delete.unavailable') : outcome.text ?? translate('delete.failed'));
          setPhase('failed');
        });
      }, [sessionId]);

      if (request === null || phase === 'idle') return null;

      const refused = phase === 'refused' || phase === 'failed';
      const text =
        phase === 'planning'
          ? translate('delete.planning')
          : phase === 'deleting'
            ? translate('delete.deleting')
            : refusalText(phase, failure, body);

      return h(ConfirmDialog, {
        title: translate('delete.title'),
        body: text,
        confirmLabel: translate('delete.confirm'),
        cancelLabel: translate(refused ? 'delete.close' : 'delete.cancel'),
        // 在宿主的检查结果到达之前没有什么可确认的，而一次拒绝
        // 根本不会提供破坏性控件。
        confirmHidden: refused || phase === 'planning',
        confirmDisabled: phase === 'deleting',
        onCancel: settleDeletion,
        onConfirm: confirm,
      });
    }

    /** 某个已定局阶段所展示的正文：失败信息，否则是宿主的报告。 */
    function refusalText(phase, failure, body) {
      if (phase === 'failed') return failure ?? body ?? '';
      return body ?? '';
    }

    let sessions;

    return {
      inject: ['slots', 'locale', 'sessions', 'contextMenus'],
      /**
       * 注册字典、用户消息撤回控件、审查标签页的
       * 单文件控件、会话行的删除入口，以及删除命令
       * 自身 Chat 行的抑制器。
       * @param ctx - 客户端根上下文。
       */
      apply(ctx) {
        sessions = ctx.sessions;
        const t = ctx.locale.bind(NS);
        installStyles();
        ctx.effect(() => ctx.locale.register(NS, { zh }), 'revert-files: dictionaries');
        ctx.effect(() => watchRollbacks(ctx.sessions), 'revert-files: rolled-back turns');
        // 出厂的该行菜单通过这个注册表构建它的条目，
        // 这是插件添加条目的唯一途径：旧版会话菜单座位
        // 渲染在内置条目之前，无法替换它们。
        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: 'revert-files.delete-session',
              target: 'session',
              // 排在出厂的归档条目（600）之后，是该行菜单的最后一项。
              order: 700,
              resolve: (target) => {
                const sessionId = typeof target?.sessionId === 'string' ? target.sessionId : undefined;
                if (sessionId === undefined) return [];
                return [
                  {
                    id: 'delete',
                    label: t('menu.deleteSession'),
                    danger: true,
                    separatorBefore: true,
                    failureLabel: t('delete.failed'),
                    run: () => requestDeletion(sessionId, target.displayTitle),
                  },
                ];
              },
            }),
          'revert-files: session deletion menu',
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'revert-files.delete-session',
              locale: NS,
            },
            DeleteSessionDialog,
          ),
        );
        // 删除通道是管道，不是对话：卡片发送的每一行
        // 都是一对持久化的 `command/run`/`command/done`，
        // 而出厂 Chat 会为每一对渲染一张卡片 ——
        // 点四次就会让用户正在阅读的聊天记录里留下四份
        // 相同的检查结果。`conversation.chat.commandview`
        // 单元以命令名为键，所以用一个什么都不渲染的
        // 渲染器认领这条命令自己的名字，就能把这些行
        // 挡在 Chat 之外。命令照常工作；报告计划和
        // 结果的是那张确认卡片。出厂 Chat 是从它的 `command`
        // 节点条目声明这个单元的，因此这里用 `inject` 而非裸的 `register`。
        ctx.slots.inject('conversation.chat.commandview', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.commandview',
              key: DELETE_COMMAND_NAME,
            },
            () => null,
          ),
        );
        ctx.slots.inject('conversation.chat.user.before', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.user.before',
              locale: NS,
              // 该链每行选出一个条目，按优先级升序尝试。
              // 本条目让位给出厂占用者（实验性的 LiveShare
              // 来源装饰），并认领其余每个用户行，
              // 在轮次未知时什么都不渲染。
              priority: 100,
              // 任何非 null 的认领都会选中本条目；该值本身不会被读取。
              select: (owner) => (owner?.kind === 'user' ? true : null),
            },
            RevertTurnAction,
          ),
        );
        ctx.slots.inject('deliverables.review.file.actions', () =>
          ctx.slots.register(
            {
              name: 'deliverables.review.file.actions',
              id: 'revert-files',
              order: 10,
              locale: NS,
            },
            RevertFileAction,
          ),
        );
      },
    };
  },
});
