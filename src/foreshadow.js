'use strict';

/**
 * 伏笔回收路线校验
 *
 * 作者指定一对「铺垫场景 / 回收场景」后，在编辑中草稿展开出的
 * 「场景 + 完整变量状态」具体状态图上，把**待回收标记**并入遍历状态：
 *
 *   1. 从起点场景（初始状态 = 起点场景的进入赋值）BFS 展开具体状态，
 *      去重键为 场景ID + 待回收标记 + 变量位图 —— 同一局面在“待回收 /
 *      已回收”两种标记下是不同节点，因此“先埋伏笔再绕路回收”的路线
 *      不会被错误合并；节点数 ≤ 场景数 × 2 × 2^n，含循环也必然终止，
 *      另有 maxStates 安全上限（与分析器一致），超限即截断；
 *   2. 每次**进入铺垫场景**时把待回收标记置位，**进入回收场景**时清除
 *      （起点场景若即铺垫场景，初始即待回收）；
 *   3. 设计结局 = 本身没有任何选项的场景（与结局概率推演 / 结局必经抉择
 *      的 ending 定义一致；有选项但全部不可走的死局不算设计结局）。
 *      到达设计结局的具体状态时待回收标记仍置位 => 违规：
 *      存在一条“埋下伏笔却未经回收就完结”的路线。
 *
 * 违规路线取**选项步数最短**者：BFS 按层提供状态，首次在提供（offer）时
 * 命中的违规结局即全局最短，找到即停，截断与否不影响该结论。
 *
 * 判定（verdict）：
 *   violation        发现违规，附最短违规路线与沿途变量状态；
 *   pass             通过 —— 仅在完整探索（未截断）、铺垫场景可达、
 *                    且存在可达设计结局三者同时成立时给出；
 *   setupUnreachable 完整探索后铺垫场景仍不可达（伏笔从未被埋下，
 *                    校验无意义，单独提示，不判通过）；
 *   noEnding         完整探索后没有任何可达设计结局（没有可校验的
 *                    终点，单独提示，不判通过）；
 *   truncated        状态上限截断：已探索范围内未发现违规，但未探索
 *                    区域可能存在，不能断言无违规（单独提示）；
 *   startBlocked     起点前置条件在初始状态下不成立，没有任何可达状态。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * 对剧情（草稿或已保存）执行伏笔回收路线校验。
 *
 * @param storyInput 剧情对象
 * @param queryInput { setupScene, payoffScene } 铺垫场景 / 回收场景（必须不同）
 * @param opts       { maxStates } 测试可注入更小的状态上限
 */
function checkForeshadow(storyInput, queryInput, opts = {}) {
  const story = storyInput || {};
  const query = queryInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }

  const setupScene = String(query.setupScene || '').trim();
  const payoffScene = String(query.payoffScene || '').trim();
  if (!setupScene) throw badRequest('缺少铺垫场景 setupScene');
  if (!payoffScene) throw badRequest('缺少回收场景 payoffScene');
  if (!sceneMap.has(setupScene)) throw badRequest(`铺垫场景 "${setupScene}" 不存在`);
  if (!sceneMap.has(payoffScene)) throw badRequest(`回收场景 "${payoffScene}" 不存在`);
  if (setupScene === payoffScene) throw badRequest('铺垫场景与回收场景不能相同');
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法执行伏笔回收校验');
  }

  // ---- 编译条件（语法错误按恒真处理，与分析器 / 路径查询等模块一致） ----
  const conditionErrors = [];
  const safeCompile = (raw, where) => {
    try {
      return compile(raw);
    } catch (e) {
      conditionErrors.push({ where, message: e.message });
      return null;
    }
  };
  const sceneCond = new Map();
  const sceneAssigns = new Map();
  const optionCompiled = new Map(); // `${sceneId}#${idx}` -> { cond, assigns }
  for (const scene of scenes) {
    if (!scene || !scene.id) continue;
    sceneCond.set(scene.id, safeCompile(scene.precondition, `场景 "${scene.id}" 的前置条件`));
    sceneAssigns.set(scene.id, (scene.assigns || []).filter((a) => a && a.variable));
    (scene.options || []).forEach((opt, idx) => {
      optionCompiled.set(`${scene.id}#${idx}`, {
        cond: safeCompile(opt && opt.condition, `场景 "${scene.id}" 选项 ${idx + 1} 的条件`),
        assigns: ((opt && opt.assigns) || []).filter((a) => a && a.variable),
      });
    });
  }

  // 状态空间变量 = 已声明变量 ∪ 赋值中出现的变量（与分析器一致）
  const knownVars = collectStateVars({ ...story, scenes });

  const setupTitle = (sceneMap.get(setupScene) || {}).title || '';
  const payoffTitle = (sceneMap.get(payoffScene) || {}).title || '';

  const baseResult = {
    ok: true,
    verdict: null,
    passed: false,
    truncated: false,
    startBlocked: false,
    startScene: story.startScene,
    setupScene,
    setupTitle,
    setupReachable: false,
    setupStates: 0,
    payoffScene,
    payoffTitle,
    payoffReachable: false,
    payoffStates: 0,
    designedEndings: [],
    counts: { states: 0, transitions: 0, variables: knownVars.length, designedEndings: 0 },
    violation: null,
    knownVars,
    conditionErrors,
    statesExplored: 0,
    maxStates,
    message: '',
  };

  // ---- 起点：初始状态 = 起点场景的进入赋值；前置不成立则没有任何可达状态 ----
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));
  if (startBlocked) {
    return {
      ...baseResult,
      verdict: 'startBlocked',
      startBlocked: true,
      message: '起点场景的前置条件在初始状态下不成立，剧情无法开始：'
        + '铺垫不可达、没有任何可达结局，无法执行伏笔回收校验。',
    };
  }

  // ---- BFS：去重键 = 场景 + 待回收标记 + 变量位图 ----
  const visited = new Set();
  const parent = new Map(); // key -> { parentKey, depth, edge, sceneId, pending, code }
  const keyOf = (id, pending, code) => `${id}\x00${pending ? 1 : 0}\x00${code}`;
  const queue = [];
  let truncated = false;
  let statesExplored = 0;
  let transitionCount = 0;
  let violationKey = null;

  const setupCodes = new Set();             // 进入铺垫场景时的变量位图集合（用于可达判定）
  const payoffCodes = new Set();
  const designedEndingStates = new Map();   // sceneId -> Set<code>（到达设计结局的具体状态）

  const offer = (sceneId, pending, code, depth, predKey, edge) => {
    if (truncated || violationKey) return;
    const key = keyOf(sceneId, pending, code);
    if (visited.has(key)) return;
    visited.add(key);
    statesExplored++;
    parent.set(key, { parentKey: predKey, depth, edge, sceneId, pending, code });
    if (sceneId === setupScene) setupCodes.add(code);
    else if (sceneId === payoffScene) payoffCodes.add(code);

    const scene = sceneMap.get(sceneId);
    if ((scene.options || []).length === 0) {
      // 设计结局（无选项的终止场景）：到达即终止，无需入队扩展
      if (!designedEndingStates.has(sceneId)) designedEndingStates.set(sceneId, new Set());
      designedEndingStates.get(sceneId).add(code);
      if (pending) { violationKey = key; return; } // BFS 按层提供：首次命中即全局最短
    }
    if (statesExplored > maxStates) { truncated = true; return; }
    queue.push({ sceneId, pending, code, depth, key });
  };

  // 起点场景若即铺垫场景，初始即待回收（起点若即回收场景，初始本就不待回收）
  offer(story.startScene, story.startScene === setupScene,
    encodeState(startState, knownVars), 0, null, null);

  let head = 0;
  while (head < queue.length && !truncated && !violationKey) {
    const cur = queue[head++];
    const scene = sceneMap.get(cur.sceneId);
    const state = decodeState(cur.code, knownVars);

    (scene.options || []).forEach((option, idx) => {
      if (truncated || violationKey) return;
      const oc = optionCompiled.get(`${cur.sceneId}#${idx}`);
      if (oc && oc.cond && !oc.cond.evaluate(state)) return; // 条件不成立：此状态下不可走
      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return;      // 悬空跳转：不构成边
      let nextState = state;
      if (oc && oc.assigns.length) nextState = applyAssigns(nextState, oc.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const tc = sceneCond.get(targetId);
      if (tc && !tc.evaluate(nextState)) return;             // 入口前置不成立：不构成边

      // 待回收标记并入遍历：进入铺垫场景置位，进入回收场景清除，其余场景保持
      const nextPending = targetId === setupScene ? true
        : (targetId === payoffScene ? false : cur.pending);
      transitionCount++;
      offer(targetId, nextPending, encodeState(nextState, knownVars), cur.depth + 1, cur.key, {
        optionIndex: idx,
        optionUid: (option && option.uid) || null,
        optionText: (option && option.text) || '',
        fromSceneId: cur.sceneId,
        target: targetId,
        targetTitle: (sceneMap.get(targetId) || {}).title || '',
      });
    });
  }

  // 路径重建：scene / option 交替；场景节点带到达时的完整变量状态与待回收标记，
  // 选项边带选择后（含目标场景进入赋值）的状态 stateAfter —— 即“沿途变量状态”
  const buildPath = (key) => {
    const trail = [];
    let k = key;
    while (k) {
      const p = parent.get(k);
      const sc = sceneMap.get(p.sceneId);
      const state = decodeState(p.code, knownVars);
      trail.push({
        kind: 'scene',
        sceneId: p.sceneId,
        title: sc ? (sc.title || '') : '',
        state,
        pending: p.pending,
        role: p.sceneId === setupScene ? 'setup'
          : (p.sceneId === payoffScene ? 'payoff' : null),
      });
      if (p.edge) trail.push({ kind: 'option', ...p.edge, stateAfter: state });
      k = p.parentKey;
    }
    trail.reverse();
    return trail;
  };

  const designedEndings = [...designedEndingStates.entries()]
    .map(([sceneId, codes]) => ({
      sceneId,
      title: (sceneMap.get(sceneId) || {}).title || '',
      states: codes.size,
    }))
    .sort((a, b) => a.sceneId.localeCompare(b.sceneId));

  const result = {
    ...baseResult,
    truncated,
    setupReachable: setupCodes.size > 0,
    setupStates: setupCodes.size,
    payoffReachable: payoffCodes.size > 0,
    payoffStates: payoffCodes.size,
    designedEndings,
    counts: {
      states: statesExplored,
      transitions: transitionCount,
      variables: knownVars.length,
      designedEndings: designedEndings.length,
    },
    statesExplored,
  };

  // ---- 判定 ----
  if (violationKey) {
    const p = parent.get(violationKey);
    const endScene = sceneMap.get(p.sceneId);
    result.verdict = 'violation';
    result.violation = {
      endingScene: p.sceneId,
      endingTitle: endScene ? (endScene.title || '') : '',
      depth: p.depth,
      finalState: decodeState(p.code, knownVars),
      path: buildPath(violationKey),
    };
    result.message = `到达设计结局 "${p.sceneId}" 时伏笔仍待回收（未曾进入回收场景 "${payoffScene}"）：`
      + `最短违规路线 ${p.depth} 步，沿途变量状态如下。`;
    return result;
  }

  if (truncated) {
    result.verdict = 'truncated';
    result.message = `已探索 ${statesExplored} 个具体状态（达到安全上限 ${maxStates}）后搜索被截断：`
      + '已探索范围内未发现违规，但未探索区域可能存在到达设计结局时仍待回收的路线，'
      + '不能断言无违规。请减少变量数量后重试。';
    return result;
  }

  if (setupCodes.size === 0) {
    result.verdict = 'setupUnreachable';
    result.message = `已完整探索全部 ${statesExplored} 个可达具体状态：铺垫场景 "${setupScene}" 不可达，`
      + '伏笔从未被埋下，校验无意义（不判通过）。请先修复铺垫场景的可达性。';
    return result;
  }

  if (designedEndings.length === 0) {
    result.verdict = 'noEnding';
    result.message = `已完整探索全部 ${statesExplored} 个可达具体状态：`
      + '没有任何可达的设计结局（无选项的终止场景），没有可校验伏笔回收的终点（不判通过）。'
      + '注意：有选项但全部不可走的死局不算设计结局。';
    return result;
  }

  result.verdict = 'pass';
  result.passed = true;
  result.message = `已完整探索全部 ${statesExplored} 个可达具体状态：铺垫场景可达、`
    + `${designedEndings.length} 个设计结局可达，且所有到达设计结局的路线在进入结局前`
    + `都已进入回收场景 "${payoffScene}" 清除待回收标记，未发现违规。`;
  return result;
}

module.exports = { checkForeshadow };
