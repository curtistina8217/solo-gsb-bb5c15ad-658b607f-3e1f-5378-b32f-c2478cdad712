'use strict';

// 伏笔回收路线校验自检（node test/foreshadow.js）
// 覆盖：通过判定（完整探索 + 铺垫可达 + 存在可达设计结局）、
//       违规检测与最短违规路线（按选项步数）、沿途变量状态、
//       待回收标记并入遍历去重（同场景同变量、不同待回收 = 不同节点）、
//       铺垫不可达 / 无设计结局 / 状态上限截断的单独提示、
//       回收不可达 => 违规、循环终止性、起点受阻、参数校验、HTTP API。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreshadow-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { checkForeshadow } = require('../src/foreshadow');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };

// ---------- 通过：铺垫 -> 回收 -> 结局，所有路线都回收 ----------
console.log('通过判定（pass）：');
const passStory = {
  startScene: 's',
  scenes: [
    { id: 's', options: [{ uid: 'o1', text: '出发', target: 'sc' }] },
    { id: 'sc', title: '铺垫', options: [{ uid: 'o2', text: '继续', target: 'pc' }] },
    { id: 'pc', title: '回收', options: [{ uid: 'o3', text: '完结', target: 'end' }] },
    { id: 'end', title: '结局', options: [] },
  ],
};
const r1 = checkForeshadow(passStory, { setupScene: 'sc', payoffScene: 'pc' });
ok('全部路线回收伏笔 => verdict=pass 且 passed', r1.verdict === 'pass' && r1.passed === true);
ok('铺垫 / 回收均可达', r1.setupReachable === true && r1.payoffReachable === true);
ok('可达设计结局为 end', r1.designedEndings.length === 1 && r1.designedEndings[0].sceneId === 'end');
ok('无违规路线', r1.violation === null && r1.truncated === false);
ok('通过文案说明完整探索', /完整探索/.test(r1.message) && /未发现违规/.test(r1.message));

// ---------- 违规：一条路线未经回收直达结局 ----------
console.log('违规检测与最短违规路线：');
const violStory = {
  startScene: 's',
  variables: ['met'],
  scenes: [
    { id: 's', options: [{ uid: 'o1', text: '出发', target: 'sc' }] },
    {
      id: 'sc', title: '铺垫', assigns: [{ variable: 'met', value: true }],
      options: [{ uid: 'o2', text: '继续', target: 'mid' }],
    },
    {
      id: 'mid', options: [
        { uid: 'o3', text: '直接完结（违规）', target: 'end' },
        { uid: 'o4', text: '先去回收', target: 'pc' },
      ],
    },
    { id: 'pc', title: '回收', options: [{ uid: 'o5', text: '回收后完结', target: 'end2' }] },
    { id: 'end', title: '结局A', options: [] },
    { id: 'end2', title: '结局B', options: [] },
  ],
};
const r2 = checkForeshadow(violStory, { setupScene: 'sc', payoffScene: 'pc' });
ok('存在未回收路线 => verdict=violation 且不通过', r2.verdict === 'violation' && r2.passed === false);
ok('违规结局为 end（最短 3 步：s->sc->mid->end）',
  r2.violation.endingScene === 'end' && r2.violation.depth === 3);
ok('违规路线场景序列 s,sc,mid,end',
  r2.violation.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(',') === 's,sc,mid,end');
ok('违规路线选项序列 o1,o2,o3（按选项步数）',
  r2.violation.path.filter((n) => n.kind === 'option').map((n) => n.optionUid).join(',') === 'o1,o2,o3');
ok('沿途变量状态：进入铺垫后 met=true 并保持到结局',
  r2.violation.path.filter((n) => n.kind === 'scene').every((n) => n.state.met === (n.sceneId === 's' ? false : true)));
ok('待回收标记：铺垫起置位、结局仍待回收',
  r2.violation.path.filter((n) => n.kind === 'scene').map((n) => !!n.pending).join(',') === 'false,true,true,true');
ok('路线节点标注铺垫角色', r2.violation.path.some((n) => n.kind === 'scene' && n.role === 'setup'));
ok('违规路线终点状态即 finalState', r2.violation.finalState.met === true);

// 最短违规：两条违规路线取更短者
const twoViol = {
  startScene: 's',
  scenes: [
    { id: 's', options: [{ uid: 'o1', text: '出发', target: 'sc' }] },
    {
      id: 'sc', options: [
        { uid: 'o2', text: '近结局', target: 'endNear' },
        { uid: 'o3', text: '绕远', target: 'm1' },
      ],
    },
    { id: 'm1', options: [{ uid: 'o4', text: '再绕', target: 'm2' }] },
    { id: 'm2', options: [{ uid: 'o5', text: '远结局', target: 'endFar' }] },
    { id: 'endNear', options: [] },
    { id: 'endFar', options: [] },
    { id: 'pc', options: [] },
  ],
};
const r3 = checkForeshadow(twoViol, { setupScene: 'sc', payoffScene: 'pc' });
ok('多条违规路线时报告最短者（endNear，2 步）',
  r3.verdict === 'violation' && r3.violation.endingScene === 'endNear' && r3.violation.depth === 2);

// ---------- 待回收标记并入遍历去重 ----------
console.log('待回收标记并入遍历：');
const mergeStory = {
  startScene: 's',
  scenes: [
    {
      id: 's', options: [
        { uid: 'o1', text: '直达汇合', target: 'A' },
        { uid: 'o2', text: '先去铺垫', target: 'sc' },
      ],
    },
    { id: 'sc', options: [{ uid: 'o3', text: '回到汇合', target: 'A' }] },
    { id: 'A', options: [{ uid: 'o4', text: '完结', target: 'end' }] },
    { id: 'end', options: [] },
    { id: 'pc', options: [] },
  ],
};
const r4 = checkForeshadow(mergeStory, { setupScene: 'sc', payoffScene: 'pc' });
ok('同场景同变量、不同待回收不合并：干净路线不掩盖违规路线',
  r4.verdict === 'violation' && r4.violation.endingScene === 'end' && r4.violation.depth === 3);
ok('违规路线经过铺垫场景（s->sc->A->end）',
  r4.violation.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(',') === 's,sc,A,end');

// 循环 + 变量：带待回收标记的循环必然终止
const loopStory = {
  startScene: 's',
  variables: ['x'],
  scenes: [
    { id: 's', options: [{ uid: 'o1', text: '出发', target: 'sc' }] },
    {
      id: 'sc', options: [
        { uid: 'o2', text: '标记', condition: '!x', target: 'sc', assigns: [{ variable: 'x', value: true }] },
        { uid: 'o3', text: '离开', condition: 'x', target: 'pc' },
      ],
    },
    { id: 'pc', options: [{ uid: 'o4', text: '完结', target: 'end' }] },
    { id: 'end', options: [] },
  ],
};
const r5 = checkForeshadow(loopStory, { setupScene: 'sc', payoffScene: 'pc' });
ok('含循环剧情必然终止且通过', r5.verdict === 'pass' && r5.truncated === false);
ok('循环剧情状态数 = s + sc×2 + pc + end = 5', r5.statesExplored === 5);

// ---------- 铺垫不可达：单独提示 ----------
console.log('铺垫不可达（setupUnreachable）：');
const noSetup = {
  startScene: 's',
  scenes: [
    { id: 's', options: [{ uid: 'o1', text: '完结', target: 'end' }] },
    { id: 'end', options: [] },
    { id: 'sc', options: [{ uid: 'o2', text: '孤岛', target: 'end' }] },
    { id: 'pc', options: [] },
  ],
};
const r6 = checkForeshadow(noSetup, { setupScene: 'sc', payoffScene: 'pc' });
ok('铺垫不可达 => verdict=setupUnreachable 且不通过',
  r6.verdict === 'setupUnreachable' && r6.passed === false);
ok('铺垫 / 回收均不可达', r6.setupReachable === false && r6.payoffReachable === false);
ok('单独提示文案（不判通过）', /不可达/.test(r6.message) && /不判通过/.test(r6.message));

// ---------- 无设计结局：单独提示（死局不算设计结局） ----------
console.log('无设计结局（noEnding）：');
const noEnding = {
  startScene: 's',
  scenes: [
    { id: 's', options: [{ uid: 'o1', text: '去铺垫', target: 'sc' }] },
    // sc 有选项但条件恒假 => 死局（不是设计结局）
    { id: 'sc', options: [{ uid: 'o2', text: '走不通', condition: 'ghost', target: 'end' }] },
    { id: 'end', options: [] },
    { id: 'pc', options: [] },
  ],
};
const r7 = checkForeshadow(noEnding, { setupScene: 'sc', payoffScene: 'pc' });
ok('死局不算设计结局 => verdict=noEnding 且不通过',
  r7.verdict === 'noEnding' && r7.passed === false && r7.designedEndings.length === 0);
ok('铺垫可达但无结局可校验', r7.setupReachable === true);
ok('单独提示文案（无设计结局）', /没有任何可达的设计结局/.test(r7.message));

// ---------- 状态上限截断：单独提示 ----------
console.log('状态上限截断（truncated）：');
const r8 = checkForeshadow(passStory, { setupScene: 'sc', payoffScene: 'pc' }, { maxStates: 2 });
ok('达到状态上限 => verdict=truncated 且不通过',
  r8.verdict === 'truncated' && r8.truncated === true && r8.passed === false);
ok('截断提示不能断言无违规', /截断/.test(r8.message) && /不能断言无违规/.test(r8.message));

// 违规命中优先于截断：违规在截断边界前被发现仍如实报告
const earlyViol = {
  startScene: 'sc', // 起点即铺垫
  scenes: [
    { id: 'sc', options: [{ uid: 'o1', text: '直接完结', target: 'end' }] },
    { id: 'end', options: [] },
    { id: 'pc', options: [] },
  ],
};
const r9 = checkForeshadow(earlyViol, { setupScene: 'sc', payoffScene: 'pc' }, { maxStates: 1 });
ok('起点即铺垫且直达结局 => 违规（depth 1），不被截断吞掉',
  r9.verdict === 'violation' && r9.violation.depth === 1 && r9.truncated === false);

// ---------- 回收场景不可达 => 待回收永远不清除 => 违规 ----------
console.log('回收场景不可达：');
const noPayoff = {
  startScene: 's',
  scenes: [
    { id: 's', options: [{ uid: 'o1', text: '出发', target: 'sc' }] },
    { id: 'sc', options: [{ uid: 'o2', text: '完结', target: 'end' }] },
    { id: 'end', options: [] },
    { id: 'pc', options: [] },
  ],
};
const r10 = checkForeshadow(noPayoff, { setupScene: 'sc', payoffScene: 'pc' });
ok('回收不可达 => 违规且 payoffReachable=false',
  r10.verdict === 'violation' && r10.payoffReachable === false && r10.violation.depth === 2);

// ---------- 起点受阻 ----------
console.log('起点受阻（startBlocked）：');
const r11 = checkForeshadow({
  startScene: 's', variables: ['k'],
  scenes: [
    { id: 's', precondition: 'k', options: [{ uid: 'o1', text: 'x', target: 'sc' }] },
    { id: 'sc', options: [] },
    { id: 'pc', options: [] },
  ],
}, { setupScene: 'sc', payoffScene: 'pc' });
ok('起点被挡 => verdict=startBlocked 且不通过',
  r11.verdict === 'startBlocked' && r11.startBlocked === true && r11.passed === false);

// ---------- 条件语法错误容错 ----------
const r12 = checkForeshadow({
  startScene: 's',
  scenes: [
    { id: 's', options: [{ uid: 'o1', text: 'x', condition: 'k &&', target: 'sc' }] },
    { id: 'sc', options: [{ uid: 'o2', text: 'y', target: 'pc' }] },
    { id: 'pc', options: [{ uid: 'o3', text: 'z', target: 'end' }] },
    { id: 'end', options: [] },
  ],
}, { setupScene: 'sc', payoffScene: 'pc' });
ok('语法错误的条件按恒真处理并记录', r12.verdict === 'pass' && r12.conditionErrors.length === 1);

// ---------- 参数校验 ----------
console.log('参数校验：');
const throws400 = (fn, re) => {
  try { fn(); } catch (e) { return e.status === 400 && re.test(e.message); }
  return false;
};
ok('缺少铺垫场景 => 400', throws400(() => checkForeshadow(passStory, { payoffScene: 'pc' }), /铺垫场景/));
ok('缺少回收场景 => 400', throws400(() => checkForeshadow(passStory, { setupScene: 'sc' }), /回收场景/));
ok('铺垫场景不存在 => 400', throws400(() => checkForeshadow(passStory, { setupScene: 'ghost', payoffScene: 'pc' }), /铺垫场景 "ghost" 不存在/));
ok('回收场景不存在 => 400', throws400(() => checkForeshadow(passStory, { setupScene: 'sc', payoffScene: 'ghost' }), /回收场景 "ghost" 不存在/));
ok('铺垫与回收相同 => 400', throws400(() => checkForeshadow(passStory, { setupScene: 'sc', payoffScene: 'sc' }), /不能相同/));
ok('缺少起点 => 400', throws400(() => checkForeshadow({ scenes: [{ id: 'a' }, { id: 'b' }] }, { setupScene: 'a', payoffScene: 'b' }), /起点/));
ok('起点不存在 => 400', throws400(() => checkForeshadow({ startScene: 'ghost', scenes: [{ id: 'a' }, { id: 'b' }] }, { setupScene: 'a', payoffScene: 'b' }), /起点/));

// ---------- HTTP API ----------
(async () => {
  console.log('HTTP API：');
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const req = (method, url, body) => new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: url, method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });

  try {
    // 草稿校验（不落盘）：{ story, query } 形式
    const q1 = await req('POST', '/api/foreshadow', {
      story: violStory, query: { setupScene: 'sc', payoffScene: 'pc' },
    });
    ok('POST /api/foreshadow 返回 200 且检出违规',
      q1.status === 200 && q1.body.verdict === 'violation' && q1.body.violation.depth === 3);

    const q1b = await req('POST', '/api/foreshadow', {
      story: passStory, query: { setupScene: 'sc', payoffScene: 'pc' },
    });
    ok('POST /api/foreshadow 通过场景返回 pass',
      q1b.status === 200 && q1b.body.verdict === 'pass' && q1b.body.passed === true);

    // 裸剧情（无 query）=> 400 缺少铺垫场景
    const q2 = await req('POST', '/api/foreshadow', passStory);
    ok('缺少 query 返回 400', q2.status === 400 && /铺垫场景/.test(q2.body.error || ''));

    // 铺垫与回收相同 => 400
    const q3 = await req('POST', '/api/foreshadow', {
      story: passStory, query: { setupScene: 'sc', payoffScene: 'sc' },
    });
    ok('铺垫与回收相同返回 400', q3.status === 400 && /不能相同/.test(q3.body.error || ''));

    // maxStates 注入 => 截断提示
    const q4 = await req('POST', '/api/foreshadow', {
      story: passStory, query: { setupScene: 'sc', payoffScene: 'pc' }, maxStates: 2,
    });
    ok('maxStates 注入触发截断提示', q4.status === 200 && q4.body.verdict === 'truncated');

    // 已保存剧情的校验接口
    const created = await req('POST', '/api/stories', violStory);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;

    const q5 = await req('POST', `/api/stories/${sid}/foreshadow`, { setupScene: 'sc', payoffScene: 'pc' });
    ok('POST /api/stories/:id/foreshadow（请求体即 query）返回违规',
      q5.status === 200 && q5.body.verdict === 'violation' && q5.body.violation.endingScene === 'end');

    const q5b = await req('POST', `/api/stories/${sid}/foreshadow`, { query: { setupScene: 'sc', payoffScene: 'pc' } });
    ok('POST /api/stories/:id/foreshadow 接受 { query } 包装',
      q5b.status === 200 && q5b.body.verdict === 'violation');

    const q6 = await req('POST', '/api/stories/no-such-id/foreshadow', { setupScene: 'sc', payoffScene: 'pc' });
    ok('剧情不存在返回 404', q6.status === 404);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项伏笔回收路线校验断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
