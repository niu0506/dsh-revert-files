/**
 * revert-files 插件的浏览器半边。
 *
 * 两个控件，一个操作：
 *
 * - 每个用户消息行上的“撤回”控件。该行的所属座位
 *   （`conversation.chat.user.before`）只交出持久化的消息 `source`，
 *   别的什么都不给，所以轮次号是拿这个 source 与
 *   该行所构建的用户节点做匹配、从 Chat 快照里反查出来的。
 *   该控件被传送到该行自己的操作条里，排在已有控件之后，
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
      'action.submitted': '已提交',
      'dialog.turn.title': '撤回这一轮？',
      'dialog.file.title': '撤回该文件？',
      'dialog.confirm': '确认撤回',
      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'dialog.fallback': '将还原本轮修改的文件，并撤回这一轮开始的对话内容（不可撤销）。',
      'dialog.noHost': '宿主没有回报预览（可能正忙），无法确认这一步；请稍后再试。',
      'dialog.noCommand': '宿主还没有装配撤回命令 —— 宿主半边的改动要重启 DSH 才生效。',
      'dialog.noCarrier': '撤回命令没能送进会话，请先打开任意一个已有对话的会话再试。',
      'file.title': '把该文件恢复到本轮修改之前的内容',
      'menu.deleteSession': '删除会话（永久）',
      'delete.title': '永久删除这个会话？',
      'delete.confirm': '永久删除',
      'delete.forceTitle': '从本次运行中卸载并永久删除这个会话？',
      'delete.forceConfirm': '强制删除',
      'delete.cancel': '取消',
      'delete.close': '关闭',
      'delete.planning': '正在检查这个会话…',
      'delete.deleting': '正在删除…',
      'delete.forcing': '正在卸载并删除…',
      'delete.failed': '删除失败',
      'delete.noCarrier': '删除需要另一个会话来承载这条命令，请先打开任意一个其它会话。',
      'delete.noHost': '宿主接受了删除命令，但没有回报检查结果（可能正忙）。',
      'delete.unavailable': '宿主还没有装配删除命令 —— 宿主半边的改动要重启 DSH 才生效。',
      'delete.selfOnly': '侧边栏里只有这一个会话。删除必须由另一个会话承载命令，请先打开任意一个其它会话再试。',
      'delete.refusedByCarrier': '承载会话没有接受这条删除命令（它可能还没有可用的 Agent），请先在侧边栏打开任意一个已有对话的会话再试。',
      'delete.badId': '这个会话的 ID 无法安全地传给宿主命令，拒绝删除。',
    };

    /**
     * 英文字典。区域设置运行时的回退链是"当前语言 → en → 裸 key"，
     * 所以只注册中文的话，英文界面下每个文案都会显示成它的 key。
     */
    const en = {
      'action.revert': 'Revert',
      'action.reverting': 'Reverting…',
      'action.done': 'Reverted',
      'action.failed': 'Revert failed',
      'action.title': 'Restore the workspace to just before this message (whole-turn revert, from Git snapshots)',
      'action.checking': 'Checking…',
      'action.submitted': 'Submitted',
      'dialog.turn.title': 'Revert this turn?',
      'dialog.file.title': 'Revert this file?',
      'dialog.confirm': 'Revert',
      'dialog.cancel': 'Cancel',
      'dialog.close': 'Close',
      'dialog.fallback': 'Restores the files this turn changed and rolls the conversation back to before it (irreversible).',
      'dialog.noHost': 'The host did not report a preview (it may be busy), so this step cannot be confirmed. Try again later.',
      'dialog.noCommand': 'The host has not loaded the revert command yet — restart DSH to pick up host-side changes.',
      'dialog.noCarrier': 'The revert command could not be delivered. Open any session that already has a conversation and try again.',
      'file.title': 'Restore this file to its contents before this turn changed it',
      'menu.deleteSession': 'Delete session (permanent)',
      'delete.title': 'Permanently delete this session?',
      'delete.confirm': 'Delete permanently',
      'delete.forceTitle': 'Unload from this run and permanently delete this session?',
      'delete.forceConfirm': 'Force delete',
      'delete.cancel': 'Cancel',
      'delete.close': 'Close',
      'delete.planning': 'Checking this session…',
      'delete.deleting': 'Deleting…',
      'delete.forcing': 'Unloading and deleting…',
      'delete.failed': 'Delete failed',
      'delete.noCarrier': 'Deleting needs another session to carry the command. Open any other session first.',
      'delete.noHost': 'The host accepted the delete command but never reported the check result (it may be busy).',
      'delete.unavailable': 'The host has not loaded the delete command yet — restart DSH to pick up host-side changes.',
      'delete.selfOnly': 'This is the only session in the sidebar. Deleting must be carried by another session — open any other session first.',
      'delete.refusedByCarrier': 'The carrying session did not accept the delete command (it may not have a usable agent yet). Open any session that already has a conversation and try again.',
      'delete.badId': 'This session id cannot be passed to the host command safely; refusing to delete it.',
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
     * 并读取的那个快照存储（`getSnapshot` / `subscribe`）。
     *
     * 不要再往这里加 `.events` 之类的猜测性兜底：`SessionFace` 与
     * `MutableSessionEventSource` 都没有那个成员，读它只会得到
     * `undefined`，于是所有由日志驱动的功能静默失效，而失效的原因
     * 被藏在"看起来做了兼容"的分支里。
     * @param owner - 一个会话绑定或一个会话。
     * @returns 事件源；两种形态都不存在时为 undefined。
     */
    function journalOf(owner) {
      try {
        return owner?.eventSource ?? owner?.session?.eventSource;
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
     * 一个可以安全拼进命令行的会话 id。
     *
     * 宿主按空白切分命令行，所以 id 里不能有空白；这个白名单同时排除了
     * 引号、反斜杠、`$` 之类会改变切分或路径解析的字符。以 `--` 开头的
     * id 由宿主的参数解析器把住（它拒绝把 `--` 开头的词当成参数值），
     * 不在这一层的职责范围内 —— 这里只保证"拼进去不会变成别的东西"。
     * @param {unknown} sessionId - 会话 id。
     * @returns {string|undefined} 校验通过的 id；否则为 undefined。
     */
    function safeSessionId(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;
      return /^[A-Za-z0-9._:@-]+$/.test(sessionId) ? sessionId : undefined;
    }

    /**
     * 一条命令行里，命令名之后的参数部分。
     *
     * 宿主把 `command/run` 的 `args` 记成命令名之后的原文，所以这里
     * 去掉命令名与分隔符，得到的就是同一串词元。
     * @param {string} line - 完整的命令行。
     * @returns {string} 参数部分；无法解析时为 ''。
     */
    function argumentsOf(line) {
      const match = /^\s*\/\S*\s*(.*)$/.exec(String(line ?? ''));
      if (match === null) return '';
      return match[1].trim();
    }

    /**
     * 两条参数串是否说的是同一件事。
     *
     * 按空白切开的词元序列必须完全一致：只比较"含不含 `--plan`"会
     * 让本插件认领别人的运行 —— 用户手敲的 `/revert --turn 9 --plan`
     * 会被当成本插件自己的预览，于是卡片显示第 9 轮的文件清单，确认
     * 时执行的却是另一轮。
     * @param {string} left - 宿主记录下来的参数。
     * @param {string} right - 客户端自己发出的参数。
     * @param {string} name - 命令名；两边开头带着它时都去掉。
     * @returns {boolean} 两者等价时为 true。
     */
    function sameArguments(left, right, name = COMMAND_NAME) {
      if (typeof left !== 'string' || typeof right !== 'string') return false;
      const tokens = (value) => value.trim().split(/\s+/).filter((token) => token !== '');
      // 宿主记下的参数有可能带着命令名（`revert --turn 4`），也有可能
      // 不带（`--turn 4`）；两种形状都要能对上。
      const strip = (list) => {
        if (list.length === 0) return list;
        return list[0] === name || list[0] === `/${name}` ? list.slice(1) : list;
      };
      const first = strip(tokens(left));
      const second = strip(tokens(right));
      return first.length === second.length && first.every((token, index) => token === second[index]);
    }

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
     * @param expectedArgs - 客户端自己发出的参数串；给出时只认这一条运行。
     * @returns `{kind, text}`；宿主尚未作答时为 undefined。
     */
    function commandOutcome(events, afterSeq, plan, name = COMMAND_NAME, expectedArgs = undefined) {
      const tracked = new Set();
      let outcome;
      for (const event of events) {
        if (!Number.isSafeInteger(event.seq) || event.seq <= afterSeq) continue;
        const data = isRecord(event.data) ? event.data : undefined;
        if (event.type === 'command/run') {
          if (data?.name !== name) continue;
          if (typeof data.args !== 'string' || data.args.includes('--plan') !== plan) continue;
          if (expectedArgs !== undefined && !sameArguments(data.args, expectedArgs, name)) continue;
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
    function waitForCommand(owner, afterSeq, plan, timeoutMs, name = COMMAND_NAME, expectedArgs = undefined) {
      return new Promise((resolve) => {
        const source = journalOf(owner);
        if (typeof source?.subscribe !== 'function') {
          resolve(undefined);
          return;
        }
        // 这两个变量必须在 `finish` 之前声明：`subscribe` 可能同步回调
        // 监听器，那时 `finish` 会立刻读到它们。用 `const` 声明在后面
        // 会撞上暂时性死区，把一个普通的 store 变成永不 settle 的 Promise。
        let unsubscribe;
        let timer;
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          unsubscribe?.();
          resolve(value);
        };
        const scan = () => {
          const outcome = commandOutcome(journalEvents(owner), afterSeq, plan, name, expectedArgs);
          if (outcome !== undefined) finish(outcome);
        };
        unsubscribe = source.subscribe(scan);
        timer = setTimeout(() => finish(undefined), timeoutMs);
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
     * @returns `{kind, text}` 报告：
     *   - `success`：宿主回报了计划，`text` 是它的原文；
     *   - `error`：宿主拒绝了这个计划，`text` 是它的理由；
     *   - `unavailable`：宿主没有这条命令的处理者；
     *   - `unreachable`：没有会话能承载这条命令；
     *   - `no-report`：宿主认领了命令，却没有在期限内回报。
     */
    async function requestPlan(sessionId, line, name = COMMAND_NAME) {
      const outcome = await withSession(sessionId, async (session) => {
        if (typeof session?.command !== 'function') return { kind: 'unreachable' };
        const after = lastSeqOf(session);
        // 等待在该行发出之前就已布好，所以立即作答的宿主
        // 也不会被错过。
        const waiting = waitForCommand(session, after, true, PLAN_TIMEOUT_MS, name, argumentsOf(line));
        const admission = await session.command(line).catch(() => undefined);
        // 准入判定先行，并立即作答：为一条没有处理者认领的行把日志窗口
        // 等完，只会掩盖真正的原因。
        if (admission?.ok !== true) return { kind: 'unreachable' };
        if (admission.value?.matched !== true) return { kind: 'unavailable' };
        // 宿主认领了这条命令，却没有在期限内回报：这是"没有报告"，
        // 与"没有处理者"是两件不同的事，必须能被区分开 —— 前者可以
        // 重试，后者要重启宿主。
        const report = await waiting;
        return report === undefined ? { kind: 'no-report' } : report;
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
        if (Number.isSafeInteger(turn) && turn > 0) return turn;
        // 这一条节点没有可用的轮次：继续找下一条同源的节点，而不是
        // 就此放弃 —— 同一个 source 可能对应多个节点。
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
     * @param unavailableText - 没有处理者认领该行时的文案。
     * @returns `{status: 'done'|'submitted'|'failed'|'unavailable', text}`，
     *   其中 `text` 是宿主报告；`unavailable` 表示没有处理者认领该行，
     *   `submitted` 表示宿主接受了该行但还没回报结果。
     */
    async function runCommand(sessionId, line, name = COMMAND_NAME, unavailableText = undefined) {
      const outcome = await withSession(sessionId, async (session) => {
        if (typeof session?.command !== 'function') return undefined;
        const after = lastSeqOf(session);
        const waiting = waitForCommand(session, after, false, EXECUTE_TIMEOUT_MS, name, argumentsOf(line));
        const admission = await session.command(line).catch(() => undefined);
        // 没有处理者认领的行会立即得到答复；只有被认领的行
        // 才值得把日志窗口等完。
        if (admission?.ok !== true || admission.value?.matched !== true) {
          return { status: 'unavailable', text: unavailableText };
        }
        const report = await waiting;
        if (report !== undefined && report.kind === 'error') return { status: 'failed', text: report.text };
        // 没有报告意味着等待超时：宿主接受了该行且仍在工作。报成
        // "失败"会误导，报成"已完成"同样不诚实 —— 所以单列一个
        // "已提交"的状态，用户可以自己去核对工作区。
        if (report === undefined) return { status: 'submitted', text: undefined };
        return { status: 'done', text: report.text };
      });
      return outcome ?? { status: 'unavailable', text: unavailableText };
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
        [props.onCancel],
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
     * 一个撤回控件的按钮。两个入口共用它，只有样式类、标题词条与
     * 状态词条前缀不同。
     *
     * 失败态没有具体文案时，标题退回 `failureTitleKey`；调用方不传时
     * 就沿用 `titleKey`（轮次入口正是这种情况，两处词条本来就一样）。
     * @param props - 状态、失败文案、样式类、词条与点击回调。
     * @returns 那个按钮。
     */
    function RevertButton(props) {
      const { state, failure, className, titleKey, failureTitleKey = titleKey, labelPrefix, translate, onClick } = props;
      return h(
        'button',
        {
          type: 'button',
          className,
          title: state === 'failed' ? (failure ?? translate(failureTitleKey)) : translate(titleKey),
          'aria-label': translate(titleKey),
          disabled: state === 'busy' || state === 'planning',
          onClick,
        },
        labelOf(state, labelPrefix, translate),
      );
    }

    /**
     * 撤回的确认卡片。两个入口共用它，只有标题词条不同。
     * @param props - 状态、计划文本、拒绝标志、标题词条与两个回调。
     * @returns 卡片；还没到确认那一步时为 null。
     */
    function RevertConfirmDialog(props) {
      const { state, plan, refused, titleKey, translate, onCancel, onConfirm } = props;
      if (state !== 'confirm') return null;
      return h(ConfirmDialog, {
        title: translate(titleKey),
        body: plan ?? translate('dialog.fallback'),
        confirmLabel: translate('dialog.confirm'),
        cancelLabel: translate(refused ? 'dialog.close' : 'dialog.cancel'),
        confirmHidden: refused,
        onCancel,
        onConfirm,
      });
    }

    /**
     * 一次不可确认的结局该用哪句话解释。
     * @param {any} report - 宿主的计划报告。
     * @returns {string} 词条 key。
     */
    function refusalKeyOf(report) {
      if (report?.kind === 'unavailable') return 'dialog.noCommand';
      if (report?.kind === 'unreachable') return 'dialog.noCarrier';
      return 'dialog.noHost';
    }

    /**
     * 一个撤回控件的状态机：询问宿主会改变什么，展示那份计划，
     * 然后才执行。状态依次为 idle → planning → confirm → busy →
     * done | failed，取消则回到 idle。
     *
     * 只有宿主**真正回报了计划**（`kind: 'success'`）才会武装确认按钮。
     * 宿主的拒绝、没有处理者、没有承载会话、认领了却没回报 —— 这些
     * 结局里没有一份可以照着做的清单，卡片因此只留「关闭」：撤回是
     * 不可逆的，不能在用户没看到预览的情况下执行。
     * @param sessionId - 所属会话。
     * @param line - 要执行的 `/revert` 命令行。
     * @param refusalText - 把一次不可确认的结局翻译成一句话。
     * @returns 状态、计划文本、拒绝标志，以及各个回调。
     */
    function useRevertAction(sessionId, line, refusalText) {
      // 预览就是同一条命令加上 `--plan`，所以它由 `line` 决定，
      // 不必让每个调用点各推一遍。
      const planLine = line === undefined ? undefined : `${line} --plan`;
      const [state, setState] = React.useState('idle');
      const [plan, setPlan] = React.useState(undefined);
      const [refused, setRefused] = React.useState(false);
      const [failure, setFailure] = React.useState(undefined);
      const mounted = React.useRef(true);
      // StrictMode 会 mount → cleanup → mount。cleanup 把这个标志置为
      // false 之后必须重新置回 true，否则之后的每一次 settle 都成了
      // 空操作，按钮永远停在「检查中…」。
      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);
      // 请求令牌：一次预览在途时 props 可能已经变了（审查面板切到另一个
      // 文件、该行的轮次变化），旧响应不能盖到新的目标上。
      const token = React.useRef(0);
      const settle = React.useCallback((next, detail) => {
        if (!mounted.current) return;
        setFailure(detail);
        setState(next);
      }, []);
      const run = React.useCallback(() => {
        if (line === undefined || sessionId === undefined) return;
        setFailure(undefined);
        setRefused(false);
        setState('planning');
        const mine = (token.current += 1);
        requestPlan(sessionId, planLine).then(
          (report) => {
            if (!mounted.current || token.current !== mine) return;
            const answered = report !== undefined && report.kind === 'success';
            // 宿主的拒绝带它自己的理由；其余结局用一句话说明为什么
            // 不能确认。
            setPlan(answered ? report.text : report.kind === 'error' ? report.text : refusalText(report));
            setRefused(!answered);
            setState('confirm');
          },
          () => settle('failed'),
        );
      }, [line, sessionId, settle, refusalText]);
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
        runCommand(sessionId, line, COMMAND_NAME, refusalText({ kind: 'unavailable' })).then((outcome) =>
          settle(
            outcome.status === 'done' ? 'done' : outcome.status === 'submitted' ? 'submitted' : 'failed',
            outcome.text,
          ),
        );
      }, [line, sessionId, settle, refusalText]);
      return { state, plan, refused, failure, run, cancel, confirm };
    }

    /** 某个控件状态的标签。 */
    function labelOf(state, prefix, translate) {
      if (state === 'planning') return translate(`${prefix}.checking`);
      if (state === 'busy') return translate(`${prefix}.reverting`);
      if (state === 'submitted') return translate(`${prefix}.submitted`);
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
     * 读取这一行所属轮次的聊天快照。
     *
     * `useChat` 是座位契约的标准 props，所以它在整个生命周期里都在。
     * 这个 hook 始终被调用 —— 条件式调用会违反 React 的 hook 数量
     * 规则：一旦这个 props 在两次渲染之间出现或消失，React 就会抛出
     * "渲染的 hook 数量变少了"。
     * @param {any} useChat - 座位提供的聊天快照读取器。
     * @param {(snapshot: any) => number|undefined} select - 选择器。
     * @returns {number|undefined} 轮次号；读不到时为 undefined。
     */
    function useTurnNumber(useChat, select) {
      const [fallback] = React.useState(undefined);
      if (typeof useChat !== 'function') return fallback;
      return useChat(select);
    }

    /**
     * 单个用户消息行的撤回控件。所属座位渲染在气泡之前，
     * 所以该控件被传送到该行自己的操作条里，
     * 已有控件之后；找不到操作条的行则保留
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
      const turn = useTurnNumber(useChat, select);
      const line = Number.isSafeInteger(turn) && turn > 0 ? `/revert --turn ${turn}` : undefined;
      const refusalText = React.useCallback((report) => translate(refusalKeyOf(report)), [translate]);
      const { state, plan, refused, failure, run, cancel, confirm } = useRevertAction(sessionId, line, refusalText);
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

      if (!active) return null;

      const button = h(RevertButton, {
        state,
        failure,
        className: host === null ? undefined : 'dshrvact',
        titleKey: 'action.title',
        labelPrefix: 'action',
        translate,
        onClick: run,
      });
      const dialog = h(RevertConfirmDialog, {
        state,
        plan,
        refused,
        titleKey: 'dialog.turn.title',
        translate,
        onCancel: cancel,
        onConfirm: confirm,
      });

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
      // 宿主按 `/^(0|[1-9][0-9]*)$/` 解析坐标。`Number()` 还会接受
      // `1e3`、`0x10`、`+5` —— 那会把一条无效的坐标变成另一个数字，
      // 于是撤回的是另一个文件。
      const coordinate = (raw) => {
        if (!/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
        const parsed = Number(raw);
        return Number.isSafeInteger(parsed) ? parsed : undefined;
      };
      const seq = coordinate(rawSeq);
      const index = coordinate(rawIndex);
      if (seq === undefined || index === undefined) return null;
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
      const refusalText = React.useCallback((report) => translate(refusalKeyOf(report)), [translate]);
      const { state, plan, refused, failure, run, cancel, confirm } = useRevertAction(
        coordinates?.sessionId,
        line,
        refusalText,
      );

      if (coordinates === null) return null;

      return h(
        React.Fragment,
        null,
        h(RevertButton, {
          state,
          failure,
          className: 'dshrvfile',
          titleKey: 'file.title',
          failureTitleKey: 'action.failed',
          labelPrefix: 'action',
          translate,
          onClick: run,
        }),
        h(RevertConfirmDialog, {
          state,
          plan,
          refused,
          titleKey: 'dialog.file.title',
          translate,
          onCancel: cancel,
          onConfirm: confirm,
        }),
      );
    }

    /**
     * 此刻能够承载一条删除命令的会话。目标自身绝不是
     * 候选者：会话不能删除自己，而在这里打开它反而会
     * 把它实体化 —— 那正是宿主拒绝移除的状态。
     * 宿主已发布其 Agent 的行会被优先选择，因为临时的
     * 空白会话没有可运行该命令的 Agent。
     *
     * 两类行**绝不能**当承载者，否则命令会被宿主原样拒绝，
     * 用户看到的是"没能送进承载会话"：
     * - `origin: 'subagent'` 的行由子 Agent 路由独占，宿主的
     *   `resolveAgent` 对它直接回 `session/agent-busy`，命令
     *   根本到不了处理者；
     * - `blank: true` 的行是还没发过消息的新会话占位，它没有
     *   可运行命令的 Agent，`session.command` 只会得到未认领。
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
      /** 这一行究竟能不能承载命令：子 Agent 行与空白新会话行都不行。 */
      const usable = (id) => {
        const row = isRecord(rows[id]) ? rows[id] : {};
        if (row.origin === 'subagent') return false;
        if (row.blank === true) return false;
        return true;
      };
      const candidates = ids.filter((id) => typeof id === 'string' && id !== targetId && usable(id));
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
      // 没有任何已发布的行能当承载者时，宁可不给承载者（卡片会说
      // "请先打开任意一个其它会话"），也不要把命令发给一个必然被拒的会话。
      return candidates[0];
    }

    /**
     * 列表里除了目标之外是否还有行 —— 哪怕那些行不能承载命令。
     * 用来区分"只有这一个会话"和"有别的会话但没有一个能用"。
     * @param targetId - 即将被移除的会话。
     * @returns 还有其它行时为 true。
     */
    function hasOtherRows(targetId) {
      try {
        const snapshot = sessions?.list?.getSnapshot?.();
        const ids = Array.isArray(snapshot?.ids) ? snapshot.ids : [];
        return ids.some((id) => typeof id === 'string' && id !== targetId);
      } catch {
        return false;
      }
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
     * 会在用户做出任何承诺之前说明这一点。宿主报告"驻留"时，
     * 卡片改用 `--force` 重新预览：确认控件变成"强制删除"，它先把这个
     * 会话从本次运行中卸载，再删数据。
     * @param props - 覆盖层座位提供的区域设置绑定器。
     * @returns 打开的卡片；没有待处理项时为 null。
     */
    function DeleteSessionDialog(props) {
      const translate = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? key;
      const request = useDeleteRequest();
      const [phase, setPhase] = React.useState('idle');
      const [body, setBody] = React.useState(undefined);
      const [failure, setFailure] = React.useState(undefined);
      const [force, setForce] = React.useState(false);
      const sessionId = request?.sessionId;

      // 每次点击一个请求对象，所以对同一个会话的第二次尝试
      // 会重新检查，而不是展示上一次尝试的卡片。
      React.useEffect(() => {
        const target = deleteRequest?.sessionId;
        if (target === undefined) {
          setPhase('idle');
          return undefined;
        }
        // 命令行按空白切分，所以 id 必须先通过校验才能拼进去 ——
        // 一个异常的 id 不该悄悄改变命令的解析结果。
        if (safeSessionId(target) === undefined) {
          setFailure(translate('delete.badId'));
          setPhase('failed');
          return undefined;
        }
        let live = true;
        setPhase('planning');
        setBody(undefined);
        setFailure(undefined);
        setForce(false);
        const carrier = carrierFor(target);
        if (carrier === undefined) {
          // 没有任何可用行时，最可能是侧边栏只有这一个会话；把原因说清楚，
          // 而不是让用户去猜"打开一个已有对话"指的是哪一个。
          setFailure(translate(hasOtherRows(target) ? 'delete.noCarrier' : 'delete.selfOnly'));
          setPhase('failed');
          return undefined;
        }
        /** 一条得不到检查结果的途径，各自点明原因。 */
        const explain = (report) => {
          if (report === undefined || report.kind === 'no-report') {
            // 宿主认领了命令却没有回报：与"没有处理者"不同，
            // 重试一次通常就够了。
            setFailure(translate('delete.noHost'));
            setPhase('failed');
            return true;
          }
          if (report.kind === 'unavailable') {
            setFailure(translate('delete.unavailable'));
            setPhase('failed');
            return true;
          }
          if (report.kind === 'unreachable') {
            // 承载会话存在，但宿主没让命令到达处理者：多半是那个会话
            // 还没有可用的 Agent（刚创建、从未发过消息）。
            setFailure(translate('delete.refusedByCarrier'));
            setPhase('failed');
            return true;
          }
          return false;
        };
        const show = (report, forced) => {
          const title = typeof deleteRequest?.displayTitle === 'string' ? deleteRequest.displayTitle : '';
          setBody(`${title === '' ? '' : `会话标题：${title}\n`}${report.text ?? ''}`);
          // 被拒绝的检查会报告 `error`；此时卡片只提供关闭。
          setForce(forced);
          setPhase(report.kind === 'error' ? 'refused' : 'confirm');
        };
        requestPlan(carrier, `/${DELETE_COMMAND_NAME} --id ${target} --plan`, DELETE_COMMAND_NAME).then(
          (report) => {
            if (!live) return;
            if (explain(report)) return;
            // 任何被拒绝的预览都再问一次"强制删除会做什么"：
            // 会话仍驻留时这次会成功，确认控件随之变成"强制删除"；
            // 其它原因（布局不符、目录不在根内）照样被拒绝，
            // 而卡片展示的仍是宿主给出的那条原因。
            if (report.kind !== 'error') {
              show(report, false);
              return;
            }
            requestPlan(
              carrier,
              `/${DELETE_COMMAND_NAME} --id ${target} --plan --force`,
              DELETE_COMMAND_NAME,
            ).then((forced) => {
              if (!live) return;
              if (explain(forced)) return;
              // 强制预览也被拒绝时，真正的原因是普通预览给出的那条
              // （布局不符、目录不在根内……），卡片照旧只留「关闭」。
              show(forced.kind === 'error' ? report : forced, forced.kind !== 'error');
            });
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
        const target = safeSessionId(sessionId);
        if (target === undefined) return;
        const carrier = carrierFor(target);
        if (carrier === undefined) {
          setFailure(translate('delete.noCarrier'));
          setPhase('failed');
          return;
        }
        setPhase('deleting');
        const line = `/${DELETE_COMMAND_NAME} --id ${target}${force ? ' --force' : ''}`;
        runCommand(carrier, line, DELETE_COMMAND_NAME).then((outcome) => {
          if (outcome.status === 'done') {
            settleDeletion();
            resyncSessions();
            return;
          }
          setFailure(outcome.status === 'unavailable' ? translate('delete.unavailable') : outcome.text ?? translate('delete.failed'));
          setPhase('failed');
        });
      }, [sessionId, force, translate]);

      if (request === null || phase === 'idle') return null;

      const refused = phase === 'refused' || phase === 'failed';
      const text =
        phase === 'planning'
          ? translate('delete.planning')
          : phase === 'deleting'
            ? translate(force ? 'delete.forcing' : 'delete.deleting')
            : refusalText(phase, failure, body);

      return h(ConfirmDialog, {
        title: translate(force ? 'delete.forceTitle' : 'delete.title'),
        body: text,
        confirmLabel: translate(force ? 'delete.forceConfirm' : 'delete.confirm'),
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
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'revert-files: dictionaries');
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
