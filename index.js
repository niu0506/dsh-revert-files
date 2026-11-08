/**
 * revert-files 插件的宿主半边 —— 基于 Git 的快照。
 *
 * 追踪工作委托给工作副本自身的 Git 仓库。在
 * 每一个 Agent 轮次开始时，插件把整个工作区快照进
 * 一个 tree 对象，使用仓库 Git 目录下的私有索引，因此
 * 用户真实的索引、HEAD 和分支永远不会被碰。该快照由
 * `refs/dsh/revert-files/<session>/turn-<n>` 固定住，所以 `git gc` 无法
 * 剪掉它。恢复就是对那棵树执行 `git read-tree --reset -u`：工作区
 * 精确回到该轮开始前持有的那些字节，包括那一轮
 * 删除的文件，而那一轮新建的文件会被删除。
 *
 * 由于快照取自工作区而不是取自此
 * 插件自身的写入意图，由 shell 命令造成的改动也被覆盖。
 * 被 Git 忽略的路径在两个方向上都在快照之外：它们
 * 在恢复时既不会被捕获，也不会被删除。
 *
 * 整轮回退还会把对话本身一起滚回。日志是
 * 仅追加的，所以对话不会被删除：一次空的 `user/message`
 * 替换会遮蔽从该轮第一条消息到
 * 表层末尾的每个表层节点，从而把那一轮及其之后的一切从
 * 模型历史中移除。`user/message` 是会话唯一
 * 允许的表层替换，前提是没有打开的轮次 —— `system/message` 和 `developer/message` 必须
 * 与已打开的轮次和步匹配 —— 而回退总是在会话
 * 空闲时运行。空内容不会为模型产生任何文本，而随附的聊天界面
 * 只渲染追加来源的节点，所以该检查点对两者都不可见。
 * 该替换在消息来源中携带被隐藏的轮次范围，
 * 浏览器半边正是据此知道要隐藏哪些记录行。
 *
 * 一次操作，三个调用方：用户消息行的回退控件和
 * 变更审查标签页的按文件控件都通过
 * 命令注册表到达 `executeRequest`，而 `revert_files` 工具调用同一套规划器和
 * 恢复器，只是直接调用。
 */

import crypto from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

/** 本插件缺失就无法工作的服务。 */
export const inject = ['fs', 'tools', 'commands'];

const TOOL_NAME = 'revert_files';
const COMMAND_NAME = 'revert';
const DELETE_COMMAND_NAME = 'delete-session';
/** 存放每个会话轮次一个固定快照的 ref 命名空间。 */
const REF_ROOT = 'refs/dsh/revert-files';

/**
 * 每个子命令之前的参数：不做索引刷新写入、不挂钩子，也不启用
 * 文件系统监视器，因此快照不会被仓库本地的
 * 配置扰动。
 */
const GIT_PREFIX = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/**
 * 清除继承来的仓库、配置和替换 ref 选择器，并
 * 禁用提示和缺失对象的惰性抓取。可选的索引写入
 * 已通过共享前缀里的 `--no-optional-locks` 关闭。
 * 调用方自己的 `GIT_INDEX_FILE` 覆盖在此展开之后应用。
 */
const GIT_ENV = {
  ...Object.fromEntries(
    [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_CONFIG',
      'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_COUNT',
      'GIT_CEILING_DIRECTORIES',
      'GIT_PREFIX',
      'GIT_SHALLOW_FILE',
      'GIT_GRAFT_FILE',
      'GIT_REPLACE_REF_BASE',
      'GIT_ATTR_SOURCE',
    ].map((key) => [key, undefined]),
  ),
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  LC_ALL: 'C',
};

/** 单次 Git 调用保留的最大 stdout/stderr。 */
const MAX_OUTPUT_BYTES = 8 << 20;
/** 单次 Git 调用的墙钟时间上限。 */
const GIT_TIMEOUT_MS = 120_000;
/** 一次 `/revert --list` 所描述的轮次数。 */
const MAX_LISTED_TURNS = 30;
/** 一份报告或预览在汇总其余内容之前列出的改动路径数。 */
const MAX_LISTED_FILES = 20;
/** 一次回滚最多可隐藏的轮次数，作为与浏览器半边共享的失控保护。 */
const MAX_HIDDEN_TURNS = 1000;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} error @returns {string} */
const errorCode = (error) => {
  if (isRecord(error)) {
    const code = error.code;
    if (typeof code === 'string' && code !== '') return code;
    const message = error.message;
    if (typeof message === 'string' && message !== '') return message;
  }
  if (typeof error === 'string' && error !== '') return error;
  return 'failed';
};

/** @param {string} text @returns {string} */
const firstLine = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? 'no diagnostic';

/**
 * 会话 id 的一个 ref/文件组件：可读的截断前缀加上
 * 整个 id 的摘要。这个摘要很重要 —— 把非 ref 字符清理掉会
 * 把不同的 id（`a/b` 和 `a_b`）映射到同一个命名空间，这会让两个
 * 会话共享同一个快照命名空间和同一个私有索引文件。
 */
const refPart = (value) => {
  const id = String(value);
  const readable = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.-]+/, '').slice(0, 24);
  const digest = crypto.createHash('sha1').update(id).digest('hex').slice(0, 16);
  return `${readable === '' ? 'session' : readable}-${digest}`;
};

/**
 * 摘要化之前的组件名。更早的版本固定在其下的快照
 * 仍然可读，因此重新打开的会话不会悄悄丢失它的历史。
 */
const legacyRefPart = (value) => {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.-]+/, '');
  return cleaned === '' ? 'session' : cleaned;
};

/**
 * 把一个会话 id 编码成 JSONL 持久化后端据以推导其会话目录的
 * 单个路径段：`.` 和 `..` 单独处理，
 * 其余所有不在 `[A-Za-z0-9._-]` 内的代码单元 —— 包括 `~` —— 都会变成
 * `~XXXX`。对于本身还不是安全路径段的 id，插件需要同一种拼写
 * 才能认出存储自己的产物目录，而不是
 * 把那个会话当成完全没有产物。
 * @param {unknown} value - 会话 id。
 * @returns {string} 编码后的路径段。
 */
const encodeSegment = (value) => {
  const raw = String(value);
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    out += character !== '~' && /^[A-Za-z0-9._-]$/.test(character) ? character : `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
};

export function apply(ctx) {
  /**
   * @typedef {object} SessionState
   * @property {number} turn 在会话事件中见过的最新轮次。
   * @property {Promise<unknown>} lock 串行化该会话的每一次 Git 接触。
   * @property {Promise<object>|undefined} repoPromise 解析出的仓库坐标。
   * @property {string|undefined} repoCwd `repoPromise` 所针对的工作目录。
   * @property {number} repoGeneration 每当那些坐标被丢弃时递增。
   * @property {Map<number, string>} snapshots 内存中的轮次到快照树映射。
   * @property {Map<number, Promise<string>>} pending 每个轮次进行中的快照。
   * @property {Map<number, number>} turnStarts 轮次到其 `turn/start` 事件 seq 的映射。
   * @property {boolean} running 当前是否有轮次正在进行。
   * @property {number} runningTurn 正在进行的那一轮；0 表示没有。
   * @property {Set<number>} warnedTurns 已经上报过快照失败的轮次。
   * @property {number} lastUndo 最近一次分配的 `undo-<n>` 令牌，单调递增。
   */

  /** @type {Map<string, SessionState>} */
  const states = new Map();

  /** @param {string} sessionId @returns {SessionState} */
  const stateFor = (sessionId) => {
    let state = states.get(sessionId);
    if (state === undefined) {
      state = {
        turn: 0,
        lock: Promise.resolve(),
        repoPromise: undefined,
        repoCwd: undefined,
        repoGeneration: 0,
        snapshots: new Map(),
        pending: new Map(),
        turnStarts: new Map(),
        running: false,
        runningTurn: 0,
        warnedTurns: new Set(),
        lastUndo: 0,
      };
      states.set(sessionId, state);
    }
    return state;
  };

  /**
   * 在已经排入该会话队列的每一次 Git 接触之后运行 `task`。
   * @param {SessionState} state - 每个会话的簿记状态。
   * @param {() => Promise<any>} task - 触碰 Git 的工作。
   * @returns {Promise<any>} 任务自身的结果。
   */
  const withLock = (state, task) => {
    const run = state.lock.then(task, task);
    state.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const sessionIdOf = (actor) => {
    const direct = isRecord(actor) ? actor.agent?.id ?? actor.sessionId : undefined;
    if (typeof direct === 'string' && direct !== '') return direct;
    const initiator = ctx.get('agents')?.currentInitiator?.();
    return typeof initiator?.id === 'string' && initiator.id !== '' ? initiator.id : undefined;
  };

  const cwdOf = (sessionId) => {
    const session = ctx.get('sessions')?.get(sessionId);
    if (session === undefined) return undefined;
    const workingDirectory = ctx.get('workingDirectory');
    try {
      const current = workingDirectory?.get(session);
      if (typeof current === 'string') return current;
    } catch {
      // 回落到 header 的创建目录。
    }
    return session.header?.cwd;
  };

  /**
   * 强制模式的另一个文件系统后端用来围栏一次写入的策略。
   * @param {string} sessionId - 该操作所属的会话。
   * @returns {any} 解析出的单次调用策略；没有该服务时为 undefined。
   */
  const policyFor = (sessionId) => {
    const sandboxPolicy = ctx.get('sandboxPolicy');
    if (sandboxPolicy === undefined) return undefined;
    try {
      const session = ctx.get('sessions')?.get(sessionId);
      return session === undefined ? sandboxPolicy.resolve() : sandboxPolicy.resolve({ session });
    } catch {
      return undefined;
    }
  };

  // ---------------------------------------------------------------------------
  // Git
  // ---------------------------------------------------------------------------

  /** 解析出的 `git` 路径，在本插件实例的整个生命周期内保留。 */
  let gitPath;
  /**
   * 只解析 `git` 一次：该接缝会扫描 PATH 并 stat 每个候选，对于
   * 一次回退要做的十几次调用来说纯属额外开销。
   * @param {any} subprocess - subprocess 服务。
   * @param {AbortSignal} signal - 只取消第一次解析。
   * @returns {Promise<string>} 可执行文件路径。
   */
  const gitExecutable = async (subprocess, signal) => {
    gitPath ??= await subprocess.resolveExecutable('git', undefined, signal);
    return gitPath;
  };

  /**
   * 通过 subprocess 接缝运行一条 Git 命令，并像文件工具那样
   * 受会话沙箱策略的限制。
   * @param {string} sessionId - 所属会话，用于沙箱策略。
   * @param {string[]} args - 共享前缀之后的参数。
   * @param {{cwd?: string, env?: Record<string, string|undefined>}} [options] - 工作目录与环境覆盖。
   * @returns {Promise<{code: number|null, stdout: string, stderr: string}>} 退出情况与收集到的输出。
   */
  const runGit = async (sessionId, args, options = {}) => {
    const subprocess = ctx.get('subprocess');
    if (subprocess === undefined) throw new Error('SUBPROCESS_SERVICE_MISSING');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GIT_TIMEOUT_MS);
    try {
      const executable = await gitExecutable(subprocess, controller.signal);
      const command = [executable, ...GIT_PREFIX, ...args];
      let argv = command;
      const sandbox = ctx.get('sandbox');
      const policy = policyFor(sessionId);
      if (sandbox !== undefined && isRecord(policy) && policy.mode !== undefined && policy.mode !== 'danger-full-access') {
        const confined = await sandbox.confine(command, { ...policy, mode: policy.mode }, controller.signal);
        if (Array.isArray(confined?.argv)) argv = confined.argv;
      }
      const child = subprocess.spawn({
        argv,
        cwd: options.cwd,
        env: { ...GIT_ENV, ...(options.env ?? {}) },
        signal: controller.signal,
        graceMs: 5_000,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: MAX_OUTPUT_BYTES },
          stderr: { maxBytes: MAX_OUTPUT_BYTES },
        },
      });
      try {
        const outcome = await child.done;
        const stdout = child.collected?.stdout?.readFrom(0)?.text ?? '';
        const stderr = child.collected?.stderr?.readFrom(0)?.text ?? '';
        const code = typeof outcome?.exitCode === 'number' ? outcome.exitCode : null;
        return { code, stdout, stderr };
      } finally {
        try {
          child.terminate();
        } catch {
          // 该范围已经是空的。
        }
        try {
          await child.waitForExit();
        } catch {
          // provider 无法证明的静止状态不能掩盖结果。
        }
      }
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * 运行一条必须成功的 Git 命令。
   * @param {string} sessionId - 所属会话。
   * @param {string[]} args - 共享前缀之后的参数。
   * @param {{cwd?: string, env?: Record<string, string|undefined>}} [options] - 工作目录与环境覆盖。
   * @returns {Promise<{code: number|null, stdout: string, stderr: string}>} 成功的结果。
   */
  const gitOk = async (sessionId, args, options = {}) => {
    const result = await runGit(sessionId, args, options);
    if (result.code !== 0) {
      throw new Error(`GIT_${args[0] ?? 'command'}_FAILED: ${firstLine(result.stderr)}`);
    }
    return result;
  };

  /** 解析出该会话工作目录所在的检出。 */
  const discoverRepo = async (sessionId) => {
    const cwd = cwdOf(sessionId);
    if (typeof cwd !== 'string' || cwd === '') throw new Error('NO_WORKING_DIRECTORY');
    const top = await runGit(sessionId, ['rev-parse', '--show-toplevel'], { cwd });
    if (top.code !== 0) throw new Error(`NOT_A_GIT_REPOSITORY: ${firstLine(top.stderr)}`);
    const root = top.stdout.trim();
    if (root === '') throw new Error('NOT_A_GIT_REPOSITORY');
    const dir = await runGit(sessionId, ['rev-parse', '--absolute-git-dir'], { cwd: root });
    if (dir.code !== 0) throw new Error(`NOT_A_GIT_REPOSITORY: ${firstLine(dir.stderr)}`);
    const gitDir = dir.stdout.trim();
    if (gitDir === '') throw new Error('NOT_A_GIT_REPOSITORY');
    return {
      root,
      gitDir,
      // Git 目录内的私有索引：用户自己的索引、HEAD
      // 和分支永远不会被读写。
      index: path.join(gitDir, `dsh-revert-files.index.${refPart(sessionId)}`),
    };
  };

  /**
   * 丢弃某个会话所有以仓库为作用域的缓存。会话的工作
   * 目录可能在会话中途改变 —— `working_directory` 是一个面向模型的
   * 工具 —— 而解析出的根、已固定的树以及进行中的
   * 快照都属于它刚刚离开的那个仓库。在新仓库里恢复来自
   * 旧仓库的树，要么会因陌生对象而失败，要么更糟，
   * 会重写错误的检出。
   * @param {SessionState} state - 每个会话的簿记状态。
   * @returns {void}
   */
  const forgetRepoState = (state) => {
    state.repoGeneration += 1;
    state.repoPromise = undefined;
    state.repoCwd = undefined;
    state.snapshots.clear();
    state.pending.clear();
  };

  /**
   * 某个会话的仓库坐标，每个工作目录解析一次，
   * 一旦该目录移动就重新解析。
   * @param {string} sessionId - 所属会话。
   * @returns {Promise<{root: string, gitDir: string, index: string}>} 解析出的仓库。
   */
  const repoFor = (sessionId) => {
    const state = stateFor(sessionId);
    const cwd = cwdOf(sessionId);
    if (state.repoPromise !== undefined && state.repoCwd !== cwd) forgetRepoState(state);
    if (state.repoPromise === undefined) {
      state.repoCwd = cwd;
      state.repoPromise = discoverRepo(sessionId).catch((error) => {
        // 等工作区存在或成为仓库之后，之后的尝试可能会成功。
        state.repoPromise = undefined;
        throw error;
      });
    }
    return state.repoPromise;
  };

  /** @returns {string} 某一轮已固定的快照 ref。 */
  const refFor = (sessionId, turn) => `${REF_ROOT}/${refPart(sessionId)}/turn-${turn}`;

  /** @returns {string} 摘要化之前组件名下的同一个 ref。 */
  const legacyRefFor = (sessionId, turn) => `${REF_ROOT}/${legacyRefPart(sessionId)}/turn-${turn}`;

  /**
   * 回退前落下的反悔点。它与 `turn-…` 分开命名，因此绝不会被
   * `ensureSnapshot` 当成某一轮的前像，也不会挡住下一轮自己的快照。
   * @returns {string} 某个反悔令牌对应的 ref。
   */
  const undoRefFor = (sessionId, token) => `${REF_ROOT}/${refPart(sessionId)}/undo-${token}`;

  /** 把当前工作区捕获成一个已固定的 tree 对象。 */
  const takeSnapshot = async (sessionId, turn) => {
    const repo = await repoFor(sessionId);
    const generation = stateFor(sessionId).repoGeneration;
    // 一轮的前像一旦固定就是不可变的。重新解析仓库坐标
    // （工作目录在同一个仓库内移动、会话被重新打开、两个调用重叠）
    // 绝不能用一个更晚的状态替换它：那会把"这一轮之前"悄悄变成
    // "这一轮的一部分写入之后"，之后所有回退都会照着错误的前像执行。
    const pinned = await snapshotFor(sessionId, turn);
    if (pinned !== undefined) return pinned;
    const env = { GIT_INDEX_FILE: repo.index };
    await gitOk(sessionId, ['add', '-A', '--', '.'], { cwd: repo.root, env });
    const tree = await gitOk(sessionId, ['write-tree'], { cwd: repo.root, env });
    const sha = tree.stdout.trim();
    if (sha === '') throw new Error('GIT_WRITE_TREE_EMPTY');
    // 用全零旧值做一次 compare-and-swap：ref 已存在时 Git 会拒绝覆盖，
    // 于是并发的第二个快照只能接受先到者，而不是改掉它。
    // 固定这棵树同时也能避免 `git gc` 把它剪掉。
    const created = await runGit(sessionId, ['update-ref', refFor(sessionId, turn), sha, '0'.repeat(sha.length)], {
      cwd: repo.root,
    });
    if (created.code !== 0) {
      const winner = await snapshotFor(sessionId, turn);
      if (winner !== undefined) return winner;
      throw new Error(`GIT_update-ref_FAILED: ${firstLine(created.stderr)}`);
    }
    const state = stateFor(sessionId);
    // 如果在这期间工作目录移动了，这棵树就属于会话
    // 已经离开的那个仓库；把它缓存下来会让之后的回退
    // 拿到一个陌生对象，仿佛它是当前检出的快照。
    if (state.repoGeneration === generation) state.snapshots.set(turn, sha);
    return sha;
  };

  /**
   * 为某一轮做一次工作区快照，只做一次。
   * @param {string} sessionId - 所属会话。
   * @param {number} turn - 即将运行的轮次。
   * @returns {Promise<string>} 快照树。
   */
  const ensureSnapshot = async (sessionId, turn) => {
    const state = stateFor(sessionId);
    const known = state.snapshots.get(turn);
    if (typeof known === 'string') return known;
    let pending = state.pending.get(turn);
    if (pending === undefined) {
      pending = withLock(state, () => takeSnapshot(sessionId, turn));
      state.pending.set(turn, pending);
      // 比较身份：工作目录变化会整体清空 `pending`，
      // 而过期的 promise 不能删掉其替代者所拥有的条目。
      const forget = () => {
        if (state.pending.get(turn) === pending) state.pending.delete(turn);
      };
      pending.then(forget, forget);
    }
    return await pending;
  };

  /**
   * 解析某一轮已固定的快照，优先使用内存缓存。
   * @returns {Promise<string|undefined>} tree-ish；该轮没有快照时为 undefined。
   */
  const snapshotFor = async (sessionId, turn) => {
    const cached = stateFor(sessionId).snapshots.get(turn);
    if (typeof cached === 'string') return cached;
    const repo = await repoFor(sessionId);
    const generation = stateFor(sessionId).repoGeneration;
    for (const ref of [refFor(sessionId, turn), legacyRefFor(sessionId, turn)]) {
      const result = await runGit(sessionId, ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], { cwd: repo.root });
      if (result.code !== 0) continue;
      const sha = result.stdout.trim();
      if (sha === '') continue;
      const state = stateFor(sessionId);
      if (state.repoGeneration === generation) state.snapshots.set(turn, sha);
      return sha;
    }
    return undefined;
  };

  /** 该会话拥有固定快照的每一轮。 */
  const snapshotTurns = async (sessionId) => {
    const repo = await repoFor(sessionId);
    // 每个命名空间一次有界查询：ref 从不被剪除，所以列出整个
    // `REF_ROOT` 会随着每个曾在此运行过的会话增长。
    const turns = new Set();
    for (const prefix of [`${REF_ROOT}/${refPart(sessionId)}/`, `${REF_ROOT}/${legacyRefPart(sessionId)}/`]) {
      const result = await runGit(sessionId, ['for-each-ref', '--format=%(refname)', prefix], { cwd: repo.root });
      if (result.code !== 0) continue;
      for (const line of result.stdout.split(/\r?\n/)) {
        const name = line.trim();
        if (!name.startsWith(prefix)) continue;
        const turn = Number(name.slice(prefix.length).replace(/^turn-/, ''));
        if (Number.isSafeInteger(turn) && turn > 0) turns.add(turn);
      }
    }
    return [...turns].sort((left, right) => left - right);
  };

  /** 让私有索引与工作区保持同步。 */
  const refreshIndex = async (sessionId, repo) => {
    await gitOk(sessionId, ['add', '-A', '--', '.'], { cwd: repo.root, env: { GIT_INDEX_FILE: repo.index } });
  };

  /**
   * 解析 `git diff --name-status -z` 的输出。重命名与复制记录带
   * **两个**路径（`R100\0old\0new\0`），其余状态只带一个 —— 记录长度
   * 必须跟着状态走，按固定二元组配对会把之后每一条记录都读错。
   * @param {string} stdout - NUL 分隔的输出。
   * @returns {Array<{status: string, path: string, from?: string, to?: string}>} 解析后的记录。
   */
  const parseNameStatus = (stdout) => {
    const fields = stdout.split('\u0000');
    const entries = [];
    let index = 0;
    while (index < fields.length) {
      const status = fields[index];
      if (status === '') {
        index += 1;
        continue;
      }
      const letter = status.charAt(0);
      if (letter === 'R' || letter === 'C') {
        const from = fields[index + 1];
        const to = fields[index + 2];
        if (from === undefined || to === undefined || from === '' || to === '') break;
        entries.push({ status: letter, path: to, from, to });
        index += 3;
      } else {
        const file = fields[index + 1];
        if (file === undefined || file === '') break;
        entries.push({ status: letter, path: file });
        index += 2;
      }
    }
    return entries;
  };

  /**
   * 按 Git 自己的分类，哪些工作区路径与某个快照不同。
   * `A` 标记快照中没有的路径（恢复会删除它）；`M` 和
   * `D` 标记恢复会从快照写回的路径。
   *
   * 重命名检测在这里被明确关掉：一次重命名对回退来说是"旧路径写回、
   * 新路径删除"，用户必须在确认卡片上看到这两条，而不是一条被压扁的
   * `R`（它既不是"修改"，也没说明新路径会被删掉）。
   * @param {boolean} [refresh] - 是否先刷新私有索引。
   * @returns {Promise<Array<{status: string, path: string}>>} 改动路径。
   */
  const changedPaths = async (sessionId, repo, tree, refresh = true) => {
    const env = { GIT_INDEX_FILE: repo.index };
    // 私有索引已刷新到工作区，所以 `--cached` 也能看到
    // 未跟踪的新建文件，而工作区 diff 会漏掉它们。
    if (refresh) await refreshIndex(sessionId, repo);
    const result = await gitOk(sessionId, ['diff', '--cached', '--no-renames', '--name-status', '-z', tree], {
      cwd: repo.root,
      env,
    });
    return parseNameStatus(result.stdout);
  };

  /**
   * 当前工作区里，`relPath` 是不是由某个更早的路径重命名而来。
   * 只有 `relPath` 不在快照里时才需要问这个问题，此时它被当作
   * "新增，将删除"是错的：那一轮的语义是"把旧路径挪到这里"。
   * @param {string} sessionId - 所属会话。
   * @param {object} repo - 已解析的仓库。
   * @param {string} tree - 该轮的快照树。
   * @param {string} relPath - 仓库相对路径。
   * @returns {Promise<string|undefined>} 重命名来源，没有时为 undefined。
   */
  const renameSourceOf = async (sessionId, repo, tree, relPath) => {
    const env = { GIT_INDEX_FILE: repo.index };
    // 私有索引可能还停在快照那一刻，那样 diff 里根本不会有这次重命名。
    await refreshIndex(sessionId, repo);
    const result = await runGit(sessionId, ['diff', '--cached', '-M', '--name-status', '-z', tree], {
      cwd: repo.root,
      env,
    });
    if (result.code !== 0) return undefined;
    for (const entry of parseNameStatus(result.stdout)) {
      if (entry.status === 'R' && entry.to === relPath) return entry.from;
    }
    return undefined;
  };

  /**
   * 把当前工作区固定成一个反悔点。此时私有索引已经刷新到工作区，
   * 所以 `write-tree` 得到的就是"这次回退即将覆盖掉的状态"。
   * @param {string} sessionId - 所属会话。
   * @param {object} repo - 已解析的仓库。
   * @returns {Promise<number|undefined>} 反悔令牌；空树时为 undefined。
   */
  const pinUndo = async (sessionId, repo) => {
    const tree = await gitOk(sessionId, ['write-tree'], { cwd: repo.root, env: { GIT_INDEX_FILE: repo.index } });
    const sha = tree.stdout.trim();
    if (sha === '') return undefined;
    const state = stateFor(sessionId);
    // 单调递增，避免同一毫秒内的两次回退共用一个令牌。
    const token = Math.max(Date.now(), state.lastUndo + 1);
    state.lastUndo = token;
    await gitOk(sessionId, ['update-ref', undoRefFor(sessionId, token), sha], { cwd: repo.root });
    return token;
  };

  /** 解析某个反悔令牌对应的 tree。 */
  const snapshotForUndo = async (sessionId, token) => {
    const repo = await repoFor(sessionId);
    const result = await runGit(sessionId, ['rev-parse', '--verify', '--quiet', `${undoRefFor(sessionId, token)}^{tree}`], {
      cwd: repo.root,
    });
    if (result.code !== 0) return undefined;
    const sha = result.stdout.trim();
    return sha === '' ? undefined : sha;
  };

  /**
   * 把整个工作区恢复到一棵 tree，并在动工作区之前先把
   * "现在"固定成反悔点 —— 那才是这次回退真正覆盖掉的状态。
   * @param {string} sessionId - 所属会话。
   * @param {string} tree - 目标 tree。
   * @returns {Promise<{changed: object[], repo: object, undo: number|undefined}>} 结果。
   */
  const restoreTree = async (sessionId, tree) => {
    const repo = await repoFor(sessionId);
    // 这次调用会刷新私有索引；随后 write-tree 就得到当前工作区的树。
    const changed = await changedPaths(sessionId, repo, tree);
    // 反悔点是尽力而为的：它失败绝不能挡下回退本身。
    const undo = await pinUndo(sessionId, repo).catch(() => undefined);
    const env = { GIT_INDEX_FILE: repo.index };
    // 把刷新后的索引与快照做双向合并：该轮触碰过的每个路径
    // 都会被写回，而该轮新建的路径会被删除。
    await gitOk(sessionId, ['read-tree', '--reset', '-u', tree], { cwd: repo.root, env });
    return { changed, repo, undo };
  };

  /** 把整个工作区恢复到某一轮开始前的快照。 */
  const restoreWorktree = async (sessionId, turn) => {
    const tree = await snapshotFor(sessionId, turn);
    if (tree === undefined) return { error: 'no-snapshot' };
    return restoreTree(sessionId, tree);
  };

  /**
   * 只从某一棵快照树恢复指定的工作区路径。
   * @param {string} sessionId - 所属会话。
   * @param {string} tree - 持有改动前字节的快照树。
   * @param {Array<{relPath: string, displayPath: string, remove: () => Promise<void>}>} items - 解析出的目标。
   * @returns {Promise<{reverted: object[], skipped: object[]}>} 每个路径的结果。
   */
  const restorePaths = async (sessionId, tree, items) => {
    const repo = await repoFor(sessionId);
    const scratch = { GIT_INDEX_FILE: `${repo.index}.one` };
    await gitOk(sessionId, ['read-tree', tree], { cwd: repo.root, env: scratch });
    const reverted = [];
    const skipped = [];
    for (const item of items) {
      try {
        const present = await runGit(sessionId, ['cat-file', '-e', `${tree}:${item.relPath}`], { cwd: repo.root });
        if (present.code === 0) {
          // 二进制安全：blob 直接写入文件，绝不经过文本。
          await gitOk(sessionId, ['checkout-index', '-f', '--', item.relPath], { cwd: repo.root, env: scratch });
          reverted.push({ path: item.displayPath, action: 'restored' });
        } else {
          await item.remove();
          reverted.push({ path: item.displayPath, action: 'deleted' });
        }
      } catch (error) {
        skipped.push({ path: item.displayPath, reason: errorCode(error) });
      }
    }
    return { reverted, skipped };
  };

  // ---------------------------------------------------------------------------
  // 对话回滚
  // ---------------------------------------------------------------------------

  /** 标记一个对话回滚检查点的消息来源 kind。 */
  const CONVERSATION_SOURCE_KIND = 'revert-files';

  /**
   * 某一轮的 `turn/start` seq：本进程看到过该轮时取自实时事件流，
   * 否则取自重新打开的会话自己的日志。
   * @param {string} sessionId - 所属会话。
   * @param {any} session - 实时会话。
   * @param {number} turn - 要定位的轮次。
   * @returns {number|undefined} 边界 seq；未知时为 undefined。
   */
  const turnStartSeq = (sessionId, session, turn) => {
    const tracked = stateFor(sessionId).turnStarts.get(turn);
    if (typeof tracked === 'number') return tracked;
    if (typeof session.snapshotEvents !== 'function') return undefined;
    try {
      for (const event of session.snapshotEvents()) {
        if (event?.type === 'turn/start' && event?.data?.turn === turn && typeof event?.seq === 'number') return event.seq;
      }
    } catch {
      // 日志不可读会使该轮无法解析；由调用方报告。
    }
    return undefined;
  };

  /**
   * 读取会话日志中的一个事件，不需要异步读取器。
   * @param {any} session - 实时会话。
   * @param {number} seq - 该事件在日志中的位置。
   * @returns {any} 该事件；日志无法读取时为 undefined。
   */
  const eventAtSeq = (session, seq) => {
    try {
      if (typeof session.eventAt === 'function') return session.eventAt(seq);
    } catch {
      // 回落到快照读取器。
    }
    try {
      // 按 seq 匹配：`snapshotEvents()` 目前恰好返回整个日志，
      // 但它的下标是位置，不是序列号。
      if (typeof session.snapshotEvents === 'function') {
        const events = session.snapshotEvents();
        return Array.isArray(events) ? events.find((candidate) => candidate?.seq === seq) : undefined;
      }
    } catch {
      // 日志不可读时，调用方会报告为没有变化。
    }
    return undefined;
  };

  /**
   * 落下一个对话回滚检查点的事件类型。在没有打开的轮次时，表层
   * 替换只能是 `user/message`：当前的
   * 会话格式要求每个 `system/message`、`developer/message` 和
   * `assistant/attempt` 都与已打开的轮次和步匹配，而回退是在
   * 会话空闲时运行的。消息体本身就是检查点，所以是它的
   * source —— 而不是 `data.message.source` —— 携带被隐藏的轮次范围。
   */
  const CONVERSATION_EVENT_TYPE = 'user/message';

  /**
   * 某个表层替换的回滚来源；对任何其他事件为 undefined。
   * 旧版 `developer/message` 检查点仍会被识别，因此更早版本
   * 写出的日志仍然会隐藏它的记录行。
   * @param {any} event - 一个已加载的会话事件。
   * @returns {Record<string, unknown>|undefined} 携带 `from`/`to` 的来源。
   */
  const checkpointSource = (event) => {
    if (!isRecord(event?.surfaceOp) || event.surfaceOp.op !== 'replace') return undefined;
    const source = event.type === CONVERSATION_EVENT_TYPE ? event.data?.source : event.data?.message?.source;
    if (!isRecord(source) || source.kind !== CONVERSATION_SOURCE_KIND) return undefined;
    return source;
  };

  /** 某个表层节点是否是覆盖 `turn` 的回滚检查点。 */
  const coversTurn = (event, turn) => {
    const source = checkpointSource(event);
    if (source === undefined) return false;
    return Number.isSafeInteger(source.from) && Number.isSafeInteger(source.to) && source.from <= turn && turn <= source.to;
  };

  /**
   * 把对话本身滚回，而不只是文件。日志是
   * 仅追加的，所以这里追加一次空的 `user/message` 替换，
   * 它会遮蔽从 `turn` 开始到表层末尾的每个表层节点：
   * 模型不再看到那一轮及其之后的任何内容，而
   * 记录仍保留其持久来源材料。在没有打开轮次时，只有 `user/message` 可以
   * 替换一段表层，而回退正是在这种状态下运行；
   * 它的空内容不携带任何文本，provider 适配器会丢掉
   * 空节点。该替换的
   * 消息来源为浏览器半边携带被隐藏的轮次范围。
   * @see CONVERSATION_EVENT_TYPE
   * @param {string} sessionId - 所属会话。
   * @param {number} turn - 要隐藏的第一个轮次。
   * @returns {Promise<object>} 发生了什么，供报告使用。
   */
  const revertConversation = async (sessionId, turn) => {
    const session = ctx.get('sessions')?.get(sessionId);
    if (session === undefined || typeof session.append !== 'function') return { kind: 'unavailable' };
    const state = stateFor(sessionId);
    if (state.running) return { kind: 'busy' };
    const nodes = Array.isArray(session.surface?.nodes) ? [...session.surface.nodes] : [];
    if (nodes.length === 0) return { kind: 'empty' };
    // 表层的尾部是本插件自己更早的检查点，它
    // 已经移除了这一轮：第二次替换只会再遮蔽它一次。
    if (coversTurn(eventAtSeq(session, nodes[nodes.length - 1]), turn)) return { kind: 'already' };
    const boundary = turnStartSeq(sessionId, session, turn);
    if (boundary === undefined) return { kind: 'unknown' };
    let startIndex = nodes.findIndex((seq) => seq >= boundary);
    // 边界处及其之后没有幸存的表层节点：更早的一次回退
    // 已经遮蔽了这一轮。
    if (startIndex === -1) return { kind: 'already' };
    // 只有当节点 0 确实承载系统提示词时才保护它：
    // 该格式只允许对那个节点做 `system/message` 替换，而一轮自己的
    // 内容从不需要它。任何其他节点 0 都属于这一轮（其 seq
    // 在边界处或之后），必须和其余节点一起被遮蔽。
    if (startIndex === 0 && eventAtSeq(session, nodes[0])?.type === 'system/message') {
      // 对节点 0 的替换本身必须是对那个节点的 `system/message`，
      // 那样什么也隐藏不了：没有别的节点时，
      // 表层上已经没有该轮的内容可供遮蔽。
      if (nodes.length === 1) return { kind: 'already' };
      startIndex = 1;
    }
    const shadowed = nodes.slice(startIndex);
    // 浏览器半边需要最后一个被隐藏的轮次来隐藏同样的记录
    // 行；已固定的快照轮次是对话进展到哪里的持久记录。
    // 手动折叠可以避免拥有极多固定 ref 的会话
    // 撑爆一次展开调用。
    const turns = await snapshotTurns(sessionId).catch(() => []);
    let latest = Math.max(turn, state.turn);
    for (const pinned of turns) if (pinned > latest) latest = pinned;
    const to = Math.min(latest, turn + MAX_HIDDEN_TURNS - 1);
    try {
      session.append(
        CONVERSATION_EVENT_TYPE,
        {
          // 用户消息本身就是消息体：id、role、content 和 source 位于
          // 顶层，而不是 `message` 之下。
          id: `revert-files-${refPart(sessionId)}-${turn}-${Date.now()}`,
          role: 'user',
          content: [],
          source: { kind: CONVERSATION_SOURCE_KIND, from: turn, to },
        },
        {
          surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] },
          // 每个被遮蔽的节点都必须被引用；边界节点说明了原因。
          sourceEventSeqs: [...new Set([...shadowed, boundary])].sort((left, right) => left - right),
        },
      );
    } catch (error) {
      return { kind: 'failed', reason: errorCode(error) };
    }
    return { kind: 'reverted', from: turn, to };
  };

  /** 回退中对话那部分的一行报告（如果有的话）。 */
  const reportConversation = (conversation) => {
    switch (conversation?.kind) {
      case 'reverted':
        return `已撤回对话内容：第 ${conversation.from}–${conversation.to} 轮的对话已从模型历史中移除，聊天里的这些消息也已隐藏（日志只追加，这一步无法撤销）。`;
      case 'already':
        return '对话内容此前已经撤回。';
      case 'unknown':
        return '无法在对话中定位这一轮，本次只恢复了文件。';
      case 'busy':
        return '会话正在运行，本次只恢复了文件。';
      case 'failed':
        return `对话内容未能撤回：${conversation.reason}`;
      default:
        return undefined;
    }
  };

  // ---------------------------------------------------------------------------
  // 会话事件
  // ---------------------------------------------------------------------------

  const handleSessionEvent = (session, event) => {
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const state = stateFor(sessionId);
    const turn = event?.data?.turn;
    const validTurn = typeof turn === 'number' && Number.isSafeInteger(turn) && turn > 0;
    if (validTurn) {
      if (turn > state.turn) state.turn = turn;
      if (event.type === 'turn/start' && typeof event.seq === 'number') state.turnStarts.set(turn, event.seq);
    }
    if (event?.type === 'turn/start') {
      state.running = true;
      if (validTurn) state.runningTurn = turn;
    } else if (event?.type === 'turn/end') {
      // 一个迟到或乱序的 `turn/end` 属于更早的轮次，它不能把仍在
      // 进行中的这一轮判成空闲 —— 那会让对话回退撞上进行中的请求，
      // 而 `revertConversation` 的 `busy` 守卫正是为拦住它而存在的。
      if (!validTurn || state.runningTurn === 0 || turn >= state.runningTurn) {
        state.running = false;
        state.runningTurn = 0;
      }
    }
    // 会话自己的工作目录移动了：每个仓库坐标
    // 和每个缓存的树都属于它刚刚离开的检出。
    if (event?.type === 'working-directory/change') forgetRepoState(state);
    if (event?.type !== 'turn/start') return;
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn <= 0) return;
    // 轮次的前像必须在该轮写入任何内容之前存在；
    // 失败只上报一次，绝不干扰该轮。
    ensureSnapshot(sessionId, turn).catch((error) => {
      if (state.warnedTurns.has(turn)) return;
      state.warnedTurns.add(turn);
      ctx.logger?.warn?.(`revert-files: snapshot for turn ${turn} failed: ${errorCode(error)}`);
    });
  };

  ctx.on('session/event', handleSessionEvent);

  /**
   * 搭乘写入路径，让文件工具的第一次写入等待快照。
   *
   * `fs/write-intent`、`fs/edit-intent` 和 `fs/delete-intent` 是单槽位
   * 瀑布流：第一个*返回*的监听器说了算，它
   * 返回的值必须是 `FsWriteIntent`（`{kind}`）或 `undefined`。本插件
   * 只需要等待，所以它必须通过 `next()` 把槽位交还回去，
   * 而不是占用它 —— 在这里返回快照树哈希会被读作一个
   * 意图，并破坏工具的新鲜度守卫。
   * @param {unknown} _target - 解析出的写入目标，未使用。
   * @param {unknown} actor - 不透明的工具执行上下文。
   * @param {() => any} next - 决策链的其余部分。
   * @returns {Promise<any>} 该槽位真正的决策者返回的任何内容。
   */
  const handleFileIntent = async (_target, actor, next) => {
    const sessionId = sessionIdOf(actor);
    if (sessionId !== undefined) {
      const state = stateFor(sessionId);
      if (state.turn > 0) await ensureSnapshot(sessionId, state.turn).catch(() => undefined);
    }
    return typeof next === 'function' ? next() : undefined;
  };

  ctx.on('fs/write-intent', handleFileIntent);
  ctx.on('fs/edit-intent', handleFileIntent);
  ctx.on('fs/delete-intent', handleFileIntent);

  ctx.on('session/disposed', (session) => {
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const state = states.get(sessionId);
    if (state === undefined) return;
    states.delete(sessionId);
    // 已固定的 ref 保留：它们是持久记录，它们所描述的轮次
    // 在会话重新打开后仍可能被回退。
    void state.repoPromise
      ?.then(async (repo) => {
        // 更名之后，摘要化之前的索引名已死：没有东西会读它。
        const retired = path.join(repo.gitDir, `dsh-revert-files.index.${legacyRefPart(sessionId)}`);
        for (const scratch of [repo.index, `${repo.index}.one`, retired]) {
          try {
            const target = await ctx.fs.resolve(scratch, { cwd: repo.root });
            await ctx.fs.deleteFile(target, undefined, undefined, policyFor(sessionId));
          } catch {
            // 遗留的索引是无害的，而且位于 Git 目录内。
          }
        }
      })
      .catch(() => undefined);
  });

  // ---------------------------------------------------------------------------
  // 调用方
  // ---------------------------------------------------------------------------

  /** 把一个 `workspace/changes` 条目解析成其仓库相对路径和轮次。 */
  const targetFromCoordinates = async (sessionId, seq, index) => {
    const changes = ctx.get('workspaceChanges');
    const summary = changes?.summary(sessionId, seq);
    if (summary === undefined) return { error: 'no-recorded-summary' };
    const file = summary.files[index];
    if (file === undefined) return { error: 'no-such-file-index' };
    const repo = await repoFor(sessionId);
    const cwd = typeof summary.cwd === 'string' && summary.cwd !== '' ? summary.cwd : repo.root;
    // Git 针对自己的工作目录解析路径，因此通过符号链接抵达的
    // 工作区（`/var` 与 `/private/var`）仍然能得到
    // `read-tree` 和 `checkout-index` 所使用的仓库相对名称。
    const listed = await runGit(
      sessionId,
      ['ls-files', '--full-name', '-z', '--cached', '--others', '--exclude-standard', '--', file.path],
      { cwd },
    );
    if (listed.code !== 0) {
      // 这里常见的失败是记录器捕获到了仓库之外的路径
      // （比如主目录下的某个临时文件）：
      // 工作区本身是仓库，只是该路径不在其中。
      return { error: /outside repository/i.test(listed.stderr) ? 'outside-repository' : 'not-a-repository' };
    }
    const relPath = listed.stdout.split('\u0000').find((entry) => entry !== '');
    if (relPath === undefined) return { error: 'not-tracked-by-git' };
    const target = await ctx.fs.resolve(path.resolve(cwd, file.path));
    return {
      turn: summary.turn,
      relPath,
      // `display` 是宿主自己面向人类渲染的路径 —— 文件位于工作目录
      // 之外时会呈现为 `../…` 或 `~/…` 形式 ——
      // 而 `path` 始终是持久、可解析的那个。
      displayPath: typeof file.display === 'string' && file.display !== '' ? file.display : file.path,
      target,
    };
  };

  /** 每个调用方传入的都是已校验的正数轮次。 */
  const describeTurn = (turn) => `第 ${turn} 轮`;

  /** 针对无法解析的坐标给出的一份可读报告。 */
  const describeLocateError = (code) => {
    switch (code) {
      case 'outside-repository':
        return '该文件不在当前 Git 仓库内，Git 快照覆盖不到它。';
      case 'no-recorded-summary':
        return '找不到该文件所属的变更记录。';
      case 'no-such-file-index':
        return '该变更记录里没有这个文件下标。';
      case 'not-tracked-by-git':
        return 'Git 不跟踪该路径（可能被 .gitignore 忽略）。';
      default:
        return `无法定位该文件：${code}。`;
    }
  };

  /**
   * 把一个变更审查坐标解析成要恢复的路径，以及
   * 持有其改动前字节的快照。预览和恢复共用
   * 这套逻辑，因此两者以相同方式判断同样的坐标。
   * @param {string} sessionId - 所属会话。
   * @param {number} seq - 其记录列出该文件的事件的 seq。
   * @param {number} index - 该文件在那条记录中的下标。
   * @returns {Promise<{turn: number, relPath: string, displayPath: string, target: string, tree: string, sourceRelPath: string|undefined}|{error: string}>}
   *   目标；或者 `error`，其中是一份可直接返回的报告。
   */
  const locateFile = async (sessionId, seq, index) => {
    const located = await targetFromCoordinates(sessionId, seq, index);
    if (located.error !== undefined) return { error: describeLocateError(located.error) };
    const turn = located.turn;
    if (!Number.isSafeInteger(turn) || turn <= 0) {
      return { error: '该文件所属的轮次未知，无法回退。' };
    }
    const tree = await snapshotFor(sessionId, turn);
    if (tree === undefined) {
      return {
        error: `第 ${turn} 轮没有可用的快照，无法回退。`,
      };
    }
    // 快照里没有这个路径时，它可能是一次重命名的目的地：这一轮的
    // 语义是"把旧路径挪到这里"，所以单文件回退既要写回原文件，
    // 也要删掉这个新路径。只按"新增，将删除"处理会把它删掉，
    // 而原文件永远回不来。
    let sourceRelPath;
    const repo = await repoFor(sessionId);
    const present = await runGit(sessionId, ['cat-file', '-e', `${tree}:${located.relPath}`], { cwd: repo.root });
    if (present.code !== 0) sourceRelPath = await renameSourceOf(sessionId, repo, tree, located.relPath);
    return {
      turn,
      relPath: located.relPath,
      displayPath: located.displayPath,
      target: located.target,
      tree,
      sourceRelPath,
    };
  };

  const describeCounts = (changed) => {
    let modified = 0;
    let added = 0;
    let removed = 0;
    for (const item of changed) {
      if (item.status === 'A') added += 1;
      else if (item.status === 'D') removed += 1;
      else modified += 1;
    }
    if (changed.length === 0) return '工作区与快照一致，没有需要恢复的改动。';
    return `涉及 ${changed.length} 个文件（${modified} 修改 / ${added} 新增将删除 / ${removed} 删除将还原）。`;
  };

  /**
   * 每个改动路径一行 `  path（动作）`，并设上限以让大轮次保持可读。
   * @param {Array<{status: string, path: string}>} changed - Git 分类的路径。
   * @param {'plan'|'done'} mode - 该改动是否仍然待处理。
   * @returns {string[]} 这些行；被截断时带有溢出汇总。
   */
  const describeFileLines = (changed, mode) => {
    const shown = changed.slice(0, MAX_LISTED_FILES);
    const lines = shown.map((item) => {
      const action =
        mode === 'plan'
          ? item.status === 'A'
            ? '新增，将删除'
            : item.status === 'D'
              ? '已删除，将还原'
              : '已修改，将写回原文'
          : item.status === 'A'
            ? '已删除'
            : '已写回原文';
      return `  ${item.path}（${action}）`;
    });
    if (changed.length > shown.length) {
      const rest = changed.length - shown.length;
      lines.push(`  …另有 ${rest} 个文件未列出。`);
    }
    return lines;
  };

  /**
   * 描述一次回退而不实际执行：它会恢复哪些文件，
   * 以及对话会随之一起被滚回。
   * @param {string} sessionId - 所属会话。
   * @param {{turn?: number, seq?: number, index?: number, undo?: number}} request - 解析出的请求。
   * @returns {Promise<{kind: string, text: string}>} 预览。
   */
  const previewRequest = async (sessionId, request) => {
    if (Number.isSafeInteger(request.undo)) {
      const repo = await repoFor(sessionId);
      const tree = await snapshotForUndo(sessionId, request.undo);
      if (tree === undefined) {
        return { kind: 'error', text: `反悔点 ${request.undo} 不存在或已被清理。` };
      }
      const changed = await changedPaths(sessionId, repo, tree);
      const lines = [`反悔会把工作区恢复到反悔点 ${request.undo} 记录的状态：`];
      if (changed.length === 0) lines.push('  工作区与反悔点一致，没有需要恢复的改动。');
      else lines.push(...describeFileLines(changed, 'plan'));
      return { kind: 'success', text: lines.join('\n') };
    }
    if (Number.isSafeInteger(request.seq) && Number.isSafeInteger(request.index)) {
      const located = await locateFile(sessionId, request.seq, request.index);
      if (located.error !== undefined) return { kind: 'error', text: located.error };
      if (typeof located.sourceRelPath === 'string' && located.sourceRelPath !== '') {
        // 一次重命名：把来源写回原文，并删掉当前路径。
        return {
          kind: 'success',
          text: [
            `撤回这个文件会把它退回${describeTurn(located.turn)}开始前的内容：`,
            `  ${located.sourceRelPath}（已删除，将还原）`,
            `  ${located.displayPath}（新增，将删除）`,
            '  这是一次重命名：回退会恢复原文件并删除当前路径。',
          ].join('\n'),
        };
      }
      const repo = await repoFor(sessionId);
      // 快照中没有的路径会被删除，而不是写回。
      const present = await runGit(sessionId, ['cat-file', '-e', `${located.tree}:${located.relPath}`], { cwd: repo.root });
      const action = present.code === 0 ? '已修改，将写回原文' : '新增，将删除';
      return {
        kind: 'success',
        text: [
          `撤回这个文件会把它退回${describeTurn(located.turn)}开始前的内容：`,
          `  ${located.displayPath}（${action}）`,
        ].join('\n'),
      };
    }

    const state = stateFor(sessionId);
    const wanted = Number.isSafeInteger(request.turn) && request.turn > 0 ? request.turn : state.turn > 0 ? state.turn : undefined;
    const turns = await snapshotTurns(sessionId);
    const resolved = wanted ?? turns.at(-1);
    if (resolved === undefined) {
      return {
        kind: 'error',
        text: '没有可用的快照。快照在每一轮开始时建立，只有文件工具之外、由 shell 命令造成的改动也包含在其中。',
      };
    }
    const repo = await repoFor(sessionId);
    const tree = await snapshotFor(sessionId, resolved);
    if (tree === undefined) {
      return {
        kind: 'error',
        text: `第 ${resolved} 轮没有可用的快照，无法回退。`,
      };
    }
    const changed = await changedPaths(sessionId, repo, tree);
    const lines = [];
    if (changed.length === 0) {
      lines.push(`${describeTurn(resolved)}没有需要恢复的文件改动。`);
    } else {
      lines.push(`撤回会把这些文件退回${describeTurn(resolved)}开始前的状态：`);
      lines.push(...describeFileLines(changed, 'plan'));
    }
    lines.push('同时会撤回这一轮开始的对话内容，且这一步不可撤销。');
    return { kind: 'success', text: lines.join('\n') };
  };

  const listSnapshots = async (sessionId) => {
    let repo;
    try {
      repo = await repoFor(sessionId);
    } catch (error) {
      const reason = errorCode(error);
      return reason.startsWith('NOT_A_GIT_REPOSITORY')
        ? '当前工作区不是 Git 仓库，无法使用基于 Git 的文件追踪。'
        : `无法使用 Git：${reason}。`;
    }
    const turns = await snapshotTurns(sessionId);
    if (turns.length === 0) {
      return '本次会话还没有任何快照。快照在每一轮开始时建立，所以至少需要完成一轮对话。';
    }
    const shown = turns.slice(-MAX_LISTED_TURNS);
    const lines = [`仓库 ${repo.root}`];
    // 一次索引刷新覆盖整份报告：下面每次比较都只是
    // 把它读回来，而过期的索引会让每个汇总出错。
    let refreshError;
    try {
      await refreshIndex(sessionId, repo);
    } catch (error) {
      refreshError = errorCode(error);
    }
    for (const turn of shown) {
      const tree = await snapshotFor(sessionId, turn);
      if (tree === undefined) continue;
      let summary;
      if (refreshError !== undefined) {
        summary = `无法比较：${refreshError}`;
      } else {
        try {
          summary = describeCounts(await changedPaths(sessionId, repo, tree, false));
        } catch (error) {
          summary = `无法比较：${errorCode(error)}`;
        }
      }
      lines.push(`${describeTurn(turn)} · ${tree.slice(0, 12)} — ${summary}`);
    }
    if (turns.length > shown.length) {
      const hidden = turns.length - shown.length;
      lines.push(`…另有 ${hidden} 个更早的快照未列出。`);
    }
    return lines.join('\n');
  };

  const reportRestore = (turn, result, conversation) => {
    const counts = describeCounts(result.changed);
    const lines = [
      `已把工作区恢复到${describeTurn(turn)}开始前的状态（仓库 ${result.repo.root}）。`,
      `  ${counts}`,
    ];
    if (result.changed.length > 0) lines.push(...describeFileLines(result.changed, 'done'));
    const conversationLine = reportConversation(conversation);
    if (conversationLine !== undefined) lines.push(`  ${conversationLine}`);
    if (result.undo !== undefined) {
      // 反悔点保存的是这次回退刚刚覆盖掉的状态 —— 它不是任何一轮的
      // 前像，所以不能用 `--turn N+1` 去近似（那一轮之后的改动不在其中）。
      const rolledBack = conversation?.kind === 'reverted';
      lines.push(
        rolledBack
          ? `  文件反悔：/revert --undo ${result.undo} 可以把文件恢复到这次回退之前，但对话回退无法撤销。`
          : `  反悔：/revert --undo ${result.undo} 可以恢复到这次回退之前的状态。`,
      );
    }
    return lines.join('\n');
  };

  const reportPaths = (turn, result) => {
    const parts = [];
    parts.push(`已从${describeTurn(turn)}的快照恢复 ${result.reverted.length} 个文件。`);
    for (const item of result.reverted) parts.push(`  ${item.path}（${item.action === 'deleted' ? '已删除' : '已写回原文'}）`);
    if (result.skipped.length > 0) {
      parts.push(`跳过 ${result.skipped.length} 个文件：`);
      for (const item of result.skipped) parts.push(`  ${item.path}（${item.reason}）`);
    }
    return parts.join('\n');
  };

  /** 对某一轮、或对有快照的最新一轮做整个工作区的恢复。 */
  const runForTurn = async (sessionId, turn) => {
    const state = stateFor(sessionId);
    const wanted = Number.isSafeInteger(turn) && turn > 0 ? turn : state.turn > 0 ? state.turn : undefined;
    const resolved = wanted ?? (await snapshotTurns(sessionId)).at(-1);
    if (resolved === undefined) {
      return {
        kind: 'error',
        text: '没有可用的快照。快照在每一轮开始时建立，只有文件工具之外、由 shell 命令造成的改动也包含在其中。',
      };
    }
    const result = await restoreWorktree(sessionId, resolved);
    if (result.error !== undefined) {
      return {
        kind: 'error',
        text: `第 ${resolved} 轮没有可用的快照，无法回退。`,
      };
    }
    const conversation = await revertConversation(sessionId, resolved);
    return { kind: 'success', text: reportRestore(resolved, result, conversation) };
  };

  /** 从一个反悔点恢复整个工作区；它只碰文件，不碰对话。 */
  const runForUndo = async (sessionId, token) => {
    const tree = await snapshotForUndo(sessionId, token);
    if (tree === undefined) {
      return { kind: 'error', text: `反悔点 ${token} 不存在或已被清理，没有恢复任何文件。` };
    }
    const result = await restoreTree(sessionId, tree);
    const lines = [
      `已把工作区恢复到反悔点 ${token} 记录的状态（仓库 ${result.repo.root}）。`,
      `  ${describeCounts(result.changed)}`,
    ];
    if (result.changed.length > 0) lines.push(...describeFileLines(result.changed, 'done'));
    if (result.undo !== undefined) {
      lines.push(`  反悔：/revert --undo ${result.undo} 可以恢复到这次回退之前的状态。`);
    }
    return { kind: 'success', text: lines.join('\n') };
  };

  /** 从某一轮的快照树做按路径恢复。 */
  const runForCoordinates = async (sessionId, seq, index) => {
    const located = await locateFile(sessionId, seq, index);
    if (located.error !== undefined) return { kind: 'error', text: located.error };
    const repo = await repoFor(sessionId);
    const items = [];
    if (typeof located.sourceRelPath === 'string' && located.sourceRelPath !== '') {
      // 重命名的来源：快照里有它，`restorePaths` 会把它写回原路径。
      items.push({
        relPath: located.sourceRelPath,
        displayPath: located.sourceRelPath,
        remove: async () => {
          const target = await ctx.fs.resolve(path.resolve(repo.root, located.sourceRelPath));
          await ctx.fs.deleteFile(target, undefined, undefined, policyFor(sessionId));
        },
      });
    }
    items.push({
      relPath: located.relPath,
      displayPath: located.displayPath,
      remove: async () => {
        await ctx.fs.deleteFile(located.target, undefined, undefined, policyFor(sessionId));
      },
    });
    const result = await restorePaths(sessionId, located.tree, items);
    const text = reportPaths(located.turn, result);
    return { kind: result.reverted.length > 0 ? 'success' : 'error', text };
  };

  /**
   * 在该会话的 Git 锁下应答一个请求。计划、列表和
   * 恢复共用同一个私有索引和同一个临时索引，所以重叠的
   * 请求会让它们的 `add`/`read-tree`/`checkout-index` 调用交错：
   * 第二个请求的 `read-tree` 会因临时索引的锁文件而失败
   * （`GIT_read-tree_FAILED: … .lock: File exists`），并放任它的文件不管。
   *
   * 这个锁只是约定上的可重入：从这里可达的任何代码都不能
   * 调用 `ensureSnapshot`，那会在同一把锁上排队并造成死锁。
   * @param {string} sessionId - 所属会话。
   * @param {object} request - 解析出的请求。
   * @returns {Promise<{kind: string, text: string}>} 报告。
   */
  const executeRequest = async (sessionId, request) => {
    try {
      return await withLock(stateFor(sessionId), async () => {
        // 预览从不改变任何东西，所以它在任何恢复之前应答。
        if (request.plan) return await previewRequest(sessionId, request);
        if (request.list) return { kind: 'success', text: await listSnapshots(sessionId) };
        if (Number.isSafeInteger(request.undo)) return await runForUndo(sessionId, request.undo);
        if (Number.isSafeInteger(request.seq) && Number.isSafeInteger(request.index)) {
          return await runForCoordinates(sessionId, request.seq, request.index);
        }
        return await runForTurn(sessionId, request.turn);
      });
    } catch (error) {
      const reason = errorCode(error);
      return {
        kind: 'error',
        text: reason.startsWith('NOT_A_GIT_REPOSITORY')
          ? '当前工作区不是 Git 仓库，无法使用基于 Git 的文件追踪。'
          : `回退失败：${reason}`,
      };
    }
  };

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------

  /**
   * 整轮回退对之后的一切改动都是破坏性的，所以把它暴露给模型的
   * 这个工具被置于随附的审批流水线之后：
   * `ask` 决策由工具层经 `ctx.approval` 路由，
   * 当组合中没有应答者时它会失败关闭，并把拒绝变成
   * 一次普通的工具拒绝。`list` 和 `plan` 不改变任何东西，直接通过，
   * 其他所有工具也一样。
   * @param {unknown} exec - 准备好的工具执行。
   * @param {() => any} next - 执行前链的其余部分。
   * @returns {Promise<any>|any} 本插件贡献的决策。
   */
  const gateRevertTool = (exec, next) => {
    const toolName = isRecord(exec) ? exec.name : undefined;
    const request = isRecord(exec) && isRecord(exec.arguments) ? exec.arguments : {};
    if (toolName !== TOOL_NAME || request.action !== 'revert') return typeof next === 'function' ? next() : { kind: 'allow' };
    const turn = Number.isSafeInteger(request.turn) && request.turn > 0 ? request.turn : undefined;
    // 一个拼错的轮次会被 `execute` 直接拒绝、什么也不改；先弹一次
    // 审批只会让用户习惯于不看内容就点同意。
    if (request.turn !== undefined && turn === undefined) return typeof next === 'function' ? next() : { kind: 'allow' };
    return {
      kind: 'ask',
      reason:
        turn === undefined
          ? '撤回整个工作区与对话（基于 Git 快照，会覆盖最新一轮之后的改动）'
          : `撤回整个工作区与对话（第 ${turn} 轮，基于 Git 快照，会覆盖该轮之后的改动）`,
    };
  };

  ctx.on('tools/pre-execute', gateRevertTool);

  ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Restore the worktree and the conversation to the state they held before one Agent turn, from Git snapshots this plugin takes at the start of every turn. ' +
      'A whole-turn revert also rolls the conversation back: that turn and everything after it stop reaching the model and are hidden in the transcript. ' +
      'Call it with action "list" to see which turns have snapshots and what differs, or action "plan" to see exactly which files one revert would restore, then action "revert" with a turn number. ' +
      'The whole worktree is restored: files the turn modified or deleted come back, and files the turn created are removed. ' +
      'Gitignored paths are outside the snapshot in both directions. Reverting is destructive to every later change, so revert only the turns the user asked to undo; ' +
      'action "revert" asks the user for approval first, and the denial is an ordinary tool error.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'plan', 'revert'],
          description: 'list reports the snapshot per turn; plan previews the files one revert would restore; revert restores them.',
        },
        turn: {
          type: 'integer',
          description: 'Agent turn whose pre-turn state to restore; omit to use the latest turn the Session reached.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: isRecord(value) && typeof value.text === 'string' ? value.text : '' }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.id;
      if (sessionId === undefined) return { text: '这次调用不属于任何会话。' };
      const input = isRecord(args) ? args : {};
      if (input.action !== 'list' && input.action !== 'plan' && input.action !== 'revert') {
        return { text: 'action 只能是 "list"、"plan" 或 "revert"。' };
      }
      // 命令通道对 `--turn 0`/`--turn abc` 直接报错，工具通道必须
      // 同样严格：一个拼错的轮次会被当成"当前轮"，而回退不可撤销。
      if (input.turn !== undefined && (!Number.isSafeInteger(input.turn) || input.turn <= 0)) {
        return { text: 'turn 必须是大于 0 的整数；省略它才会使用最新的一轮。' };
      }
      const turn = input.turn;
      const outcome = await executeRequest(sessionId, {
        list: input.action === 'list',
        plan: input.action === 'plan',
        turn,
      });
      return { text: outcome.text };
    },
  });

  // ---------------------------------------------------------------------------
  // 会话删除
  // ---------------------------------------------------------------------------

  /**
   * 一次删除会驱动的服务，在使用时解析而不是注入：没有这些服务的宿主
   * 仍然必须能加载本插件的 Git 半边，命令会
   * 以缺失的服务作答，而不是加载失败。
   * @returns {{persistence: any, registry: any, live: any}} 宿主服务，每个都可能为 undefined。
   */
  const deletionServices = () => ({
    persistence: ctx.get('sessionPersistence'),
    registry: ctx.get('workspaceRegistry'),
    live: ctx.get('sessions'),
  });

  /**
   * 一个已存储会话所拥有的目录。Persistence 快照把
   * 日志文件命名为 `<root>/<cwd key>/<session segment>/session…`，其中
   * 当 id 本身已是安全路径段时该段就是它本身，
   * 否则就是存储自己的 `encodeSegment` 拼写。它的父目录持有整
   * 套产物：那份日志以及紧挨它的写租约。
   * @param {unknown} snapshot - Persistence 快照。
   * @param {string} sessionId - 该快照所属的会话。
   * @returns {{directory: string|undefined}|{unverifiable: true}} 绝对
   *   目录（会话从未实体化时为 `undefined`），或者是
   *   存储布局不再以本插件
   *   可以验证的方式命名该会话这一事实。
   */
  const sessionDirectoryOf = (snapshot, sessionId) => {
    const location = isRecord(snapshot) ? snapshot.location : undefined;
    const logPath = isRecord(location) ? location.path : undefined;
    // 后端从未实体化的会话根本不携带 location。
    if (typeof logPath !== 'string' || logPath === '') return { directory: undefined };
    const directory = path.dirname(logPath);
    const segment = path.basename(directory);
    // 其他任何情况都意味着布局变了，递归删除不能靠猜：
    // 调用方会拒绝，而不是把会话删掉一半。
    if (segment === sessionId || segment === encodeSegment(sessionId)) return { directory };
    return { unverifiable: true };
  };

  /**
   * 已挂载的 JSON 存储后端写入时所用的所有根，已去重。
   * 删除需要其中之一来定位会话的投影检查点：每条记录一份
   * 文档，保存投影值 —— 其中包括标题和
   * 首个提示词。
   * @returns {string[]} 解析出的根，按注册顺序。
   */
  const storageRootsOf = () => {
    const backend = ctx.get('storage')?.backend;
    if (typeof backend?.names !== 'function') return [];
    const roots = [];
    for (const name of backend.names()) {
      try {
        const root = backend.get(name)?.root;
        if (typeof root === 'string' && root !== '') {
          const resolved = path.resolve(root);
          if (!roots.includes(resolved)) roots.push(resolved);
        }
      } catch {
        // 在列出与读取之间注销掉的后端。
      }
    }
    return roots;
  };

  /**
   * 投影缓存可能存放某个会话检查点的所有路径。
   * 随附的 json 后端把 `per-record` 域存储在
   * `<root>/session_projcache/sessions/<id>.json`，但哪个已注册的根
   * 服务该域由路由决定，不是本插件的事 —— 所以每个
   * 候选都被列出，缺失的那个就只是没有东西可删。
   * @param {string} sessionId - 其检查点被列出的会话。
   * @returns {string[]} 绝对的候选路径。
   */
  const projectionCheckpointsOf = (sessionId) =>
    storageRootsOf().map((root) => path.join(root, 'session_projcache', 'sessions', `${sessionId}.json`));

  /** 一个人类可读的字节数；不是有效值时为 undefined。 */
  const formatBytes = (bytes) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return undefined;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  /**
   * 一次删除会移除什么，以及它究竟能否运行。这里不
   * 触碰任何东西：浏览器半边把它作为确认卡片的主体显示，所以
   * 拒绝必须以报告形式出现，而不是抛出的错误。
   * @param {string} sessionId - 要检查的会话。
   * @returns {Promise<object>} 检查结果。
   * @throws 当宿主完全无法访问该会话时。
   */
  const inspectDeletion = async (sessionId) => {
    const { persistence, live } = deletionServices();
    if (persistence === undefined) throw new Error('宿主没有装配会话持久层。');
    const snapshot = await persistence.stat(sessionId);
    if (snapshot === undefined) throw new Error('本机没有这个会话的落盘记录，它可能已经被删除。');
    const header = isRecord(snapshot.header) ? snapshot.header : {};
    const located = sessionDirectoryOf(snapshot, sessionId);
    if (located.unverifiable === true) throw new Error('会话目录的命名与存储布局不符，拒绝删除。');
    const directory = located.directory;
    const root = typeof persistence.root === 'string' ? path.resolve(persistence.root) : undefined;
    if (directory !== undefined && root !== undefined) {
      const resolved = path.resolve(directory);
      // 这条命令删除的唯一目录来自存储本身，
      // 但一个改变了布局的存储必须大声失败，而不是把
      // 自己根之外的路径交给递归删除。
      if (!resolved.startsWith(root + path.sep)) throw new Error('会话目录不在会话根内，拒绝删除。');
    }
    return {
      sessionId,
      directory,
      sizeBytes: Number.isSafeInteger(snapshot.sizeBytes) ? snapshot.sizeBytes : undefined,
      // 本进程实体化过的会话仍在日志上持有写入者，所以
      // 存储会在下次 flush 时重新创建产物。
      resident: live?.get?.(sessionId) !== undefined,
      cachePaths: projectionCheckpointsOf(sessionId),
      cwd: typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined,
    };
  };

  /**
   * 一次检查对应的确认卡片主体。
   * @param {object} inspection - `inspectDeletion` 的结果。
   * @returns {string} 报告文本。
   */
  const describeDeletion = (inspection) => {
    const lines = [`会话：${inspection.sessionId}`];
    if (inspection.directory !== undefined) lines.push(`目录：${inspection.directory}`);
    const size = formatBytes(inspection.sizeBytes);
    if (size !== undefined) lines.push(`会话日志：${size}`);
    lines.push('同时清除工作区注册表中的归档、置顶与成员记录，以及该会话的投影缓存。');
    if (inspection.resident) {
      lines.push('该会话仍在本次 DSH 运行中驻留，现在无法删除；请重启 DSH 后再试。');
      return lines.join('\n');
    }
    if (inspection.directory === undefined && inspection.cachePaths.length === 0) {
      lines.push('这个会话没有落盘数据可删。');
      return lines.join('\n');
    }
    lines.push('删除是永久的，无法恢复。');
    return lines.join('\n');
  };

  /**
   * 丢弃每一条仍然指向已移除会话的注册表记录。移除
   * 归档或置顶是幂等的，并且接受一个它从未持有过的 id，这
   * 正是本例：该会话已经从磁盘上消失。
   * @param {object} inspection - `inspectDeletion` 的结果。
   * @returns {Promise<void>} 注册表写入之后兑现。
   */
  const forgetSession = async (inspection) => {
    const { registry } = deletionServices();
    if (registry === undefined) return;
    await registry.unarchiveSession(inspection.sessionId);
    await registry.unpinSession(inspection.sessionId);
    if (inspection.cwd === undefined) return;
    try {
      const workspace = await registry.resolveByPath(inspection.cwd);
      await workspace?.detachSession?.(inspection.sessionId);
    } catch {
      // 目录不再能解析的工作区没有成员行
      // 可供修剪，而它的成员列表本来就会丢弃未知候选。
    }
  };

  /**
   * 永久移除一个会话：它的产物、它的投影检查点，以及
   * 每一条指向它的注册表记录，然后告诉已连接的浏览器半边列表
   * 变了。本进程实体化过的会话会被拒绝，因为它的写入者
   * 仍持有日志。
   * @param {string} sessionId - 要移除的会话。
   * @returns {Promise<object>} 本次移除所依据的检查结果。
   */
  const removeSession = async (sessionId) => {
    const inspection = await inspectDeletion(sessionId);
    if (inspection.resident) throw new Error('该会话仍在本次 DSH 运行中驻留，重启后再删除。');
    if (inspection.directory !== undefined) await rm(inspection.directory, { recursive: true, force: true });
    for (const checkpoint of inspection.cachePaths) await rm(checkpoint, { force: true });
    await forgetSession(inspection);
    // 随附的浏览器半边在此事件上移除一行，宿主会把它转发给
    // 每个已连接的浏览器半边。持久层不再列出该会话，所以
    // 下一次列表基线无法把这行带回来。
    ctx.emit('api-session/removed', sessionId);
    return inspection;
  };

  /**
   * 解析一行 `/delete-session`：`--id <sessionId>` 以及可选的
   * `--plan`。不可用的参数是错误，绝不静默回落 ——
   * 删除是永久的，所以没有值的 `--id` 绝不能挑一个会话。
   * @param {unknown} line - 原始命令输入。
   * @returns {{sessionId?: string, plan: boolean, error?: string}} 请求。
   */
  const parseDeleteLine = (line) => {
    const request = { sessionId: undefined, plan: false, error: undefined };
    const tokens = String(line ?? '')
      .split(/\s+/)
      .filter((token) => token !== '');
    for (let position = 0; position < tokens.length; position += 1) {
      const token = tokens[position];
      if (token === '--plan') {
        request.plan = true;
        continue;
      }
      if (token !== '--id') {
        request.error = `未知参数 ${token}。`;
        return request;
      }
      const value = tokens[position + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        request.error = '--id 需要一个会话 ID。';
        return request;
      }
      request.sessionId = value;
      position += 1;
    }
    if (request.sessionId === undefined) request.error = '需要 --id <会话 ID>。';
    return request;
  };

  // ---------------------------------------------------------------------------
  // 命令
  // ---------------------------------------------------------------------------

  /** 一个完整的非负十进制参数；其他任何内容都为 undefined。 */
  const countArgument = (value) => {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  };

  /**
   * 解析一行 `/revert`。不可用的参数是错误，绝不静默
   * 回落：回退对对话是破坏性且不可恢复的，
   * 所以 `--turn abc` 绝不能悄悄回退当前轮次。
   * @param {unknown} line - 原始命令输入。
   * @returns {{list: boolean, plan: boolean, turn?: number, seq?: number, index?: number, undo?: number, error?: string}} 请求。
   */
  const parseCommandLine = (line) => {
    const request = {
      list: false,
      plan: false,
      turn: undefined,
      seq: undefined,
      index: undefined,
      undo: undefined,
      error: undefined,
    };
    const tokens = String(line ?? '')
      .split(/\s+/)
      .filter((token) => token !== '');
    for (let position = 0; position < tokens.length; position += 1) {
      const token = tokens[position];
      const value = tokens[position + 1];
      if (token === '--list') request.list = true;
      else if (token === '--plan' || token === '--dry-run') request.plan = true;
      else if (token === '--undo') {
        const parsed = countArgument(value);
        if (parsed === undefined) {
          request.error = '--undo 需要一个反悔点令牌。';
          return request;
        }
        request.undo = parsed;
        position += 1;
      } else if (token === '--turn' || token === '--seq' || token === '--index') {
        const parsed = countArgument(value);
        if (parsed === undefined) {
          request.error = `${token} 需要一个非负整数。`;
          return request;
        }
        if (token === '--turn' && parsed === 0) {
          request.error = '--turn 需要一个大于 0 的轮次。';
          return request;
        }
        request[token.slice(2)] = parsed;
        position += 1;
      } else {
        request.error = `未知参数 ${token}。`;
        return request;
      }
    }
    if ((request.seq === undefined) !== (request.index === undefined)) {
      request.error = '--seq 与 --index 必须同时给出。';
      return request;
    }
    if (request.undo !== undefined && (request.turn !== undefined || request.seq !== undefined)) {
      request.error = '--undo 不能与 --turn 或 --seq 一起使用。';
    }
    return request;
  };

  ctx.commands.register({
    name: COMMAND_NAME,
    description: '把工作区和对话恢复到某一轮对话开始前的状态（基于 Git 快照）',
    input: { hint: '[--list] [--plan] [--turn N] [--seq N --index N] [--undo N]' },
    async handler(invocation) {
      const sessionId = invocation.agent?.id;
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { kind: 'error', text: '无法确定所属会话。' };
      }
      const request = parseCommandLine(invocation.rawInput);
      if (request.error !== undefined) {
        return {
          kind: 'error',
          text: `${request.error}\n用法：/revert [--list] [--plan] [--turn N] [--seq N --index N] [--undo N]`,
        };
      }
      const outcome = await executeRequest(sessionId, request);
      return { kind: outcome.kind === 'error' ? 'error' : 'success', text: outcome.text };
    },
  });

  ctx.commands.register({
    name: DELETE_COMMAND_NAME,
    description: '永久删除一个会话：它的落盘日志、投影缓存，以及工作区注册表里的归档、置顶与成员记录（不可恢复）',
    input: { hint: '--id <sessionId> [--plan]' },
    async handler(invocation) {
      const carrierId = invocation.agent?.id;
      const request = parseDeleteLine(invocation.rawInput);
      if (request.error !== undefined) {
        return {
          kind: 'error',
          text: `${request.error}\n用法：/delete-session --id <sessionId> [--plan]`,
        };
      }
      if (request.sessionId === carrierId) {
        return { kind: 'error', text: '这条命令正运行在该会话里，无法删除它自己：请先切换到另一个会话。' };
      }
      try {
        const inspection = await inspectDeletion(request.sessionId);
        // 当删除不能运行时，预览会以 `error` 作答，这样
        // 浏览器半边可以在用户确认之前就拒绝。
        if (request.plan) {
          return { kind: inspection.resident ? 'error' : 'success', text: describeDeletion(inspection) };
        }
        await removeSession(request.sessionId);
        const lines = [`已永久删除会话 ${request.sessionId}。`];
        if (inspection.directory !== undefined) lines.push(`目录已移除：${inspection.directory}`);
        return { kind: 'success', text: lines.join('\n') };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { kind: 'error', text: `删除会话失败：${reason}` };
      }
    },
  });
}
