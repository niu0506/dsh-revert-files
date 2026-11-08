/**
 * Host 侧的检查，用 `node test/host.test.mjs` 运行。
 *
 * 这些检查防范的是日志形状错误，而不是推理错误：整轮回退过去会追加一个空的
 * `developer/message` 替换，当前的会话格式会在下一次写入日志时拒绝它
 * （`developer/message turn must be a non-negative safe integer`），并在下一次
 * 重新打开时再次拒绝（`developer/message does not match an open
 * turn and step`）——回退在会话空闲时运行，而在没有打开轮次时，
 * 只有 `user/message` 可以替换表层跨度。
 *
 * 这些检查通过已注册的命令，针对真实的临时 Git 仓库驱动真正的 `apply()`：
 * 一个裸的 `subprocess` 缝隙直接运行 `git`，一个假会话提供一个表层，断言读取
 * 插件追加的事件。除文档化的缝隙外，不涉及任何 DSH 服务。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../index.js';

const COMMAND = 'revert';
/** Host 用来标记一次对话回滚的消息来源种类。 */
const SOURCE_KIND = 'revert-files';

const results = [];
const check = (label, ok, detail = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || detail === '' ? '' : `: ${detail}`}`);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const gitPath = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout?.trim() ?? '';
if (gitPath === '') {
  console.log('SKIP host tests: git is not on PATH');
  process.exit(0);
}

/** 运行一条初始化期的 Git 命令，非零退出时大声报错。 */
const git = (args, cwd) => {
  const outcome = spawnSync(gitPath, args, { cwd, encoding: 'utf8' });
  if (outcome.status !== 0) throw new Error(`git ${args.join(' ')}: ${outcome.stderr.trim()}`);
  return outcome.stdout;
};

/**
 * 插件驱动的 `subprocess` 缝隙：每次 Git 调用是一个真实的子进程，
 * 具备插件读取的收集输出与生命周期表层。
 */
const subprocess = {
  async resolveExecutable(name) {
    if (name !== 'git') throw new Error(`unexpected executable ${name}`);
    return gitPath;
  },
  spawn({ argv, cwd, env, signal }) {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      // 插件会清空 Git 选择器，但不继承其他任何东西；真正的缝隙保留
      // 环境中的环境变量，因此 PATH 对 Git 的辅助程序依然可用。
      env: { ...process.env, ...env },
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const done = new Promise((resolve) => {
      child.on('error', (error) => resolve({ exitCode: null, error }));
      child.on('close', (code) => resolve({ exitCode: code }));
    });
    return {
      done,
      collected: {
        stdout: { readFrom: () => ({ text: stdout }) },
        stderr: { readFrom: () => ({ text: stderr }) },
      },
      terminate: () => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已经退出了。
        }
      },
      waitForExit: async () => {},
    };
  },
};

/**
 * 下面每个测试夹具都通过它驱动 `apply()` 的 `ctx` 缝隙：按名称取服务、
 * 捕获的处理器与注册项，以及一个警告会被断言而非忽略的日志器——否则
 * 被吞掉的快照失败只会表现为超时。
 * @param {{sessionId: string, session: any, services?: Record<string, any>, seam?: any}} options - 会话、任何额外服务，以及可选的 subprocess 缝隙。
 * @returns {{ctx: any, handlers: Map<string, any>, tools: any[], commands: any[], warnings: string[]}} 该缝隙。
 */
const makeContext = ({ sessionId, session, services = {}, seam = subprocess }) => {
  const handlers = new Map();
  const tools = [];
  const commands = [];
  const warnings = [];
  const emitted = [];
  const ctx = {
    get(name) {
      if (name === 'subprocess') return seam;
      if (name === 'sessions') return { get: (id) => (id === sessionId ? session : undefined) };
      return services[name];
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    emit: (name, ...args) => emitted.push([name, ...args]),
    tools: { register: (definition) => tools.push(definition) },
    commands: { register: (definition) => commands.push(definition) },
    logger: { warn: (message) => warnings.push(String(message)) },
    fs: {
      resolve: async (target) => target,
      deleteFile: async () => {},
    },
  };
  return { ctx, handlers, tools, commands, warnings, emitted };
};

/**
 * 同样的缝隙，但在每个子进程退出后加一个固定延迟：它拓宽了两个重叠请求
 * 交错执行各自 Git 调用的窗口，而这正是会话锁必须封住的窗口。
 */
const slowSubprocess = {
  ...subprocess,
  spawn(spec) {
    const child = subprocess.spawn(spec);
    return {
      ...child,
      done: child.done.then(async (outcome) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return outcome;
      }),
    };
  },
};

/**
 * 轮询直到某一轮的某个快照 ref 存在。ref 的会话部分现在带有摘要，
 * 因此测试按轮次而不是按名称查询，并且一旦记录到快照失败就立即以该原因
 * 结束等待，而不是等到整个超时结束。
 * @param {string} repo - 仓库根目录。
 * @param {number} turn - 等待其快照的轮次。
 * @param {string[]} warnings - 捕获到的 `ctx.logger.warn` 消息。
 * @param {number} [timeoutMs] - 持续轮询的时长。
 * @returns {Promise<string>} ref 名称。
 */
const waitForTurnRef = async (repo, turn, warnings = [], timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (warnings.length > 0) throw new Error(`the snapshot failed: ${warnings.join('; ')}`);
    const probe = spawnSync(gitPath, ['for-each-ref', '--format=%(refname)', 'refs/dsh/revert-files'], {
      cwd: repo,
      encoding: 'utf8',
    });
    const ref = probe.stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.endsWith(`/turn-${turn}`));
    if (ref !== undefined) return ref;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for the turn ${turn} snapshot`);
};

/**
 * 整轮回退必须走过的表层布局。`headSeq` 是第一个节点相对于轮次边界的位置，
 * `headKind` 是该节点是什么，`shadowed` 是正确的替换必须覆盖的节点。
 */
const LAYOUTS = [
  { name: 'head-before', headSeq: 0, headKind: 'system', shadowed: [3] },
  { name: 'head-inside', headSeq: 2, headKind: 'system', shadowed: [3] },
  // 只有节点 0 承载系统提示词时它才受保护；某一轮自己的第一个节点位于
  // 边界处或边界之后，同样必须被遮蔽。
  { name: 'user-node-zero', headSeq: 2, headKind: 'user', shadowed: [2, 3] },
];

/**
 * 驱动一次整轮回退，并返回插件追加的检查点。
 * @param {{headSeq: number, headKind: string}} layout - 表层布局。
 * @returns {Promise<{checkpoint: any, shadowed: number[], boundary: number, repo: string}>}
 */
const revertOnce = async (layout) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revert-host-'));
  const sessionId = 'session-host-test';
  git(['init', '-q'], repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
  git(['add', '-A'], repo);

  /** @type {any[]} */
  const log = [];
  /** @type {any[]} */
  const appended = [];
  const push = (event) => {
    log[event.seq] = event;
    return event;
  };
  const session = {
    id: sessionId,
    header: { cwd: repo },
    surface: { nodes: [] },
    eventAt: (seq) => log[seq],
    snapshotEvents: () => log,
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data, ...(opts ?? {}) };
      push(event);
      appended.push(event);
      return event;
    },
  };
  const emit = (event) => {
    push(event);
    handlers.get('session/event')(session, event);
  };

  const { ctx, handlers, commands, warnings } = makeContext({ sessionId, session });
  apply(ctx);

  // 插件要走的表层布局：节点 0 既可能是轮次边界之前的系统头部，也可能是
  // 边界之后的（真实的 Harness 会把系统提示词追加进第一个轮次内部）。
  const headSeq = layout.headSeq;
  const boundary = 1;
  push(
    layout.headKind === 'user'
      ? { type: 'user/message', seq: headSeq, time: 0, data: { id: 'u0', role: 'user', content: [], source: { kind: 'user' } }, surfaceOp: 'append' }
      : { type: 'system/message', seq: headSeq, time: 0, data: { message: { role: 'system', content: [] } }, surfaceOp: 'append' },
  );
  emit({ type: 'turn/start', seq: boundary, time: 0, data: { turn: 1 } });
  push({ type: 'user/message', seq: 3, time: 0, data: { id: 'u1', role: 'user', content: [], source: { kind: 'user' } }, surfaceOp: 'append' });
  emit({ type: 'turn/end', seq: 4, time: 0, data: { turn: 1, reason: { kind: 'completed' } } });
  session.surface.nodes = [headSeq, 3].sort((left, right) => left - right);

  await waitForTurnRef(repo, 1, warnings);
  // 该轮次在快照之后创建了这个路径，因此恢复有工作要做。
  fs.writeFileSync(path.join(repo, 'created-by-turn.txt'), 'after\n');

  const handler = commands.find((definition) => definition.name === COMMAND)?.handler;
  if (handler === undefined) throw new Error('the plugin registered no /revert command');
  const outcome = await handler({ agent: { id: sessionId }, rawInput: '--turn 1' });

  const checkpoint = appended.at(-1);
  const leftover = fs.existsSync(path.join(repo, 'created-by-turn.txt'));
  return { checkpoint, shadowed: layout.shadowed, boundary, repo, outcome, leftover, warnings };
};

const produced = [];
for (const layout of LAYOUTS) {
  try {
    produced.push({ label: layout.name, ...(await revertOnce(layout)) });
  } catch (error) {
    check(`the revert completes (${layout.name})`, false, String(error?.message ?? error));
  }
}

for (const { label, checkpoint, shadowed, boundary, repo, outcome, leftover, warnings } of produced) {
  const detail = JSON.stringify(checkpoint ?? null).slice(0, 300);
  check(`the revert reports success (${label})`, outcome?.kind === 'success', JSON.stringify(outcome));
  // 端到端恢复：该轮次在快照之后创建的路径已消失。
  check(`the revert removes the file the turn created (${label})`, leftover === false, String(leftover));
  check(`the revert logs no snapshot warning (${label})`, warnings.length === 0, JSON.stringify(warnings));
  check(`the checkpoint is a user/message (${label})`, checkpoint?.type === 'user/message', detail);
  check(`the checkpoint carries the user role (${label})`, checkpoint?.data?.role === 'user', detail);
  check(`the checkpoint content is empty (${label})`, same(checkpoint?.data?.content, []), detail);
  check(`the checkpoint id is a nonempty string (${label})`, typeof checkpoint?.data?.id === 'string' && checkpoint.data.id !== '', detail);
  check(
    `the checkpoint source marks this plugin (${label})`,
    checkpoint?.data?.source?.kind === SOURCE_KIND &&
      checkpoint.data.source.from === 1 &&
      checkpoint.data.source.to === 1,
    detail,
  );
  check(
    `the checkpoint replaces exactly the reverted surface span (${label})`,
    same(checkpoint?.surfaceOp, { op: 'replace', startSeq: shadowed[0], endSeq: shadowed.at(-1) }),
    detail,
  );
  const cited = Array.isArray(checkpoint?.sourceEventSeqs) ? checkpoint.sourceEventSeqs : [];
  check(
    `the checkpoint cites every shadowed node and the boundary (${label})`,
    shadowed.every((seq) => cited.includes(seq)) && cited.includes(boundary),
    JSON.stringify(cited),
  );
  // 当前格式在这里用不到 turn/step，加上它们会让日志无法阅读：
  // 只有处于打开状态的轮次和步骤才能携带它们。
  check(`the checkpoint adds no turn/step coordinates (${label})`, !Object.hasOwn(checkpoint?.data ?? {}, 'turn'), detail);
  fs.rmSync(repo, { recursive: true, force: true });
}

/**
 * 上面的轮次级检查看不到的两条缝隙：`fs/*-intent` 瀑布式交接，以及命令
 * 解析器对不可用参数的拒绝。两者都是桩替身承担真实契约的地方，因此各自
 * 拥有一个回归。监听器在插槽期望 `FsWriteIntent` 的地方返回快照哈希，
 * 会弄坏已发布的写入工具；解析器把拼写错误变成“当前轮次”，
 * 就会回退错误的东西。
 * @returns {Promise<object>} 观察到的缝隙行为。
 */
const seamsOnce = async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revert-seams-'));
  const sessionId = 'session-seams';
  git(['init', '-q'], repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
  git(['add', '-A'], repo);
  const seedTree = git(['write-tree'], repo).trim();

  /** @type {any[]} */
  const log = [];
  const session = {
    id: sessionId,
    header: { cwd: repo },
    surface: { nodes: [] },
    eventAt: (seq) => log[seq],
    snapshotEvents: () => log,
    append() {
      throw new Error('the seam harness never appends to the log');
    },
  };
  const { ctx, handlers, commands, warnings } = makeContext({ sessionId, session });
  apply(ctx);

  /** @type {any} */
  const opened = { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } };
  log[0] = opened;
  handlers.get('session/event')(session, opened);
  await waitForTurnRef(repo, 1, warnings);

  // 该轮次随后写入了这个文件：走兜底回退会明显地撤销它。
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'after\n');

  let nextCalls = 0;
  const decision = { kind: 'replaceIfVersion', version: 'v1' };
  const handed = await handlers.get('fs/edit-intent')(
    { targetKey: path.join(repo, 'tracked.txt'), displayPath: 'tracked.txt' },
    { agent: { id: sessionId, session } },
    () => {
      nextCalls += 1;
      return decision;
    },
  );

  const handler = commands.find((definition) => definition.name === COMMAND)?.handler;
  const asAgent = (rawInput) => handler({ agent: { id: sessionId }, rawInput });
  const refusedTurn = await asAgent('--turn abc');
  const fileAfter = fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8');
  const refusedSeq = await asAgent('--seq 1');

  // 早期构建用摘要之前的名称固定的快照仍然可以访问到。
  git(['update-ref', `refs/dsh/revert-files/${sessionId}/turn-9`, seedTree], repo);
  const listText = (await asAgent('--list')).text ?? '';

  fs.rmSync(repo, { recursive: true, force: true });
  return { handed, nextCalls, refusedTurn, refusedSeq, fileAfter, listText, warnings };
};

/**
 * 通过变更审查坐标驱动一次单文件回退——这条入口与插件共用文件定位器。
 * 计划必须报出该文件且不做任何改动；回退必须写回快照的字节，
 * 且不触碰它的邻居。
 * @returns {Promise<object>} 观察到的行为。
 */
const coordinateOnce = async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revert-file-'));
  const sessionId = 'session-file-test';
  const workspace = path.join(repo, 'src');
  const outside = path.join(repo, 'other');
  git(['init', '-q'], repo);
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'a1\n');
  fs.writeFileSync(path.join(outside, 'b.txt'), 'b1\n');
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'keep\n');
  git(['add', '-A'], repo);

  /** @type {any[]} */
  const log = [];
  const session = {
    id: sessionId,
    header: { cwd: repo },
    surface: { nodes: [] },
    eventAt: (seq) => log[seq],
    snapshotEvents: () => log,
    append() {
      throw new Error('a single-file revert never touches the conversation');
    },
  };
  // 审查标签页自己的摘要。`path` 在工作目录内部时相对于 cwd，
  // 在外部时是绝对路径，而 `display` 是 Host 对同一文件的
  // 面向人的呈现。
  const SEQ = 5;
  // 记录器在仓库之外捕获的一个文件：没有任何快照覆盖它。
  const stray = path.join(os.tmpdir(), `dsh-revert-stray-${String(Date.now())}.txt`);
  fs.writeFileSync(stray, 'stray\n');
  const summary = {
    turn: 1,
    cwd: workspace,
    files: [
      { path: 'a.txt', display: 'a.txt' },
      { path: path.join(outside, 'b.txt'), display: '../other/b.txt' },
      { path: stray, display: `~/${path.basename(stray)}` },
    ],
  };
  const { ctx, handlers, commands, warnings } = makeContext({
    sessionId,
    session,
    services: { workspaceChanges: { summary: (id, seq) => (id === sessionId && seq === SEQ ? summary : undefined) } },
  });
  apply(ctx);

  /** @type {any} */
  const opened = { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } };
  log[0] = opened;
  handlers.get('session/event')(session, opened);
  await waitForTurnRef(repo, 1, warnings);

  const file = path.join(workspace, 'a.txt');
  const neighbour = path.join(outside, 'b.txt');
  fs.writeFileSync(file, 'a2\n');
  fs.writeFileSync(neighbour, 'b2\n');
  const handler = commands.find((definition) => definition.name === COMMAND)?.handler;
  const asAgent = (rawInput) => handler({ agent: { id: sessionId }, rawInput });

  const plan = await asAgent(`--seq ${SEQ} --index 0 --plan`);
  const afterPlan = fs.readFileSync(file, 'utf8');
  const applied = await asAgent(`--seq ${SEQ} --index 0`);
  const afterRevert = fs.readFileSync(file, 'utf8');
  const keep = fs.readFileSync(path.join(repo, 'keep.txt'), 'utf8');

  // 工作目录之外的文件：报告必须像审查标签页那样称呼它，
  // 而不是用它的绝对路径。
  const outsidePlan = await asAgent(`--seq ${SEQ} --index 1 --plan`);
  const afterOutsidePlan = fs.readFileSync(neighbour, 'utf8');
  const outsideApplied = await asAgent(`--seq ${SEQ} --index 1`);
  const afterOutsideRevert = fs.readFileSync(neighbour, 'utf8');

  const strayOutcome = await asAgent(`--seq ${SEQ} --index 2`);
  fs.rmSync(stray, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  return {
    plan,
    afterPlan,
    applied,
    afterRevert,
    keep,
    outsidePlan,
    afterOutsidePlan,
    outsideApplied,
    afterOutsideRevert,
    strayOutcome,
    repo,
    warnings,
  };
};

/**
 * 从不同轮次驱动两次重叠的单文件回退。两者共用会话的私有索引和临时索引，
 * 因此未串行化的一对调用可能把另一个请求的 blob 写到目标路径上；
 * 每个文件最终必须是它自己那一轮的字节。
 * @returns {Promise<object>} 观察到的文件内容与日志中的警告。
 */
const raceOnce = async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revert-race-'));
  const sessionId = 'session-race-test';
  const fileA = path.join(repo, 'a.txt');
  const fileB = path.join(repo, 'b.txt');
  git(['init', '-q'], repo);
  fs.writeFileSync(fileA, 'a1\n');
  git(['add', '-A'], repo);

  /** @type {any[]} */
  const log = [];
  const session = {
    id: sessionId,
    header: { cwd: repo },
    surface: { nodes: [] },
    eventAt: (seq) => log[seq],
    snapshotEvents: () => log,
    append() {
      throw new Error('the race harness never touches the conversation');
    },
  };
  // 两条变更记录，各指名某一轮的某一个文件。
  const SEQ_A = 4;
  const SEQ_B = 6;
  const summaries = new Map([
    [SEQ_A, { turn: 1, cwd: repo, files: [{ path: 'a.txt', display: 'a.txt' }] }],
    [SEQ_B, { turn: 2, cwd: repo, files: [{ path: 'b.txt', display: 'b.txt' }] }],
  ]);
  const { ctx, handlers, commands, warnings } = makeContext({
    sessionId,
    session,
    seam: slowSubprocess,
    services: { workspaceChanges: { summary: (id, seq) => (id === sessionId ? summaries.get(seq) : undefined) } },
  });
  apply(ctx);

  // 第 1 轮的变更前镜像：a1 和 b1。
  fs.writeFileSync(fileB, 'b1\n');
  /** @type {any} */
  const first = { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } };
  log[0] = first;
  handlers.get('session/event')(session, first);
  await waitForTurnRef(repo, 1, warnings);

  // 第 2 轮的变更前镜像：a2 和 b2。
  fs.writeFileSync(fileA, 'a2\n');
  fs.writeFileSync(fileB, 'b2\n');
  /** @type {any} */
  const second = { type: 'turn/start', seq: 1, time: 0, data: { turn: 2 } };
  log[1] = second;
  handlers.get('session/event')(session, second);
  await waitForTurnRef(repo, 2, warnings);

  // 两个请求共同起始的工作区。
  fs.writeFileSync(fileA, 'a3\n');
  fs.writeFileSync(fileB, 'b3\n');

  const handler = commands.find((definition) => definition.name === COMMAND)?.handler;
  const [outcomeA, outcomeB] = await Promise.all([
    handler({ agent: { id: sessionId }, rawInput: `--seq ${SEQ_A} --index 0` }),
    handler({ agent: { id: sessionId }, rawInput: `--seq ${SEQ_B} --index 0` }),
  ]);

  const a = fs.readFileSync(fileA, 'utf8');
  const b = fs.readFileSync(fileB, 'utf8');
  fs.rmSync(repo, { recursive: true, force: true });
  return { a, b, warnings, report: JSON.stringify({ a: outcomeA, b: outcomeB }).slice(0, 400) };
};

/**
 * 一个工作目录在两个仓库之间移动的会话。快照必须跟随它——第 2 轮的
 * 变更前镜像属于会话当前所在的仓库——而回退绝不能伸进它已经离开的那个。
 * `working_directory` 工具让这件事无需用户操作即可触达。
 * @returns {Promise<object>} 两个仓库的观察状态与各报告。
 */
const cwdSwitchOnce = async () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revert-cwd-a-'));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revert-cwd-b-'));
  const sessionId = 'session-cwd-test';
  for (const repo of [repoA, repoB]) {
    git(['init', '-q'], repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
    git(['add', '-A'], repo);
  }

  /** @type {any[]} */
  const log = [];
  /** @type {any[]} */
  const appended = [];
  const push = (event) => {
    log[event.seq] = event;
    return event;
  };
  const session = {
    id: sessionId,
    header: { cwd: repoA },
    surface: { nodes: [] },
    eventAt: (seq) => log[seq],
    snapshotEvents: () => log,
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data, ...(opts ?? {}) };
      push(event);
      appended.push(event);
      return event;
    },
  };
  const emit = (event) => {
    push(event);
    handlers.get('session/event')(session, event);
  };

  const { ctx, handlers, commands, warnings } = makeContext({ sessionId, session });
  apply(ctx);
  const asAgent = (rawInput) =>
    commands.find((definition) => definition.name === COMMAND)?.handler({ agent: { id: sessionId }, rawInput });

  // 第 1 轮属于第一个仓库；它的快照落在那里。
  emit({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
  await waitForTurnRef(repoA, 1, warnings);
  // 第 1 轮在快照之后创建了一个文件，然后会话移动到仓库 B。
  fs.writeFileSync(path.join(repoA, 'created-in-a.txt'), 'a\n');
  emit({ type: 'working-directory/change', seq: 1, time: 0, data: { cwd: repoB } });
  session.header.cwd = repoB;

  // 第 2 轮的变更前镜像必须来自会话当前所在的仓库。
  emit({ type: 'turn/start', seq: 2, time: 0, data: { turn: 2 } });
  await waitForTurnRef(repoB, 2, warnings);
  fs.writeFileSync(path.join(repoB, 'tracked.txt'), 'after\n');

  const report = await asAgent('--turn 2');
  // 第 1 轮的历史位于会话离开的那个仓库中，而不是这一个。
  const stale = await asAgent('--turn 1');
  const refs = (repo) => git(['for-each-ref', '--format=%(refname)', 'refs/dsh/revert-files'], repo);
  const value = {
    report,
    stale,
    aKept: fs.readFileSync(path.join(repoA, 'created-in-a.txt'), 'utf8'),
    bRestored: fs.readFileSync(path.join(repoB, 'tracked.txt'), 'utf8'),
    aHasTurn2: refs(repoA).includes('/turn-2'),
    bHasTurn1: refs(repoB).includes('/turn-1'),
    bHasTurn2: refs(repoB).includes('/turn-2'),
    appended,
    warnings,
  };
  fs.rmSync(repoA, { recursive: true, force: true });
  fs.rmSync(repoB, { recursive: true, force: true });
  return value;
};

/**
 * 一个只承载系统提示词的表层。该格式保护节点 0，并且只允许
 * `system/message` 覆盖它，因此在那个位置做 `user/message` 替换会在追加时
 * 被拒绝；既然没有其他节点，也就没有轮次内容可遮蔽，
 * 回退必须说明这一点而不是硬试。
 * @returns {Promise<object>} 报告、文件结果以及追加的日志。
 */
const headOnlyOnce = async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revert-head-'));
  const sessionId = 'session-head-only';
  git(['init', '-q'], repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
  git(['add', '-A'], repo);

  /** @type {any[]} */
  const log = [];
  /** @type {any[]} */
  const appended = [];
  const push = (event) => {
    log[event.seq] = event;
    return event;
  };
  const session = {
    id: sessionId,
    header: { cwd: repo },
    surface: { nodes: [] },
    eventAt: (seq) => log[seq],
    snapshotEvents: () => log,
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data, ...(opts ?? {}) };
      push(event);
      appended.push(event);
      return event;
    },
  };
  const emit = (event) => {
    push(event);
    handlers.get('session/event')(session, event);
  };

  const { ctx, handlers, commands, warnings } = makeContext({ sessionId, session });
  apply(ctx);
  emit({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
  await waitForTurnRef(repo, 1, warnings);
  // 系统提示词就是整个表层，而它落在这个轮次内部。
  push({
    type: 'system/message',
    seq: 1,
    time: 0,
    data: { message: { role: 'system', content: [] } },
    surfaceOp: 'append',
  });
  session.surface.nodes = [1];
  // 回退在会话空闲时运行；一个处于打开状态的轮次只会恢复文件
  // （即文档化的行为），绝不会走到表层遍历。
  emit({ type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'completed' } } });
  fs.writeFileSync(path.join(repo, 'created-by-turn.txt'), 'after\n');

  const outcome = await commands.find((definition) => definition.name === COMMAND)?.handler({
    agent: { id: sessionId },
    rawInput: '--turn 1',
  });
  const leftover = fs.existsSync(path.join(repo, 'created-by-turn.txt'));
  fs.rmSync(repo, { recursive: true, force: true });
  return { outcome, leftover, appended, warnings };
};

/**
 * 运行一个测试夹具，并把它的值交给对应的检查。抛异常的测试夹具
 * （比如始终没有落地的快照）会变成一个具名失败，而不是一个会掩盖
 * 其后所有结果的未捕获崩溃。
 * @param {string} label - 测试夹具抛出异常时使用的名称。
 * @param {() => Promise<any>} run - 该测试夹具。
 * @param {(value: any) => void} assert - 成功时要运行的检查。
 */
const harness = async (label, run, assert) => {
  let value;
  try {
    value = await run();
  } catch (error) {
    check(`${label} completes`, false, String(error?.message ?? error));
    return;
  }
  assert(value);
};

await harness('the seams harness', seamsOnce, (seams) => {
  check(
    'the intent waterfall hands the decision back',
    same(seams.handed, { kind: 'replaceIfVersion', version: 'v1' }),
    JSON.stringify(seams.handed),
  );
  check('the intent waterfall calls the rest of the chain once', seams.nextCalls === 1, String(seams.nextCalls));
  check('a bad --turn is refused', seams.refusedTurn?.kind === 'error', JSON.stringify(seams.refusedTurn));
  check('a refused revert changes nothing', seams.fileAfter === 'after\n', JSON.stringify(seams.fileAfter));
  check('--seq without --index is refused', seams.refusedSeq?.kind === 'error', JSON.stringify(seams.refusedSeq));
  check('a pre-digest snapshot ref is still listed', seams.listText.includes('第 9 轮'), seams.listText);
  check('the seams harness logged no snapshot warning', seams.warnings.length === 0, JSON.stringify(seams.warnings));
});

await harness('the overlapping-restore harness', raceOnce, (race) => {
  check('an overlapping restore keeps its own turn bytes', race.a === 'a1\n', `${JSON.stringify(race.a)} ${race.report}`);
  check('the other overlapping restore keeps its own turn bytes', race.b === 'b2\n', `${JSON.stringify(race.b)} ${race.report}`);
  check('the race harness logged no snapshot warning', race.warnings.length === 0, JSON.stringify(race.warnings));
});

await harness('the working-directory harness', cwdSwitchOnce, (switched) => {
  check('a snapshot after a directory change lands in the new repository', switched.bHasTurn2, JSON.stringify(switched));
  check('the old repository gets no snapshot for the new turn', !switched.aHasTurn2, JSON.stringify(switched));
  check('the new repository has no history for the old turn', !switched.bHasTurn1, JSON.stringify(switched));
  check('the revert restores the new repository', switched.bRestored === 'before\n', JSON.stringify(switched.bRestored));
  check('the revert leaves the old repository alone', switched.aKept === 'a\n', JSON.stringify(switched.aKept));
  check(
    'an old turn is reported as having no snapshot here',
    switched.stale?.kind === 'error' && String(switched.stale.text).includes('没有可用的快照'),
    JSON.stringify(switched.stale),
  );
  check('the working-directory harness logged no snapshot warning', switched.warnings.length === 0, JSON.stringify(switched.warnings));
});

await harness('the system-only-surface harness', headOnlyOnce, (head) => {
  check('a surface holding only the system prompt reverts its files', head.outcome?.kind === 'success', JSON.stringify(head.outcome));
  check('the revert removes the file the turn created', head.leftover === false, String(head.leftover));
  check('no replacement over the protected head is appended', head.appended.length === 0, JSON.stringify(head.appended));
  check(
    'the report says the conversation was already rolled back',
    String(head.outcome?.text ?? '').includes('此前已经撤回') && !String(head.outcome?.text ?? '').includes('未能撤回'),
    String(head.outcome?.text),
  );
  check('the system-only-surface harness logged no snapshot warning', head.warnings.length === 0, JSON.stringify(head.warnings));
});

// --- 只有整轮回退才请求批准 ---------------------------------------------
// 该工具可以改变工作区和模型自己的历史；`list` 和 `plan` 不行。
// 这个决策来自已发布流水线的 `ask`：它通过 `ctx.approval` 转达提示，
// 并在没有组合任何应答者时按失败关闭处理。
const gateSeam = makeContext({ sessionId: 'session-gate', session: {} });
apply(gateSeam.ctx);
const gate = gateSeam.handlers.get('tools/pre-execute');
const nextDecision = { kind: 'allow' };
let gateNext = 0;
const gateNextFn = () => {
  gateNext += 1;
  return nextDecision;
};
const gated = await gate({ name: 'revert_files', arguments: { action: 'revert', turn: 2 } }, gateNextFn);
check('the revert tool asks for approval', gated?.kind === 'ask', JSON.stringify(gated));
check('the approval names the turn', String(gated?.reason ?? '').includes('第 2 轮'), String(gated?.reason));
check('an asking gate does not fall through', gateNext === 0, String(gateNext));
const gatedLatest = await gate({ name: 'revert_files', arguments: { action: 'revert' } }, gateNextFn);
check(
  'a turn-less revert still asks for approval',
  gatedLatest?.kind === 'ask' && String(gatedLatest.reason).includes('最新一轮'),
  JSON.stringify(gatedLatest),
);
check('the gate is registered on the pre-execute slot', typeof gate === 'function');
check(
  'the plan action falls through untouched',
  (await gate({ name: 'revert_files', arguments: { action: 'plan' } }, gateNextFn)) === nextDecision && gateNext === 1,
  String(gateNext),
);
check('another tool falls through untouched', (await gate({ name: 'read' }, gateNextFn)) === nextDecision && gateNext === 2, String(gateNext));
check(
  'a malformed request falls through untouched',
  (await gate({ name: 'revert_files' }, gateNextFn)) === nextDecision && gateNext === 3,
  String(gateNext),
);
check('the tool is still registered', gateSeam.tools.some((tool) => tool.name === 'revert_files'));

await harness('the single-file harness', coordinateOnce, (single) => {
  check('the file plan reports success', single.plan?.kind === 'success', JSON.stringify(single.plan));
  check('the file plan names the file', String(single.plan?.text ?? '').includes('a.txt'), String(single.plan?.text));
  check(
    'the file plan previews a restore',
    String(single.plan?.text ?? '').includes('已修改，将写回原文'),
    String(single.plan?.text),
  );
  check('the file plan changes nothing', single.afterPlan === 'a2\n', JSON.stringify(single.afterPlan));
  check('the file revert reports success', single.applied?.kind === 'success', JSON.stringify(single.applied));
  check('the file revert writes the snapshot bytes back', single.afterRevert === 'a1\n', JSON.stringify(single.afterRevert));
  check('the file revert leaves its neighbour alone', single.keep === 'keep\n', JSON.stringify(single.keep));
  check('the file revert logged no snapshot warning', single.warnings.length === 0, JSON.stringify(single.warnings));
  check('the outside file plan reports success', single.outsidePlan?.kind === 'success', JSON.stringify(single.outsidePlan));
  check(
    'the report names an outside file the way the review tab does',
    String(single.outsidePlan?.text ?? '').includes('../other/b.txt') &&
      !String(single.outsidePlan?.text ?? '').includes(single.repo),
    String(single.outsidePlan?.text),
  );
  check('the outside file plan changes nothing', single.afterOutsidePlan === 'b2\n', JSON.stringify(single.afterOutsidePlan));
  check('the outside file revert reports success', single.outsideApplied?.kind === 'success', JSON.stringify(single.outsideApplied));
  check('the outside file revert writes the snapshot bytes back', single.afterOutsideRevert === 'b1\n', JSON.stringify(single.afterOutsideRevert));
  check('a path outside the repository is refused', single.strayOutcome?.kind === 'error', JSON.stringify(single.strayOutcome));
  check(
    'the refusal says the path is outside the repository',
    String(single.strayOutcome?.text ?? '').includes('不在当前 Git 仓库内'),
    String(single.strayOutcome?.text),
  );
});

// --- 删除会话会移除它拥有的一切 ------------------------------------------
// Host 侧是唯一能删除会话的一侧：浏览器没有文件系统，而会话持久化
// 没有暴露删除操作。因此该命令必须接管日志、投影检查点，以及每一条
// 指名该会话的注册表记录——并且它必须拒绝本进程仍处于打开状态的那个会话，
// 因为其写入者会在下一次刷写时重新创建产物。
const DELETE_COMMAND = 'delete-session';
const deleteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-delete-'));
const targetId = 'session-delete-me';
const targetDir = path.join(deleteHome, 'sessions', '--work--', targetId);
fs.mkdirSync(targetDir, { recursive: true });
const targetLog = path.join(targetDir, 'session.v4.jsonl.zstd');
fs.writeFileSync(targetLog, 'log bytes');
fs.writeFileSync(path.join(targetDir, 'session.lock'), '');
const storageRoot = path.join(deleteHome, 'storages');
const targetCheckpoint = path.join(storageRoot, 'session_projcache', 'sessions', `${targetId}.json`);
fs.mkdirSync(path.dirname(targetCheckpoint), { recursive: true });
fs.writeFileSync(targetCheckpoint, '{"version":7}');

const registryCalls = [];
const deletedServices = () => ({
  sessionPersistence: {
    root: path.join(deleteHome, 'sessions'),
    stat: async (id) =>
      id === targetId
        ? { header: { id, cwd: '/work' }, sizeBytes: 9, location: { kind: 'jsonl', path: targetLog } }
        : undefined,
  },
  workspaceRegistry: {
    unarchiveSession: async (id) => registryCalls.push(`unarchive:${id}`),
    unpinSession: async (id) => registryCalls.push(`unpin:${id}`),
    resolveByPath: async () => ({ detachSession: async (id) => registryCalls.push(`detach:${id}`) }),
  },
  // 两个已注册的根，真正的那个不在首位：由哪个根来服务
  // `session_projcache` 域是路由的决定，因此只取首根的猜测
  // 会悄悄把检查点留在后面。
  storage: {
    backend: {
      names: () => ['decoy', 'json'],
      get: (name) => ({ root: name === 'json' ? storageRoot : path.join(deleteHome, 'decoy-storages') }),
    },
  },
});
const carrierId = 'session-carrier';
const deleteSeam = makeContext({ sessionId: carrierId, session: {}, services: deletedServices() });
apply(deleteSeam.ctx);
const deleteHandler = deleteSeam.commands.find((definition) => definition.name === DELETE_COMMAND)?.handler;

check('the host registers the deletion command', typeof deleteHandler === 'function');

const deletePlan = await deleteHandler({ agent: { id: carrierId }, rawInput: `--id ${targetId} --plan` });
check('a deletion plan reports the artifacts', deletePlan.kind === 'success' && deletePlan.text.includes(targetDir), deletePlan.text);
check('a deletion plan reports the size', String(deletePlan.text).includes('9 B'), deletePlan.text);
check('a deletion plan removes nothing', fs.existsSync(targetLog) && fs.existsSync(targetCheckpoint));

// 本进程处于打开状态的会话会把自己的写入者留在日志上。
const residentSeam = makeContext({ sessionId: targetId, session: {}, services: deletedServices() });
apply(residentSeam.ctx);
const residentHandler = residentSeam.commands.find((definition) => definition.name === DELETE_COMMAND)?.handler;
const residentPlan = await residentHandler({ agent: { id: carrierId }, rawInput: `--id ${targetId} --plan` });
check('a plan for a resident Session reports a refusal', residentPlan.kind === 'error' && residentPlan.text.includes('驻留'), residentPlan.text);
const residentRun = await residentHandler({ agent: { id: carrierId }, rawInput: `--id ${targetId}` });
check('executing against a resident Session fails', residentRun.kind === 'error', residentRun.text);
check('a refused deletion leaves the artifacts alone', fs.existsSync(targetLog) && fs.existsSync(targetCheckpoint));

const deleted = await deleteHandler({ agent: { id: carrierId }, rawInput: `--id ${targetId}` });
check('deleting reports success', deleted.kind === 'success', deleted.text);
check('deleting removes the Session directory', !fs.existsSync(targetDir));
check('deleting removes the projection checkpoint', !fs.existsSync(targetCheckpoint));
check(
  'deleting clears the archive and pin records',
  registryCalls.includes(`unarchive:${targetId}`) && registryCalls.includes(`unpin:${targetId}`),
  JSON.stringify(registryCalls),
);
check('deleting detaches the Session from its workspace', registryCalls.includes(`detach:${targetId}`), JSON.stringify(registryCalls));
check(
  'deleting tells connected Clients the row is gone',
  deleteSeam.emitted.some(([name, id]) => name === 'api-session/removed' && id === targetId),
  JSON.stringify(deleteSeam.emitted),
);

// 该命令绝不能对其采取行动的每一种会话命名方式。
check(
  'a Session cannot delete itself',
  (await deleteHandler({ agent: { id: targetId }, rawInput: `--id ${targetId}` })).kind === 'error',
);
check(
  'a deletion without an id is an error',
  (await deleteHandler({ agent: { id: carrierId }, rawInput: '--plan' })).kind === 'error',
);
check(
  'a deletion with an unknown parameter is an error',
  (await deleteHandler({ agent: { id: carrierId }, rawInput: `--id ${targetId} --purge` })).kind === 'error',
);
const missing = await deleteHandler({ agent: { id: carrierId }, rawInput: '--id session-absent' });
check('an unknown Session is an error', missing.kind === 'error' && missing.text.includes('落盘记录'), missing.text);

// 报出自己根目录之外某个目录的存储，绝不能把一个它并不拥有的路径
// 交给递归删除。
const escapeId = 'session-escape';
const escapeDir = path.join(deleteHome, 'outside', escapeId);
fs.mkdirSync(escapeDir, { recursive: true });
const escapeLog = path.join(escapeDir, 'session.v4.jsonl.zstd');
fs.writeFileSync(escapeLog, 'outside');
const escapeSeam = makeContext({
  sessionId: carrierId,
  session: {},
  services: {
    ...deletedServices(),
    sessionPersistence: {
      root: path.join(deleteHome, 'sessions'),
      stat: async (id) => (id === escapeId ? { header: { id, cwd: '/work' }, location: { kind: 'jsonl', path: escapeLog } } : undefined),
    },
  },
});
apply(escapeSeam.ctx);
const escapeHandler = escapeSeam.commands.find((definition) => definition.name === DELETE_COMMAND)?.handler;
const escaped = await escapeHandler({ agent: { id: carrierId }, rawInput: `--id ${escapeId}` });
check('a directory outside the sessions root is refused', escaped.kind === 'error', escaped.text);
check('a refused escape leaves the file alone', fs.existsSync(escapeLog));

// 该存储会转义尚未成为安全路径段的 id（`~` 变成 `~007E`），因此会话
// 目录并不以原始 id 命名。删除必须识别这种拼写：把它当作“没有产物”
// 会清空注册表，却把日志留在原处。
const oddId = 'session-odd~id';
const oddDir = path.join(deleteHome, 'sessions', '--work--', 'session-odd~007Eid');
fs.mkdirSync(oddDir, { recursive: true });
const oddLog = path.join(oddDir, 'session.v4.jsonl.zstd');
fs.writeFileSync(oddLog, 'odd');
const oddSeam = makeContext({
  sessionId: carrierId,
  session: {},
  services: {
    ...deletedServices(),
    sessionPersistence: {
      root: path.join(deleteHome, 'sessions'),
      stat: async (id) => (id === oddId ? { header: { id, cwd: '/work' }, location: { kind: 'jsonl', path: oddLog } } : undefined),
    },
  },
});
apply(oddSeam.ctx);
const oddHandler = oddSeam.commands.find((definition) => definition.name === DELETE_COMMAND)?.handler;
const oddPlan = await oddHandler({ agent: { id: carrierId }, rawInput: `--id ${oddId} --plan` });
check('an escaped Session segment is located', oddPlan.kind === 'success' && oddPlan.text.includes(oddDir), oddPlan.text);
const oddDeleted = await oddHandler({ agent: { id: carrierId }, rawInput: `--id ${oddId}` });
check(
  'deleting removes an escaped Session directory',
  oddDeleted.kind === 'success' && !fs.existsSync(oddDir),
  oddDeleted.text,
);

// 以第三种方式命名目录的存储无法被核实，而递归移除绝不能猜测：
// 删除会拒绝执行，而不是在日志仍留在磁盘上时清空注册表。
const movedId = 'session-moved';
const movedDir = path.join(deleteHome, 'sessions', '--work--', 'not-the-id');
fs.mkdirSync(movedDir, { recursive: true });
const movedLog = path.join(movedDir, 'session.v4.jsonl.zstd');
fs.writeFileSync(movedLog, 'moved');
const movedSeam = makeContext({
  sessionId: carrierId,
  session: {},
  services: {
    ...deletedServices(),
    sessionPersistence: {
      root: path.join(deleteHome, 'sessions'),
      stat: async (id) => (id === movedId ? { header: { id, cwd: '/work' }, location: { kind: 'jsonl', path: movedLog } } : undefined),
    },
  },
});
apply(movedSeam.ctx);
const movedHandler = movedSeam.commands.find((definition) => definition.name === DELETE_COMMAND)?.handler;
const movedPlan = await movedHandler({ agent: { id: carrierId }, rawInput: `--id ${movedId} --plan` });
check('an unverifiable Session layout is refused', movedPlan.kind === 'error' && movedPlan.text.includes('布局'), movedPlan.text);
const movedRun = await movedHandler({ agent: { id: carrierId }, rawInput: `--id ${movedId}` });
check('a refused layout leaves the log alone', movedRun.kind === 'error' && fs.existsSync(movedLog), movedRun.text);
const movedRemoved = movedSeam.emitted.some(([name, id]) => name === 'api-session/removed' && id === movedId);
check('a refused layout tells no Client the row is gone', movedRemoved === false, JSON.stringify(movedSeam.emitted));
fs.rmSync(deleteHome, { recursive: true, force: true });

// --- 一轮的前像一旦固定就不可变 -----------------------------------------
// 会话在同一个仓库内移动工作目录（`working_directory` 是面向模型的工具）
// 会让插件重新解析仓库坐标。若它因此重拍这一轮，`turn-N` 的 ref 就会被
// 轮次进行中的状态替换：之后 `/revert --turn N` 报告"没有改动"，
// 而真正的前像已经永久丢失。快照的不可变性必须挡住这条路径。
const sameRepoMoveOnce = async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revert-move-'));
  const sessionId = 'session-same-repo-move';
  git(['init', '-q'], repo);
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v0\n');
  git(['add', '-A'], repo);

  /** @type {any[]} */
  const log = [];
  const session = {
    id: sessionId,
    header: { cwd: repo },
    surface: { nodes: [] },
    eventAt: (seq) => log[seq],
    snapshotEvents: () => log,
    append() {
      throw new Error('the move harness never appends to the log');
    },
  };
  const workingDirectory = { get: () => cwd };
  let cwd = repo;
  const { ctx, handlers, commands, warnings } = makeContext({
    sessionId,
    session,
    services: { workingDirectory },
  });
  apply(ctx);
  const asAgent = (rawInput) =>
    commands.find((definition) => definition.name === COMMAND)?.handler({ agent: { id: sessionId }, rawInput });
  const treeOfTurn = () =>
    git(['for-each-ref', '--format=%(objectname)', 'refs/dsh/revert-files'], repo).trim();

  /** @type {any} */
  const opened = { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } };
  log[0] = opened;
  handlers.get('session/event')(session, opened);
  await waitForTurnRef(repo, 1, warnings);
  const refBefore = treeOfTurn();

  // 该轮写入了这个文件，随后把工作目录移到同一个仓库的子目录里。
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v1\n');
  cwd = path.join(repo, 'sub');
  /** @type {any} */
  const moved = { type: 'working-directory/change', seq: 1, time: 0, data: { cwd } };
  log[1] = moved;
  handlers.get('session/event')(session, moved);
  // 下一次文件写入会等待快照完成；那一步绝不能重拍第 1 轮。
  await handlers.get('fs/write-intent')({}, { agent: { id: sessionId } }, () => undefined);
  const refAfter = treeOfTurn();

  const outcome = await asAgent('--turn 1');
  const restored = fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8');
  fs.rmSync(repo, { recursive: true, force: true });
  return { refBefore, refAfter, outcome, restored, warnings };
};

await harness('the same-repository move harness', sameRepoMoveOnce, (moved) => {
  check(
    'moving inside one repository does not repin its turn',
    moved.refAfter === moved.refBefore,
    `${moved.refBefore} -> ${moved.refAfter}`,
  );
  check(
    'the pre-turn snapshot survives the move',
    moved.restored === 'v0\n',
    JSON.stringify(moved.restored),
  );
  check(
    'the revert reports the restored file',
    moved.outcome?.kind === 'success' && String(moved.outcome.text).includes('已写回原文'),
    JSON.stringify(moved.outcome),
  );
  check('the move harness logged no snapshot warning', moved.warnings.length === 0, JSON.stringify(moved.warnings));
});

// --- 只有当前轮的收尾才能把会话判成空闲 ------------------------------------
// 会话事件可能在订阅重放时出现更早轮次的 `turn/end`。如果插件据此认为
// 会话空闲，对话回退就会追加表层替换，而真实请求还在跑 —— 那正是
// `revertConversation` 的 `busy` 守卫要避免的竞争。
const staleEndOnce = async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revert-stale-end-'));
  const sessionId = 'session-stale-end';
  git(['init', '-q'], repo);
  const file = path.join(repo, 'f.txt');
  fs.writeFileSync(file, 'v0\n');
  git(['add', '-A'], repo);

  /** @type {any[]} */
  const log = [];
  /** @type {any[]} */
  const appended = [];
  const push = (event) => {
    log[event.seq] = event;
    return event;
  };
  const session = {
    id: sessionId,
    header: { cwd: repo },
    surface: { nodes: [] },
    eventAt: (seq) => log[seq],
    snapshotEvents: () => log,
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data, ...(opts ?? {}) };
      push(event);
      appended.push(event);
      return event;
    },
  };
  const { ctx, handlers, commands, warnings } = makeContext({ sessionId, session });
  apply(ctx);
  const emit = (event) => {
    push(event);
    handlers.get('session/event')(session, event);
  };
  const asAgent = (rawInput) =>
    commands.find((definition) => definition.name === COMMAND)?.handler({ agent: { id: sessionId }, rawInput });

  push({
    type: 'system/message',
    seq: 0,
    time: 0,
    data: { message: { role: 'system', content: [] } },
    surfaceOp: 'append',
  });
  // 第 1 轮完整地开始并收尾。
  emit({ type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } });
  push({
    type: 'user/message',
    seq: 3,
    time: 0,
    data: { id: 'u1', role: 'user', content: [], source: { kind: 'user' } },
    surfaceOp: 'append',
  });
  emit({ type: 'turn/end', seq: 4, time: 0, data: { turn: 1, reason: { kind: 'completed' } } });
  await waitForTurnRef(repo, 1, warnings);
  fs.writeFileSync(file, 'v1\n');

  // 第 2 轮开始；随后第 1 轮的 `turn/end` 又迟到了一次。
  emit({ type: 'turn/start', seq: 5, time: 0, data: { turn: 2 } });
  await waitForTurnRef(repo, 2, warnings);
  fs.writeFileSync(file, 'v2\n');
  emit({ type: 'turn/end', seq: 6, time: 0, data: { turn: 1, reason: { kind: 'completed' } } });
  session.surface.nodes = [0, 3];

  const outcome = await asAgent('--turn 1');
  const appendedByRevert = appended.length;
  const restored = fs.readFileSync(file, 'utf8');
  fs.rmSync(repo, { recursive: true, force: true });
  return { outcome, appendedByRevert, restored, warnings };
};

await harness('the stale turn/end harness', staleEndOnce, (stale) => {
  check(
    'a late turn/end does not mark the running session idle',
    String(stale.outcome?.text ?? '').includes('会话正在运行'),
    JSON.stringify(stale.outcome),
  );
  check(
    'a late turn/end leaves the conversation alone',
    stale.appendedByRevert === 0,
    String(stale.appendedByRevert),
  );
  check('the files are still restored', stale.restored === 'v0\n', JSON.stringify(stale.restored));
  check('the stale-end harness logged no snapshot warning', stale.warnings.length === 0, JSON.stringify(stale.warnings));
});

// --- 重命名按"旧路径写回、新路径删除"处理 --------------------------------
// `git diff --name-status -z` 对一次重命名输出 `R100\0old\0new\0`：
// 一条记录带两个路径。按固定二元组解析会把之后每条记录都读错，
// 确认卡片于是既不说明新路径会被删掉，也会漏掉旧路径会被写回。
// 单文件入口更危险：只删新路径会让文件从工作区净消失。
const renameOnce = async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revert-rename-'));
  const sessionId = 'session-rename-test';
  const original = path.join(repo, 'alpha_original.ts');
  const renamed = path.join(repo, 'alpha_renamed.ts');
  git(['init', '-q'], repo);
  const originalBytes = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
  fs.writeFileSync(original, originalBytes);
  git(['add', '-A'], repo);

  /** @type {any[]} */
  const log = [];
  const session = {
    id: sessionId,
    header: { cwd: repo },
    surface: { nodes: [] },
    eventAt: (seq) => log[seq],
    snapshotEvents: () => log,
    append() {
      throw new Error('a file revert never touches the conversation');
    },
  };
  const SEQ = 7;
  const summary = { turn: 1, cwd: repo, files: [{ path: 'alpha_renamed.ts', display: 'alpha_renamed.ts' }] };
  const { ctx, handlers, commands, warnings } = makeContext({
    sessionId,
    session,
    services: { workspaceChanges: { summary: (id, seq) => (id === sessionId && seq === SEQ ? summary : undefined) } },
  });
  apply(ctx);
  const asAgent = (rawInput) =>
    commands.find((definition) => definition.name === COMMAND)?.handler({ agent: { id: sessionId }, rawInput });

  /** @type {any} */
  const opened = { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } };
  log[0] = opened;
  handlers.get('session/event')(session, opened);
  await waitForTurnRef(repo, 1, warnings);

  // 该轮把文件改名并修改了内容。
  git(['mv', 'alpha_original.ts', 'alpha_renamed.ts'], repo);
  fs.writeFileSync(renamed, 'line 1\nline 2\nline three\nline 4\nline 5\n');

  // 真实接缝会真的删除；默认桩什么都不做，而重命名的目的地
  // 正是走"从工作区删除"这条分支。
  ctx.fs.deleteFile = async (target) => fs.rmSync(target, { force: true });
  const turnPlan = await asAgent('--turn 1 --plan');
  const filePlan = await asAgent(`--seq ${SEQ} --index 0 --plan`);
  const outcome = await asAgent(`--seq ${SEQ} --index 0`);
  const restored = fs.existsSync(original) ? fs.readFileSync(original, 'utf8') : 'MISSING';
  const renamedGone = !fs.existsSync(renamed);
  fs.rmSync(repo, { recursive: true, force: true });
  return { turnPlan, filePlan, outcome, restored, renamedGone, originalBytes, warnings };
};

await harness('the rename harness', renameOnce, (renamed) => {
  const plan = String(renamed.turnPlan?.text ?? '');
  check('the turn plan lists the renamed-from path', plan.includes('alpha_original.ts'), plan);
  check('the turn plan lists the renamed-to path', plan.includes('alpha_renamed.ts'), plan);
  check(
    'the turn plan says the old path is restored and the new one deleted',
    plan.includes('alpha_original.ts（已删除，将还原）') && plan.includes('alpha_renamed.ts（新增，将删除）'),
    plan,
  );
  const filePlan = String(renamed.filePlan?.text ?? '');
  check(
    'the file plan calls out the rename',
    filePlan.includes('这是一次重命名') && filePlan.includes('alpha_original.ts'),
    filePlan,
  );
  check(
    'the file revert writes the original bytes back',
    renamed.restored === renamed.originalBytes,
    JSON.stringify(renamed.restored),
  );
  check('the file revert removes the renamed path', renamed.renamedGone === true, String(renamed.renamedGone));
  check('the rename harness logged no snapshot warning', renamed.warnings.length === 0, JSON.stringify(renamed.warnings));
});

// --- 反悔点保存的是"这次回退覆盖掉的状态" --------------------------------
// 回退前的状态不属于任何一轮的前像：`turn-2` 的快照只保存"第 2 轮开始前"
// （也就是第 1 轮结束时）的内容。让用户执行 `/revert --turn 2` 会把他们
// 带到更早的状态。正确的做法是在动工作区之前先把"现在"固定成一个
// 独立的反悔点，并在报告里给出它的令牌。
const undoOnce = async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revert-undo-'));
  const sessionId = 'session-undo-test';
  const file = path.join(repo, 'f.txt');
  git(['init', '-q'], repo);
  fs.writeFileSync(file, 'v0\n');
  git(['add', '-A'], repo);

  /** @type {any[]} */
  const log = [];
  let seq = 0;
  const session = {
    id: sessionId,
    header: { cwd: repo },
    surface: { nodes: [] },
    eventAt: (at) => log[at],
    snapshotEvents: () => log,
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data, ...(opts ?? {}) };
      log.push(event);
      return event;
    },
  };
  const { ctx, handlers, commands, warnings } = makeContext({ sessionId, session });
  apply(ctx);
  const asAgent = (rawInput) =>
    commands.find((definition) => definition.name === COMMAND)?.handler({ agent: { id: sessionId }, rawInput });
  const emit = (event) => {
    log.push(event);
    handlers.get('session/event')(session, event);
  };

  for (const turn of [1, 2, 3]) {
    emit({ type: 'turn/start', seq: (seq += 1), time: 0, data: { turn } });
    await waitForTurnRef(repo, turn, warnings);
    fs.writeFileSync(file, `v${turn}\n`);
    emit({ type: 'turn/end', seq: (seq += 1), time: 0, data: { turn, reason: { kind: 'completed' } } });
  }

  const first = await asAgent('--turn 1');
  const afterRevert = fs.readFileSync(file, 'utf8');
  const token = /\/revert --undo (\d+)/.exec(String(first.text))?.[1];
  const undoPlan = await asAgent(`--undo ${token} --plan`);
  const undo = await asAgent(`--undo ${token}`);
  const afterUndo = fs.readFileSync(file, 'utf8');
  const secondToken = /\/revert --undo (\d+)/.exec(String(undo.text))?.[1];
  const backAgain = secondToken === undefined ? undefined : await asAgent(`--undo ${secondToken}`);
  const afterSecondUndo = fs.readFileSync(file, 'utf8');
  const missing = await asAgent('--undo 999999999');
  const conflicted = await asAgent('--undo 1 --turn 1');
  const evilUndo = await asAgent('--undo abc');

  fs.rmSync(repo, { recursive: true, force: true });
  return {
    first,
    afterRevert,
    token,
    undoPlan,
    undo,
    afterUndo,
    secondToken,
    backAgain,
    afterSecondUndo,
    missing,
    conflicted,
    evilUndo,
    warnings,
  };
};

await harness('the undo harness', undoOnce, (undo) => {
  check('the revert restores the first turn', undo.afterRevert === 'v0\n', JSON.stringify(undo.afterRevert));
  check(
    'the report offers an undo token',
    typeof undo.token === 'string' && undo.token !== '',
    String(undo.token),
  );
  check(
    'the undo plan previews the pre-revert state',
    undo.undoPlan?.kind === 'success' && String(undo.undoPlan.text).includes('f.txt'),
    JSON.stringify(undo.undoPlan),
  );
  check('the undo restores the state the revert replaced', undo.afterUndo === 'v3\n', JSON.stringify(undo.afterUndo));
  check(
    'the undo offers its own undo point',
    typeof undo.secondToken === 'string' && undo.secondToken !== '',
    String(undo.secondToken),
  );
  check(
    'undoing the undo returns to the reverted state',
    undo.afterSecondUndo === 'v0\n',
    JSON.stringify(undo.afterSecondUndo),
  );
  check(
    'an unknown undo token is an error',
    undo.missing?.kind === 'error' && String(undo.missing.text).includes('不存在'),
    JSON.stringify(undo.missing),
  );
  check('--undo cannot be combined with --turn', undo.conflicted?.kind === 'error', JSON.stringify(undo.conflicted));
  check('a non-numeric --undo is refused', undo.evilUndo?.kind === 'error', JSON.stringify(undo.evilUndo));
  check('the undo harness logged no snapshot warning', undo.warnings.length === 0, JSON.stringify(undo.warnings));
});

// --- 工具通道与命令通道一样严格 ------------------------------------------
// `/revert --turn 0` 会被解析器拒绝，而回退不可撤销；工具通道的
// `turn` 也必须拒绝 0、负数和分数，而不是悄悄回落到"当前轮"。
const toolSeam = makeContext({ sessionId: 'session-tool-turn', session: {} });
apply(toolSeam.ctx);
const revertTool = toolSeam.tools.find((tool) => tool.name === 'revert_files');
const asTool = (arguments_) => revertTool.execute(arguments_, { agent: { id: 'session-tool-turn' } });
const refusedTurns = {
  zero: await asTool({ action: 'revert', turn: 0 }),
  negative: await asTool({ action: 'revert', turn: -3 }),
  fractional: await asTool({ action: 'revert', turn: 1.5 }),
};
for (const [label, value] of Object.entries(refusedTurns)) {
  check(
    `the tool refuses a ${label} turn`,
    String(value?.text ?? '').includes('大于 0 的整数'),
    JSON.stringify(value),
  );
}
check('the tool still exposes list/plan/revert', typeof revertTool?.execute === 'function');

for (const line of results) console.log(line);

const failed = results.filter((line) => line.startsWith('FAIL'));
console.log(failed.length === 0 ? 'ALL PASS' : 'FAILURES');
if (failed.length > 0) process.exitCode = 1;
