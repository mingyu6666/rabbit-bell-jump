/**
 * 《小兔跳铃铛》游戏逻辑冒烟测试（Node 环境，无微信依赖）
 * 运行：node tools/smoke-test.js
 *
 * 覆盖：
 *  1) 持续瞄准铃铛 → 分数持续上涨（碰撞/弹跳/计分链路）
 *  2) 故意偏离铃铛 → 兔子坠落并触发 gameover
 *  3) 重启流程正常
 */
'use strict'

const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'pages', 'index', 'index.js')
const source = fs.readFileSync(SRC, 'utf8')

// ---- mock 微信环境 ----
let pageDef = null
global.Page = (def) => {
  pageDef = def
}
global.wx = {
  getStorageSync: () => 0,
  setStorageSync: () => {},
  getWindowInfo: () => ({ pixelRatio: 2 }),
  createSelectorQuery: () => ({
    select: () => ({ fields: () => ({ exec: () => {} }) })
  }),
  createInnerAudioContext: () => ({ src: '', stop() {}, play() {}, destroy() {} }),
  vibrateShort: () => {}
}
global.__wxRoute = 'pages/index/index'

// 通过 vm 执行源码（避免 eval 的严格模式差异）
const vm = require('vm')
vm.runInNewContext(source, { Page: global.Page, wx: global.wx, console, Math, JSON })

if (!pageDef) {
  console.error('FAIL: Page 未被定义')
  process.exit(1)
}

// ---- 构造页面实例 ----
function makePage() {
  const page = {}
  Object.assign(page, pageDef)
  page.data = JSON.parse(JSON.stringify(pageDef.data))
  page.setData = (patch) => Object.assign(page.data, patch)
  // 手动接线
  page.initGame = pageDef.initGame.bind(page)
  page.update = pageDef.update.bind(page)
  page.gameOver = pageDef.gameOver.bind(page)
  page.startGame = pageDef.startGame.bind(page)
  page.restart = pageDef.restart.bind(page)
  page.hitBell = pageDef.hitBell.bind(page)
  page.addScore = pageDef.addScore.bind(page)
  page.setGameState = pageDef.setGameState.bind(page)
  // 渲染相关方法绑定（不执行渲染，仅保持对象完整）
  for (const k of Object.keys(pageDef)) {
    if (!page[k]) page[k] = pageDef[k].bind(page)
  }
  page.W = 375
  page.H = 667
  page.state = 'ready'
  page.ctx = new Proxy(
    {},
    {
      get: (t, k) => {
        if (k === 'createLinearGradient' || k === 'createRadialGradient') {
          return () => ({ addColorStop: () => {} })
        }
        return () => {}
      },
      set: () => true
    }
  )
  page.initGame()
  return page
}

function findNextTarget(page) {
  // 瞄准距离兔子脚最近的未处理铃铛层（即下一个即将发生判定碰撞的层）
  const feet = page.rabbit.y + 14.4
  let best = null
  let bestDist = Infinity
  for (const b of page.bells) {
    if (b.scored || b.passed || b.hit) continue
    const d = Math.abs(b.y - feet)
    if (d < bestDist) {
      bestDist = d
      best = b
    }
  }
  return best
}

function runFrames(page, n, frameFn) {
  for (let i = 0; i < n; i++) {
    if (frameFn) frameFn(i)
    page.update(1 / 60)
    if (page.state === 'gameover') break
  }
}

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('  PASS:', msg)
  } else {
    failures++
    console.error('  FAIL:', msg)
  }
}

// ---- 场景 1：持续瞄准 → 得分上涨 ----
console.log('\n[场景1] 持续瞄准铃铛，分数应上涨')
{
  const page = makePage()
  page.state = 'playing'
  page.rabbit.vy = -Math.sqrt(2 * 2200 * 90) // 相当于点击起跳
  const initialScore = page.score
  runFrames(page, 60 * 30, () => {
    const t = findNextTarget(page)
    page.touching = true
    page.touchX = t ? t.x : page.W / 2
  })
  assert(page.score > initialScore, `分数从 ${initialScore} 涨到 ${page.score}`)
  assert(page.state === 'playing', `状态保持 playing（实际 ${page.state}）`)
  console.log('  INFO: 30 秒模拟后分数 =', page.score)
}

// ---- 场景 2：故意偏离 → 坠落结束 ----
console.log('\n[场景2] 偏离铃铛，应坠落触发 gameover')
{
  const page = makePage()
  // 强制第一跳目标铃铛远离兔子，兔子贴左墙，必然错失
  const first = page.bells.find((b) => !b.scored)
  first.x = page.W - first.r - 16
  page.rabbit.x = 24
  page.state = 'playing'
  page.rabbit.vy = -Math.sqrt(2 * 2200 * 90)
  runFrames(page, 60 * 10, () => {
    page.touching = false // 不控制，兔子垂直跳
  })
  assert(page.state === 'gameover', `状态应为 gameover（实际 ${page.state}）`)
  assert(page.data.score === page.score, '分数数据同步')
}

// ---- 场景 3：命中后弹跳速度为正向上 ----
console.log('\n[场景3] 命中铃铛瞬间，垂直速度应变为负（向上）')
{
  const page = makePage()
  page.state = 'playing'
  page.rabbit.vy = -Math.sqrt(2 * 2200 * 90)
  let hitDetected = false
  runFrames(page, 60 * 10, (i) => {
    const t = findNextTarget(page)
    page.touching = true
    page.touchX = t ? t.x : page.W / 2
    if (i > 0 && page.score > 0 && !hitDetected) {
      hitDetected = true
      assert(page.rabbit.vy < 0, `命中后 vy = ${page.rabbit.vy.toFixed(1)} < 0（向上弹起）`)
    }
  })
  assert(hitDetected, '模拟中确实命中了铃铛')
}

// ---- 场景 4：重启后回到 ready 且分数清零 ----
console.log('\n[场景4] restart 应重置分数与状态')
{
  const page = makePage()
  page.state = 'playing'
  page.rabbit.vy = -Math.sqrt(2 * 2200 * 90)
  runFrames(page, 60 * 5, (i) => {
    const t = findNextTarget(page)
    page.touching = true
    page.touchX = t ? t.x : page.W / 2
  })
  const scored = page.score
  page.restart()
  assert(page.score === 0, `分数已清零（${scored} -> 0）`)
  assert(page.state === 'ready', `状态回到 ready（实际 ${page.state}）`)
  assert(page.bells.length >= 8, `铃铛层已重建（${page.bells.length} 层）`)
}

console.log(failures === 0 ? '\n=== ALL TESTS PASSED ===' : `\n=== ${failures} TEST(S) FAILED ===`)
process.exit(failures === 0 ? 0 : 1)
