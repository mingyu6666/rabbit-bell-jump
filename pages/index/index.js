/**
 * 小兔跳铃铛 - 微信小程序版
 *
 * 玩法（复刻经典《兔子跳铃铛 / Winterbells》）：
 *  - 点击开始，小兔自动向上弹跳；
 *  - 按住屏幕左右拖动，控制小兔水平移动；
 *  - 踩中铃铛会继续弹起并得分，金色铃铛 +5 分；
 *  - 踩空就会摔落，游戏结束；
 *  - 越往上铃铛越小、间距越大，难度逐步提升；
 *  - 层间随机出现星星，碰到 +3 分。
 */
const STORAGE_KEY = 'rabbit_bell_best'

// 物理常量（基于秒的物理，时间戳单位为毫秒）
const G = 1100          // 重力加速度 px/s²（调低：跳得更高、下落更缓，节奏舒适）
const RABBIT_R = 16     // 兔子身体半径
const FEET_R = 16       // 兔子脚部碰撞半径（加宽水平命中容差）
const HIT_ZONE = 20     // 铃铛命中判定容差区（层线下方像素，免疫离散帧积分误差）

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

Page({
  data: {
    state: 'ready', // ready | playing | gameover
    score: 0,
    best: 0
  },

  onLoad() {
    const best = wx.getStorageSync(STORAGE_KEY) || 0
    this.setData({ best })
  },

  onReady() {
    this.initCanvas()
    this.initAudio()
  },

  onUnload() {
    this.destroy()
  },

  onHide() {
    this.pauseGame()
  },

  onShow() {
    this.resumeGame()
  },

  onShareAppMessage() {
    return {
      title: `我在《小兔跳铃铛》跳到了 ${this.data.score} 分，来挑战我！`,
      path: '/pages/index/index'
    }
  },

  onShareTimeline() {
    return {
      title: `《小兔跳铃铛》踩中铃铛往上跳，我拿了 ${this.data.score} 分`
    }
  },

  /* ---------- 初始化 ---------- */

  initCanvas() {
    const query = wx.createSelectorQuery()
    query
      .select('#gameCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return
        const canvas = res[0].node
        const info = wx.getWindowInfo()
        const dpr = info.pixelRatio
        const width = res[0].width
        const height = res[0].height

        canvas.width = width * dpr
        canvas.height = height * dpr
        const ctx = canvas.getContext('2d')
        ctx.scale(dpr, dpr)

        this.canvas = canvas
        this.ctx = ctx
        this.W = width
        this.H = height

        this.initGame()
        this.lastT = 0
        this.startLoop()
      })
  },

  initAudio() {
    const create = (name, src) => {
      const a = wx.createInnerAudioContext()
      a.src = src
      this.audios = this.audios || {}
      this.audios[name] = a
    }
    create('bell', '/assets/sounds/bell.wav')
    create('star', '/assets/sounds/star.wav')
    create('fail', '/assets/sounds/fail.wav')
  },

  playSound(name) {
    const a = this.audios && this.audios[name]
    if (!a) return
    try {
      a.stop()
      a.play()
    } catch (e) {
      // 忽略音频异常
    }
  },

  vibrate(type) {
    try {
      wx.vibrateShort({ type: type || 'light' })
    } catch (e) {
      // 低版本基础库不支持 type 参数，静默忽略
    }
  },

  /* ---------- 游戏状态 ---------- */

  setGameState(s) {
    this.state = s
    this.setData({ state: s })
  },

  initGame() {
    this.score = 0
    this.state = 'ready'
    this.camera = 0 // 世界坐标 -> 屏幕坐标：screenY = worldY - camera；起始层位于屏幕 72% 高度
    this.touching = false
    this.touchX = this.W / 2
    this.particles = []
    this.stars = []
    this.elapsed = 0
    this.lastStarClean = 0

    // 背景星星（世界坐标，随相机滚动）
    this.bgStars = []
    for (let i = 0; i < 60; i++) {
      this.bgStars.push({
        x: Math.random() * this.W,
        y: Math.random() * this.H * 4,
        r: Math.random() * 1.6 + 0.6,
        phase: Math.random() * Math.PI * 2,
        speed: Math.random() * 2 + 0.5
      })
    }

    // 云朵（相对屏幕缓慢漂移）
    this.clouds = [
      { x: this.W * 0.15, y: this.H * 0.2, s: 0.9, speed: 8 },
      { x: this.W * 0.7, y: this.H * 0.34, s: 1.2, speed: -6 },
      { x: this.W * 0.45, y: this.H * 0.12, s: 0.7, speed: 10 }
    ]

    // 兔子（站在起始铃铛顶部：铃铛中心 startY，半径 40，脚在铃铛顶部上方）
    this.rabbit = { x: this.W / 2, y: this.H * 0.72 - 55, vx: 0, vy: 0 }

    // 铃铛层
    this.bells = []
    this.spawnStartLayer()
    for (let i = 0; i < 8; i++) {
      this.spawnLayerAbove()
    }
  },

  /** 起始层：兔子脚下的第一个大铃铛 */
  spawnStartLayer() {
    const startY = this.H * 0.72
    const gap = this.nextGap()
    this.bells.push({
      x: this.W / 2,
      y: startY,
      r: 40,
      scored: true, // 已“踩过”，作为起点平台
      passed: false,
      hit: false,
      hitAt: 0,
      gold: false,
      gapNext: gap
    })
    this.lastLayerX = this.W / 2
  },

  /** 在最高层之上生成新的一层（y 更小） */
  spawnLayerAbove() {
    const top = this.bells[0]
    const gap = this.nextGap()
    const r = this.bellRadius()
    const newY = top.y - gap
    top.gapNext = gap // 踩中 top 后弹起的高度 = 到新层的距离

    const scoreNow = this.score
    const count = scoreNow >= 20 && Math.random() < 0.3 ? 2 : 1
    const margin = r + 16
    const maxStep = this.W * 0.4
    const created = []

    // 首层铃铛尽量落在兔子正上方附近，保证第一跳几乎必中（建立手感信心）
    const isFirstLayer = this.bells.length === 1
    let x0 = isFirstLayer
      ? clamp(this.W / 2 + (Math.random() * 2 - 1) * 40, margin, this.W - margin)
      : clamp(
          this.lastLayerX + (Math.random() * 2 - 1) * maxStep,
          margin,
          this.W - margin
        )
    created.push({
      x: x0, y: newY, r, scored: false, passed: false,
      hit: false, hitAt: 0, gold: Math.random() < 0.12, gapNext: 0
    })

    if (count === 2) {
      const gapBetween = r * 2.6 + 30
      let x2 = x0 + (Math.random() > 0.5 ? 1 : -1) * gapBetween
      x2 = clamp(x2, margin, this.W - margin)
      if (Math.abs(x2 - x0) < r * 2.2) {
        // 太近则放到另一边
        x2 = clamp(this.W - x0, margin, this.W - margin)
      }
      created.push({
        x: x2, y: newY, r, scored: false, passed: false,
        hit: false, hitAt: 0, gold: Math.random() < 0.12, gapNext: 0
      })
    }

    this.lastLayerX = x0
    this.bells.unshift.apply(this.bells, created)

    // 层间随机星星
    if (Math.random() < 0.45) {
      this.stars.push({
        x: clamp(Math.random() * this.W, 20, this.W - 20),
        y: (top.y + newY) / 2 + (Math.random() * 2 - 1) * 24,
        r: 12,
        hit: false,
        hitAt: 0
      })
    }
  },

  /** 保证屏幕上方始终有足够的铃铛层 */
  ensureLayers() {
    let guard = 0
    while (this.bells[0].y - this.camera > 60 && guard < 10) {
      this.spawnLayerAbove()
      guard++
    }
  },

  nextGap() {
    // 层距：起点 120px，随分数缓慢拉大，封顶 230px（跳得更高更有"蹦跳感"）
    return Math.min(230, 120 + this.score * 1.8)
  },

  bellRadius() {
    // 铃铛半径：起点 44px，随分数缓慢缩小，封顶 20px
    return Math.max(20, 44 - this.score * 0.5)
  },

  /* ---------- 帧循环 ---------- */

  startLoop() {
    const loop = (t) => {
      if (this.destroyed) return
      const dt = this.lastT ? Math.min(0.05, (t - this.lastT) / 1000) : 0.016
      this.lastT = t
      this.elapsed += dt
      this.update(dt)
      this.render(t)
      this.raf = this.canvas.requestAnimationFrame(loop)
    }
    this.raf = this.canvas.requestAnimationFrame(loop)
  },

  pauseGame() {
    if (this.raf && this.canvas) {
      this.canvas.cancelAnimationFrame(this.raf)
      this.raf = 0
      this.lastT = 0
    }
  },

  resumeGame() {
    if (!this.canvas || this.raf || this.destroyed) return
    this.lastT = 0
    this.startLoop()
  },

  destroy() {
    this.destroyed = true
    if (this.raf && this.canvas) {
      this.canvas.cancelAnimationFrame(this.raf)
    }
    if (this.audios) {
      Object.keys(this.audios).forEach((k) => this.audios[k].destroy())
    }
  },

  /* ---------- 更新逻辑 ---------- */

  update(dt) {
    if (this.state === 'ready' || this.state === 'gameover') {
      this.updateParticles(dt)
      return
    }

    // 水平移动：按住屏幕时平滑跟随手指（响应更灵敏）
    if (this.touching) {
      const prevX = this.rabbit.x
      this.rabbit.x += (this.touchX - this.rabbit.x) * Math.min(1, 20 * dt)
      this.rabbit.vx = (this.rabbit.x - prevX) / Math.max(dt, 0.001)
    } else {
      this.rabbit.vx = 0
    }
    this.rabbit.x = clamp(this.rabbit.x, 24, this.W - 24)

    // 垂直运动
    this.rabbit.vy += G * dt
    this.rabbit.y += this.rabbit.vy * dt

    // 铃铛碰撞：下落经过层线附近的判定区时判定（容差区免疫离散帧积分误差）
    const feetY = this.rabbit.y + RABBIT_R * 0.9
    for (const b of this.bells) {
      if (b.scored || b.passed || b.hit) continue
      const d = feetY - b.y // 脚在层线下方距离（正 = 已低于层线）
      if (d >= 0 && d <= HIT_ZONE && this.rabbit.vy > 0) {
        if (Math.abs(this.rabbit.x - b.x) <= b.r + FEET_R) {
          this.hitBell(b)
        } else if (d >= HIT_ZONE - 2) {
          b.passed = true // 已下落足够深仍未命中，视为错失该层
        }
      }
    }

    // 星星道具碰撞
    for (const s of this.stars) {
      if (s.hit) continue
      const sy = s.y - this.camera
      const ry = this.rabbit.y - this.camera
      if (Math.abs(this.rabbit.x - s.x) < 22 && Math.abs(ry - sy) < 24) {
        s.hit = true
        s.hitAt = this.elapsed
        this.addScore(3)
        this.spawnParticles(s.x, s.y, '#ff8a80', 8)
        this.playSound('star')
        this.vibrate('light')
      }
    }

    // 相机跟随（只向上跟随，坠落时锁定）
    const targetCam = this.rabbit.y - this.H * 0.45
    if (targetCam < this.camera) {
      this.camera += (targetCam - this.camera) * 0.18
    }

    // 补充新层
    this.ensureLayers()

    // 清理屏幕下方已结束的层，控制数组规模
    this.cleanupLayers()

    // 清理已消失的星星
    if (this.elapsed - this.lastStarClean > 2) {
      this.lastStarClean = this.elapsed
      this.stars = this.stars.filter((s) => !s.hit || this.elapsed - s.hitAt < 1)
    }

    this.updateParticles(dt)

    // 坠落判定
    if (this.rabbit.y - this.camera > this.H + 60) {
      this.gameOver()
    }
  },

  hitBell(b) {
    b.scored = true
    b.hit = true
    b.hitAt = this.elapsed
    // 关键：把兔子脚精确钉在层线上再起跳，消除离散帧判定产生的起跳点滞后，
    // 保证弹跳顶点精确到达下一层线（否则会因几像素误差永远踩不到下一层）
    this.rabbit.y = b.y - RABBIT_R * 0.9
    // 弹跳高度 = 到上方最近铃铛层的实际距离
    let nearest = null
    for (const o of this.bells) {
      if (o.y < b.y && (!nearest || o.y > nearest.y)) nearest = o
    }
    const gap = nearest ? b.y - nearest.y : b.gapNext || this.nextGap()
    this.rabbit.vy = -Math.sqrt(2 * G * gap)
    const gain = b.gold ? 5 : 1
    this.addScore(gain)
    this.spawnParticles(b.x, b.y, b.gold ? '#ffd54f' : '#ffe082', 12)
    this.playSound('bell')
    this.vibrate('light')
  },

  addScore(n) {
    this.score += n
    this.setData({ score: this.score })
  },

  spawnParticles(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 60 + Math.random() * 140
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 60,
        life: 0.6 + Math.random() * 0.3,
        maxLife: 0.9,
        color
      })
    }
  },

  updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += 500 * dt
      p.life -= dt
      if (p.life <= 0) this.particles.splice(i, 1)
    }
  },

  cleanupLayers() {
    if (this.bells.length <= 12) return
    // 移除屏幕底部较远且已结束的层
    while (
      this.bells.length > 12 &&
      this.bells[this.bells.length - 1].y - this.camera > this.H + 150 &&
      this.bells[this.bells.length - 1].scored
    ) {
      this.bells.pop()
    }
  },

  gameOver() {
    this.setGameState('gameover')
    this.touching = false
    const s = this.score
    if (s > this.data.best) {
      this.setData({ best: s })
      try {
        wx.setStorageSync(STORAGE_KEY, s)
      } catch (e) {
        // 存储失败可忽略
      }
    }
    this.playSound('fail')
    this.vibrate('heavy')
  },

  startGame() {
    const startBell = this.bells[0]
    this.rabbit.vy = -Math.sqrt(2 * G * (startBell.gapNext || this.nextGap()))
    this.setGameState('playing')
    this.playSound('bell')
  },

  restart() {
    this.initGame()
    this.setData({ score: 0 })
    this.setGameState('ready')
  },

  /* ---------- 触摸事件 ---------- */

  onTouchStart(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (!t) return
    if (this.state === 'ready') {
      this.touchX = t.clientX
      this.startGame()
    }
    if (this.state === 'playing') {
      this.touching = true
      this.touchX = t.clientX
    }
  },

  onTouchMove(e) {
    const t = e.touches && e.touches[0]
    if (!t || this.state !== 'playing') return
    this.touchX = t.clientX
  },

  onTouchEnd() {
    this.touching = false
  },

  onOverlayTap() {
    if (this.state === 'ready') {
      this.startGame()
    } else if (this.state === 'gameover') {
      this.restart()
    }
  },

  /* ---------- 渲染 ---------- */

  render(t) {
    const ctx = this.ctx
    const W = this.W
    const H = this.H
    ctx.clearRect(0, 0, W, H)

    this.drawBackground(ctx, t)
    this.drawClouds(ctx, t)
    this.drawStars(ctx)
    this.drawBells(ctx, t)
    this.drawRabbit(ctx)
    this.drawParticles(ctx)
    this.drawGround(ctx)
  },

  drawBackground(ctx, t) {
    const W = this.W
    const H = this.H
    const grad = ctx.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0, '#0a0e2a')
    grad.addColorStop(0.55, '#201a4a')
    grad.addColorStop(1, '#3a2460')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)

    // 星空（随相机滚动，循环铺满）
    ctx.save()
    for (const s of this.bgStars) {
      const sy = (((s.y - this.camera) % (this.H * 4)) + this.H * 4) % (this.H * 4)
      if (sy > this.H) continue
      const alpha = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.002 * s.speed + s.phase))
      ctx.globalAlpha = alpha
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(s.x, sy, s.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()

    // 月亮（视差滚动，随上升缓慢下移）
    const mx = W * 0.82
    const my = H * 0.14 - this.camera * 0.12
    const mr = Math.min(W, H) * 0.075
    if (my > -mr * 2) {
      const halo = ctx.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 2.2)
      halo.addColorStop(0, 'rgba(255,240,190,0.35)')
      halo.addColorStop(1, 'rgba(255,240,190,0)')
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(mx, my, mr * 2.2, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#fff6d8'
      ctx.beginPath()
      ctx.arc(mx, my, mr, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = 'rgba(240,220,180,0.6)'
      ctx.beginPath()
      ctx.arc(mx + mr * 0.25, my - mr * 0.2, mr * 0.18, 0, Math.PI * 2)
      ctx.arc(mx - mr * 0.3, my + mr * 0.35, mr * 0.13, 0, Math.PI * 2)
      ctx.fill()
    }
  },

  drawClouds(ctx, t) {
    for (const c of this.clouds) {
      c.x += c.speed * 0.016
      if (c.x > this.W + 120) c.x = -120
      if (c.x < -120) c.x = this.W + 120
      ctx.save()
      ctx.globalAlpha = 0.18
      ctx.fillStyle = '#ffffff'
      const s = c.s
      const baseY = c.y + Math.sin(t * 0.0004 + c.x) * 6
      ctx.beginPath()
      ctx.arc(c.x, baseY, 34 * s, 0, Math.PI * 2)
      ctx.arc(c.x - 30 * s, baseY + 6 * s, 24 * s, 0, Math.PI * 2)
      ctx.arc(c.x + 30 * s, baseY + 6 * s, 24 * s, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  },

  drawStars(ctx) {
    for (const s of this.stars) {
      if (s.hit) {
        const dt = this.elapsed - s.hitAt
        if (dt > 0.6) continue
        ctx.globalAlpha = Math.max(0, 1 - dt * 1.6)
      } else {
        ctx.globalAlpha = 0.9
      }
      const sy = s.y - this.camera
      if (sy < -40 || sy > this.H + 40) {
        ctx.globalAlpha = 1
        continue
      }
      ctx.save()
      ctx.translate(s.x, sy)
      if (s.hit) {
        const grow = 1 + (this.elapsed - s.hitAt) * 2
        ctx.scale(grow, grow)
      }
      ctx.fillStyle = '#ffd54f'
      ctx.beginPath()
      for (let i = 0; i < 5; i++) {
        const ang = -Math.PI / 2 + (i * 2 * Math.PI) / 5
        const px = Math.cos(ang) * s.r
        const py = Math.sin(ang) * s.r
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
        const ang2 = ang + Math.PI / 5
        ctx.lineTo(Math.cos(ang2) * s.r * 0.45, Math.sin(ang2) * s.r * 0.45)
      }
      ctx.closePath()
      ctx.fill()
      ctx.restore()
      ctx.globalAlpha = 1
    }
  },

  drawBells(ctx, t) {
    for (const b of this.bells) {
      const sy = b.y - this.camera
      if (sy < -80 || sy > this.H + 80) continue

      let scale = 1
      let alpha = 1
      if (b.hit) {
        const dt = (this.elapsed - b.hitAt) * 2.2
        scale = 1 + dt
        alpha = Math.max(0, 1 - dt)
        if (dt > 0.9) b.hit = false
      }

      ctx.save()
      ctx.globalAlpha = alpha * (b.scored ? 0.32 : 1)
      ctx.translate(b.x, sy)
      ctx.scale(scale, scale)

      // 金色铃铛光环
      if (b.gold && !b.scored) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.006 + b.x)
        ctx.globalAlpha = alpha * (0.25 + 0.25 * pulse)
        ctx.strokeStyle = '#ffd54f'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(0, 0, b.r + 6, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = alpha * (b.scored ? 0.32 : 1)
      }

      // 顶部系钮与挂环
      ctx.fillStyle = '#d9a441'
      ctx.beginPath()
      ctx.arc(0, -b.r * 1.24, b.r * 0.13, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#c9972f'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(0, -b.r * 1.05, b.r * 0.24, 0, Math.PI * 2)
      ctx.stroke()

      // 铃身（亮金色渐变）
      const grad = ctx.createRadialGradient(-b.r * 0.32, -b.r * 0.4, b.r * 0.15, 0, 0, b.r * 1.05)
      if (b.gold) {
        grad.addColorStop(0, '#fffbe6')
        grad.addColorStop(0.5, '#ffd54f')
        grad.addColorStop(1, '#f09a12')
      } else {
        grad.addColorStop(0, '#fff9e0')
        grad.addColorStop(0.5, '#ffe27a')
        grad.addColorStop(1, '#e2a413')
      }
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(0, 0, b.r, 0, Math.PI * 2)
      ctx.fill()

      // 铃口（下方半圆延伸 + 暗部开口）
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(0, b.r * 0.48, b.r * 0.66, 0, Math.PI)
      ctx.fill()
      ctx.fillStyle = 'rgba(190,120,20,0.35)'
      ctx.beginPath()
      ctx.arc(0, b.r * 0.56, b.r * 0.48, 0, Math.PI)
      ctx.fill()

      // 顶部高光与亮点
      ctx.fillStyle = 'rgba(255,255,255,0.65)'
      ctx.beginPath()
      ctx.ellipse(-b.r * 0.34, -b.r * 0.42, b.r * 0.3, b.r * 0.16, -0.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.beginPath()
      ctx.arc(-b.r * 0.05, -b.r * 0.52, b.r * 0.08, 0, Math.PI * 2)
      ctx.fill()

      // 底部阴影
      ctx.fillStyle = 'rgba(0,0,0,0.14)'
      ctx.beginPath()
      ctx.ellipse(0, b.r * 0.82, b.r * 0.78, b.r * 0.2, 0, 0, Math.PI * 2)
      ctx.fill()

      ctx.restore()
      ctx.globalAlpha = 1
    }
  },

  drawRabbit(ctx) {
    const r = RABBIT_R
    const x = this.rabbit.x
    const y = this.rabbit.y - this.camera
    const tilt = clamp(this.rabbit.vx * 0.02, -0.42, 0.42)
    const t = this.elapsed

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(tilt)

    // 脚下柔和阴影
    ctx.fillStyle = 'rgba(0,0,0,0.12)'
    ctx.beginPath()
    ctx.ellipse(0, r * 1.12, r * 0.85, r * 0.2, 0, 0, Math.PI * 2)
    ctx.fill()

    // 尾巴
    ctx.fillStyle = '#f6f6f6'
    ctx.beginPath()
    ctx.arc(r * 0.8, r * 0.6, r * 0.3, 0, Math.PI * 2)
    ctx.fill()

    // 耳朵（弹簧摆动）
    const earSwing = Math.sin(t * 5) * 0.1
    this.drawEar(ctx, -r * 0.42, -r * 0.6, -0.3 + earSwing, r)
    this.drawEar(ctx, r * 0.42, -r * 0.6, 0.3 - earSwing, r)

    // 小短手
    ctx.fillStyle = '#fdf3ea'
    ctx.beginPath()
    ctx.ellipse(-r * 0.95, r * 0.22, r * 0.22, r * 0.3, 0.5, 0, Math.PI * 2)
    ctx.ellipse(r * 0.95, r * 0.22, r * 0.22, r * 0.3, -0.5, 0, Math.PI * 2)
    ctx.fill()

    // 身体（米白渐变，圆鼓鼓）
    const bodyGrad = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.2, 0, 0, r * 1.1)
    bodyGrad.addColorStop(0, '#ffffff')
    bodyGrad.addColorStop(0.7, '#fdf6ec')
    bodyGrad.addColorStop(1, '#f6e7d3')
    ctx.fillStyle = bodyGrad
    ctx.beginPath()
    ctx.ellipse(0, 0, r, r * 1.08, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(214,178,135,0.25)'
    ctx.lineWidth = 1
    ctx.stroke()

    // 肚子
    ctx.fillStyle = 'rgba(255,255,255,0.65)'
    ctx.beginPath()
    ctx.ellipse(0, r * 0.35, r * 0.55, r * 0.5, 0, 0, Math.PI * 2)
    ctx.fill()

    // 腮红
    ctx.fillStyle = 'rgba(255,150,140,0.5)'
    ctx.beginPath()
    ctx.ellipse(-r * 0.62, r * 0.18, r * 0.24, r * 0.15, 0, 0, Math.PI * 2)
    ctx.ellipse(r * 0.62, r * 0.18, r * 0.24, r * 0.15, 0, 0, Math.PI * 2)
    ctx.fill()

    // 眼睛（大而 Q，深棕，双高光）
    ctx.fillStyle = '#4a2f2a'
    ctx.beginPath()
    ctx.arc(-r * 0.34, -r * 0.22, r * 0.19, 0, Math.PI * 2)
    ctx.arc(r * 0.34, -r * 0.22, r * 0.19, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(-r * 0.29, -r * 0.28, r * 0.07, 0, Math.PI * 2)
    ctx.arc(r * 0.39, -r * 0.28, r * 0.07, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.beginPath()
    ctx.arc(-r * 0.4, -r * 0.16, r * 0.035, 0, Math.PI * 2)
    ctx.arc(r * 0.28, -r * 0.16, r * 0.035, 0, Math.PI * 2)
    ctx.fill()

    // 鼻子和嘴
    ctx.fillStyle = '#ff8a80'
    ctx.beginPath()
    ctx.moveTo(0, -r * 0.06)
    ctx.quadraticCurveTo(r * 0.08, r * 0.04, 0, r * 0.1)
    ctx.quadraticCurveTo(-r * 0.08, r * 0.04, 0, -r * 0.06)
    ctx.fill()
    ctx.strokeStyle = 'rgba(224,160,160,0.8)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, r * 0.12)
    ctx.quadraticCurveTo(-r * 0.1, r * 0.24, -r * 0.2, r * 0.3)
    ctx.moveTo(0, r * 0.12)
    ctx.quadraticCurveTo(r * 0.1, r * 0.24, r * 0.2, r * 0.3)
    ctx.stroke()

    ctx.restore()
  },

  drawEar(ctx, x, y, angle, r) {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    // 耳外侧（米白）
    const earGrad = ctx.createLinearGradient(0, -r * 0.7, 0, r * 0.3)
    earGrad.addColorStop(0, '#fffaf2')
    earGrad.addColorStop(1, '#fdece0')
    ctx.fillStyle = earGrad
    ctx.beginPath()
    ctx.ellipse(0, -r * 0.42, r * 0.26, r * 0.62, 0, 0, Math.PI * 2)
    ctx.fill()
    // 耳内侧（粉渐变）
    const innerGrad = ctx.createLinearGradient(0, -r * 0.55, 0, r * 0.1)
    innerGrad.addColorStop(0, '#ffc9c9')
    innerGrad.addColorStop(1, '#ff9e9e')
    ctx.fillStyle = innerGrad
    ctx.beginPath()
    ctx.ellipse(0, -r * 0.4, r * 0.13, r * 0.38, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  },

  drawParticles(ctx) {
    for (const p of this.particles) {
      const alpha = Math.max(0, p.life / p.maxLife)
      ctx.globalAlpha = alpha
      ctx.fillStyle = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y - this.camera, 3 + alpha * 3, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  },

  drawGround(ctx) {
    const W = this.W
    const H = this.H
    // 雪地：固定屏幕底部，营造稳定平台感
    const gy = H - 46
    // 远景雪丘（浅蓝白，半透明）
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.beginPath()
    ctx.moveTo(0, gy + 14)
    ctx.quadraticCurveTo(W * 0.25, gy - 26, W * 0.5, gy - 8)
    ctx.quadraticCurveTo(W * 0.78, gy + 8, W, gy - 12)
    ctx.lineTo(W, H)
    ctx.lineTo(0, H)
    ctx.closePath()
    ctx.fill()
    // 近景雪地（暖白渐变）
    const grad = ctx.createLinearGradient(0, gy - 30, 0, H)
    grad.addColorStop(0, 'rgba(255,255,255,0.98)')
    grad.addColorStop(1, 'rgba(224,232,244,1)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.moveTo(0, gy)
    ctx.quadraticCurveTo(W * 0.3, gy - 18, W * 0.55, gy - 6)
    ctx.quadraticCurveTo(W * 0.8, gy + 4, W, gy - 10)
    ctx.lineTo(W, H)
    ctx.lineTo(0, H)
    ctx.closePath()
    ctx.fill()
  }
})
