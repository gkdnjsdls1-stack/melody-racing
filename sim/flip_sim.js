// 뒤집힘(flip) 시뮬레이션 — CLAUDE.md 작업 규칙: 물리 수치를 바꾸면 무작위 맵으로
// 몇 가지 플레이 방식을 돌려 뒤집힘 횟수를 확인한다.
// 가속=땅에서 전진(안 누르면 멈춤)/공중에서는 회전, Hill Climb Racing 방식 (2026-11-02 변경).
//
// 물리 코드(buildTerrain, stepPhys, aimJump, land, crash, predictLanding 등)를
// index.html에서 그대로 잘라와 실행한다. 복사해서 따로 유지하면 index.html의
// 물리 수치를 바꿔도 시뮬레이션이 낡은 값을 쓰게 되므로, 매번 실행 시점의
// index.html 텍스트에서 직접 떼어내 돌린다.
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function cut(src, startNeedle, endNeedle) {
  const s = src.indexOf(startNeedle);
  if (s < 0) throw new Error('시작 지점을 못 찾음(index.html이 바뀐 듯): ' + startNeedle);
  const e = src.indexOf(endNeedle, s + startNeedle.length);
  if (e < 0) throw new Error('끝 지점을 못 찾음(index.html이 바뀐 듯): ' + endNeedle);
  return src.slice(s, e);
}

const diffsAndConsts = cut(html, 'const DIFFS=[', 'const $=id=>document.getElementById(id);');
const buildTerrainSrc = cut(html, 'function buildTerrain(mel,ppb,hU,loops,lead,tail){', '// ---------- compose screen ----------');
const physicsSrc = cut(html, 'const wrap=a=>{', '// ---------- drawing ----------');

const harness = `
// ---------- 시뮬레이션 하네스 (index.html에는 없는 코드) ----------
let AC, R; // crash()/stepPhys()가 자유변수로 참조하므로 같은 스코프에 선언 필요
function triggerSteps(){} // index.html에서는 이 자리서 오디오를 트리거함. 뒤집힘 집계엔 필요 없어서 비워둠

// 작곡 화면의 주사위 버튼과 같은 무작위 멜로디 생성 ($('dice').onclick, index.html)
function randomMap() {
  let p = Math.floor(Math.random() * 4) + 1;
  const m = [];
  for (let i = 0; i < 16; i++) {
    if (i > 0 && Math.random() < 0.16 && m[i - 1] !== -1) { m.push(-1); continue; }
    p = Math.max(0, Math.min(9, p + [-2, -1, -1, 0, 1, 1, 2, 3][Math.floor(Math.random() * 8)]));
    m.push(p);
  }
  if (m[15] !== -1 && Math.random() < 0.5) m[15] = -1;
  return m;
}
function randomBpm() { return 80 + 5 * Math.floor(Math.random() * 17); } // 80~160, 5단위

// startRace()와 동일한 방식으로 R(레이스 상태) 생성
function newRace(mel, bpm, diffIdx) {
  const spb = 60 / bpm;
  const vx = 230 * Math.min(1.5, Math.max(1, 1 + (bpm - 80) / 160));
  const ppb = vx * spb;
  const T = buildTerrain(mel, ppb, 22, 2, LEAD, END_BEAT - LEAD - MEL_BEATS + 3);
  const cfg = DIFFS[diffIdx];
  return {
    bpm, spb, vx, ppb, T, mel: mel.slice(),
    g: 0.72 * vx * vx / ppb, gG: 15 * vx * vx / ppb, cfg, torque: cfg.torque * (0.8 + bpm / 400), tgt: 0,
    accel: vx / 0.6, coastDecel: vx / 1, brakeDecel: vx / 0.3,
    simT: 0, x: 0, y: T.at(0), vy: 0, spd: 0, ang: 0, angV: 0, onGround: true, air: 0,
    dead: false, respawnX: 0, deadX: 0, deadY: 0, deadVy: 0, deadAng: 0, deadAngV: 0, deadT: 0,
    muted: new Set(), played: new Set(), stepIdx: 0,
    score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, crashes: 0, pops: [], parts: [], puff: 0, wheel: 0,
    gas: false, brake: false, paused: false, finished: false
  };
}

// 플레이어 정책: 가속은 땅에서 전진, 공중에서는 가속/브레이크 둘 다 회전만 맡는다(Hill Climb Racing 방식)
function policyGasAlways(R) { return { gas: true, brake: false }; } // 그냥 가속 꾹
function policyGasThenBrakeInAir(R) { return R.onGround ? { gas: true, brake: false } : { gas: false, brake: true }; } // 땅=가속, 공중=브레이크로 조준
function policyGasThenReleaseInAir(R) { return R.onGround ? { gas: true, brake: false } : { gas: false, brake: false }; } // 땅=가속, 공중=손뗌(어시스트에만 의존)

// 한 판 전체 시뮬레이션. 실제 게임처럼 뒤집혀도 멈추지 않고 다음 마디에서 재출발.
// 이제 속도가 조작에 달려 있어서 완주 시간이 고정이 아니므로, 넉넉한 실시간 상한으로 멈춘다.
function runTrial(mel, bpm, diffIdx, policy) {
  R = newRace(mel, bpm, diffIdx);
  const dt = 0.004, finishX = END_BEAT * R.ppb, maxTime = 40;
  const tally = { flip: 0, wall: 0, pit: 0, finished: false };
  while (R.simT < maxTime && R.x < finishX) {
    const act = policy(R);
    R.gas = act.gas; R.brake = act.brake;
    const prevCrashes = R.crashes;
    R.simT += dt; stepPhys(dt);
    if (R.crashes > prevCrashes) {
      const reason = R.pops.length ? R.pops[R.pops.length - 1].text : '';
      if (reason === '뒤집혔어요') tally.flip++;
      else if (reason === '벽에 부딪혔어요') tally.wall++;
      else if (reason === '구덩이에 빠졌어요') tally.pit++;
    }
  }
  tally.finished = R.x >= finishX;
  return tally;
}

function runSet(diffIdx, policyName, policy, trials) {
  let flipRuns = 0, totalFlip = 0, totalWall = 0, totalPit = 0, unfinished = 0;
  for (let i = 0; i < trials; i++) {
    const t = runTrial(randomMap(), randomBpm(), diffIdx, policy);
    if (t.flip > 0) flipRuns++;
    if (!t.finished) unfinished++;
    totalFlip += t.flip; totalWall += t.wall; totalPit += t.pit;
  }
  return {
    난이도: DIFFS[diffIdx].name, 플레이어: policyName, 판수: trials,
    '평균 뒤집힘/판': +(totalFlip / trials).toFixed(2),
    '뒤집힘 있던 판 비율': Math.round(flipRuns / trials * 100) + '%',
    '평균 벽충돌/판': +(totalWall / trials).toFixed(2),
    '평균 구덩이/판': +(totalPit / trials).toFixed(2),
    '시간초과(40s) 미완주': unfinished
  };
}

const trials = params.trials;
const rows = [];
for (let d = 0; d < DIFFS.length; d++) {
  rows.push(runSet(d, '가속만 계속', policyGasAlways, trials));
  rows.push(runSet(d, '땅=가속/공중=브레이크 조준', policyGasThenBrakeInAir, trials));
  rows.push(runSet(d, '땅=가속/공중=손뗌', policyGasThenReleaseInAir, trials));
}
return rows;
`;

const trials = Number(process.argv[2]) || 50;
const runSim = new Function('params', diffsAndConsts + '\n' + buildTerrainSrc + '\n' + physicsSrc + '\n' + harness);
const rows = runSim({ trials });
console.table(rows);
