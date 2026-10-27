'use strict';

/**
 * QuickDock Electron 主进程入口。
 *
 * ⚠️ 文件名必须是 .cjs，不能改成 .js：
 * Electron 用 `<exe> <script>` 启动时走 default_app.asar 的 loadApplicationPackage，
 * 它【只看文件扩展名】决定模块类型，会忽略最近 package.json 里的 "type" 字段。
 * 根 package.json 是 "type": "module"（插件主体是 ESM），
 * 所以 .js 会被解析成 ESM → `require is not defined` → dock 静默不启动：
 * 进程活着、无窗口、无任何输出，极难排查。
 * 实测：同为 CJS 代码，qdapp.js 不执行，qdapp.cjs 正常拿到 BrowserWindow。
 *
 * 若新增 runtime 下的其他入口文件，同样请用 .cjs。
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

// 临时调试：Electron 侧没有可用控制台，落盘看现场
const TRACE = path.join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'dsh-quickdock', 'dock.log');
function trace(msg) {
  try { fs.appendFileSync(TRACE, '[' + new Date().toISOString() + '] ' + String(msg) + '\n') } catch (_) {}
}
let tracedError = false
process.on('uncaughtException', (e) => { trace('UNCAUGHT ' + (e && e.stack || e)); tracedError = true })
process.on('unhandledRejection', (e) => { trace('UNHANDLED ' + (e && e.stack || e)); tracedError = true })

const { parseConfig, defaultStatePath } = require('./config');
const {
  currentDisplay,
  pointInRects,
  clampBounds,
  restoreBounds,
} = require('./geometry');
const { HostProtocol, writeStatus } = require('./protocol');
const { WindowStore } = require('./window-store');

function eventWebContents(event) {
  return event && (event.sender || (event.senderFrame && event.senderFrame.webContents));
}

/**
 * 两个窗口共用的 BrowserWindow 配置。
 *
 * 几个关键项：
 *  - useContentSize：宽高按**内容区**解释。渲染视口等于内容区，若按外框设置，
 *    页面测到的尺寸和窗口对不上，会形成「窗口越来越大」的正反馈。
 *  - thickFrame:false：去掉 Windows 标准边框，否则窗口四周会有一圈不透明描边。
 *  - roundedCorners:false：圆角由 CSS 画，避免系统再裁一次留下硬边。
 */
function sharedWindowOptions(extra) {
  return Object.assign({
    useContentSize: true,
    show: false,
    transparent: true,
    frame: false,
    thickFrame: false,
    roundedCorners: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  }, extra || {});
}

/** 两个窗口共用的创建后设置。 */
function prepareWindow(win, store) {
  win.setMenuBarVisibility(false);
  win.setAlwaysOnTop(store.state.alwaysOnTop, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (typeof win.setBackgroundThrottling === 'function') win.setBackgroundThrottling(false);
  else win.webContents.setBackgroundThrottling(false);
  // 缩放固定为 1：任何缩放都会让渲染侧的 CSS 像素与窗口的 DIP 尺寸失配
  try { win.webContents.setZoomFactor(1); } catch (_) {}
  try { win.webContents.setVisualZoomLevelLimits(1, 1); } catch (_) {}
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

class DockRuntime {
  constructor(electron, options) {
    this.electron = electron;
    this.process = options.process || process;
    this.config = options.config;
    this.platform = options.platform || this.process.platform;
    /** 输入窗口（固定尺寸，用户可拖动） */
    this.win = null;
    /** 展示窗口（贴在输入窗口上方或下方，独立于输入窗口的移动） */
    this.displayWin = null;
    this.store = null;
    /** 输入窗口的穿透状态 */
    this.interactive = false;
    /** 展示窗口的穿透状态（与输入窗口各自独立） */
    this.displayInteractive = false;
    /** 展示窗口是否贴在输入窗口上方 */
    this.displayAbove = false;
    /** 诊断用：完全禁用"点击穿透"（DSH_QUICKDOCK_NO_CLICK_THROUGH=1） */
    this.noClickThrough = this.process.env.DSH_QUICKDOCK_NO_CLICK_THROUGH === '1';
    this.quitting = false;
    this.timers = new Set();
    this.protocols = [];
    this.showFallback = null;
    this.resizeTimer = null;
    this.moveTimer = null;
    this.destroyed = false;
    // 按需模式：窗口关闭即退出进程（宿主下次点击重建）；常驻模式仅隐藏窗口
    this.exitOnClose = options.exitOnClose !== false;
    // HTTP 控制通道（回环）：Windows 上 Electron 收不到 piped stdin，
    // 宿主无法用 stdin 协议下发 show/quit/attach。改由 dock 监听回环端口。
    this.controlServer = null;
    this.controlPort = 0;
  }

  async start() {
    const { app, BrowserWindow, ipcMain, powerMonitor, screen } = this.electron;
    trace('start: platform=' + this.platform + ' url=' + this.config.url);
    if (this.platform === 'win32') {
      // 硬件加速默认开启：关掉它会让透明窗口的透明区在重绘前被合成成不透明。
      // 万一某些机器 GPU 不稳，可设 DSH_QUICKDOCK_DISABLE_GPU=1 退回软件渲染。
      if (this.process.env.DSH_QUICKDOCK_DISABLE_GPU === '1') app.disableHardwareAcceleration();
      if (this.process.env.DSH_QUICKDOCK_GPU_SANDBOX !== '1') app.commandLine.appendSwitch('disable-gpu-sandbox');
    }
    app.setName('dsh-quickdock');
    trace('requestSingleInstanceLock...');
    if (!app.requestSingleInstanceLock()) {
      trace('SINGLE-INSTANCE-LOCK FAILED: another dock owns it, quitting');
      app.quit();
      return false;
    }
    app.on('second-instance', () => this.show());
    app.on('window-all-closed', () => {});
    app.on('before-quit', () => { this.quitting = true; });

    this.store = WindowStore.load(this.config.statePath || defaultStatePath(app, this.process.env), {
      delay: this.config.saveDelayMs,
    });
    trace('store loaded: ' + this.config.statePath);
    await app.whenReady();
    if (this.destroyed) return false;
    trace('app ready, gpu=' + (this.process.env.DSH_QUICKDOCK_DISABLE_GPU === '1' ? 'disabled' : 'enabled'));

    const restored = restoreBounds(this.store.state, screen, this.config);
    trace('restored bounds: ' + JSON.stringify(restored.bounds)
      + ' scale=' + (restored.display && restored.display.scaleFactor)
      + ' workArea=' + JSON.stringify(restored.display && restored.display.workArea));
    this.win = new BrowserWindow(sharedWindowOptions(Object.assign({ title: 'QuickDock' }, restored.bounds)));
    prepareWindow(this.win, this.store);
    // 记录一次初始几何：尺寸固定，但位置会随拖动改变，需要落盘供下次恢复
    this.remember();
    trace('created: bounds=' + JSON.stringify(this.win.getBounds())
      + ' content=' + JSON.stringify(this.win.getContentBounds())
      + ' contentSize=' + JSON.stringify(this.win.getContentSize()));

    // 展示窗口：与输入窗口分离，贴在它的上边或下边
    this.displayWin = this.createDisplayWindow(restored.display);
    trace('display window created: bounds=' + JSON.stringify(this.displayWin.getBounds()));
    // 记下创建时的内容尺寸作为标准尺寸：窗口移动会让客户区漂移，用它校正
    const initialSize = this.displayWin.getContentSize();
    this.displayWantW = initialSize[0];
    this.displayWantH = initialSize[1];
    trace('display want size = ' + initialSize);
    this.placeDisplayWindow(true);
    // 点击穿透在 show() 之后、首帧画完再启用（见 ensurePainted）：
    // 显示前就处于穿透态会让首帧带着 WS_EX_TRANSPARENT 合成，透明区画不出来。

    const wc = this.win.webContents;
    wc.on('will-navigate', (event, url) => {
      if (url !== this.config.url) {
        event.preventDefault();
        this.error(new Error('Blocked non-QuickDock navigation'));
      }
    });
    /**
     * 窗口关闭 → 按需模式下真正退出进程。
     *
     * exitOnClose 由宿主通过 DSH_QUICKDOCK_EXIT_ON_CLOSE 传入（默认 true）：
     *  - true （按需模式）：点 X / Esc → 窗口销毁 → 进程退出，宿主下次点击再重建。
     *  - false（常驻模式）：仅隐藏窗口，进程留着，唤出无延迟。
     */
    this.win.on('close', (event) => {
      if (this.quitting) return;
      if (!this.exitOnClose) {
        event.preventDefault();
        this.hide();
        return;
      }
      // 不 preventDefault：让窗口真正关闭，触发 'closed' → app.quit()
      this.quitting = true;
    });
    this.win.on('closed', () => {
      this.win = null;
      this.cleanup();
      this.store.close().catch(() => {}).then(() => {
        this.status('closed');
        if (!this.destroyed) {
          this.destroyed = true;
          app.quit();
        }
      });
    });
    // 拖动窗口：
    //  - 'move'  拖动过程中连续触发 → 让展示窗口**实时跟随**，不要等松手
    //  - 'moved' 松手后触发 → 再做夹回屏幕 + 落盘，避免拖动时反复写文件
    this.win.on('move', () => {
      if (this.moving) return;
      this.moving = true;
      this.placeDisplayWindow(false);
      // 用微任务节流：一次事件循环里最多跟一次
      Promise.resolve().then(() => { this.moving = false; });
    });    this.win.on('moved', () => {
      this.clearTimer(this.moveTimer);
      this.moveTimer = this.later(() => {
        this.clampIntoView();
        this.placeDisplayWindow(true);
      }, 150);
    });
    this.win.on('show', () => this.reinforceSkipTaskbar());
    this.win.on('ready-to-show', () => this.show());
    wc.on('did-finish-load', () => {
      this.clearTimer(this.showFallback);
      this.showFallback = this.later(() => this.show(), this.config.showFallbackMs);
    });
    wc.on('render-process-gone', (_event, details) => {
      this.status('error', { reason: 'render-process-gone', details: details && details.reason });
      this.quit(1);
    });

    // 两个窗口都可以发这些 IPC（输入窗口与展示窗口共用同一套 preload）。
    const sendAllowed = (event) => {
      const wc = eventWebContents(event);
      if (!wc) return false;
      if (this.win && !this.win.isDestroyed() && wc === this.win.webContents) return true;
      if (this.displayWin && !this.displayWin.isDestroyed() && wc === this.displayWin.webContents) return true;
      return false;
    };
    /** 命中区按窗口分别记录（两个窗口各自独立判定点击穿透）。 */
    this.regions = { input: { hit: [], drag: [] }, display: { hit: [], drag: [] } };
    ipcMain.on('dock:set-interactive', (event, value) => {
      if (sendAllowed(event) && typeof value === 'boolean') this.setInteractive(value);
    });
    ipcMain.on('dock:set-hit-regions', (event, value) => {
      if (sendAllowed(event) && this.validHitRegions(value)) {
        const which = this.whichWindow(event);
        this.regions[which].hit = value;
        // 记录展示窗口的命中区数量：为 0 就说明窗口会一直穿透（点不动）
        if (which === 'display') trace('display hit regions: ' + value.length);
      }
    });
    ipcMain.on('dock:set-drag-zones', (event, value) => {
      if (sendAllowed(event) && this.validHitRegions(value)) {
        this.regions[this.whichWindow(event)].drag = value;
      }
    });
    ipcMain.on('dock:hide', (event) => { if (sendAllowed(event)) this.hide(); });
    ipcMain.on('dock:set-display-empty', (event, empty) => {
      if (!sendAllowed(event) || typeof empty !== 'boolean') return;
      this.setDisplayVisible(!empty);
    });
    ipcMain.handle('dock:set-always-on-top', (event, flag) => {
      if (!sendAllowed(event) || typeof flag !== 'boolean') throw new TypeError('Invalid always-on-top request');
      this.win.setAlwaysOnTop(flag, 'screen-saver');
      this.remember({ alwaysOnTop: flag });
      this.sendState();
      return flag;
    });
    ipcMain.handle('dock:get-state', (event) => {
      if (!sendAllowed(event)) throw new Error('Untrusted IPC sender');
      return this.state();
    });

    const displaysChanged = () => {
      // 显示器拓扑变化（插拔/分辨率）：把窗口夹回可见范围
      this.clearTimer(this.resizeTimer);
      this.resizeTimer = this.later(() => this.clampIntoView(), 300);
    };
    for (const name of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(name, displaysChanged);
    powerMonitor.on('resume', () => this.reinforceSkipTaskbar());
    screen.on('unlock-screen', () => this.reinforceSkipTaskbar());

    for (const stream of [this.process.stdin, this.process.stdout]) {
      if (!stream || typeof stream.on !== 'function' || this.protocols.some((item) => item.stream === stream)) continue;
      this.protocols.push(new HostProtocol(stream, (message) => this.command(message), (error) => this.error(error)));
    }
    if (this.process.stdin && typeof this.process.stdin.resume === 'function') this.process.stdin.resume();
    trace('protocol wired: stdin=' + Boolean(this.process.stdin) + ' stdout=' + Boolean(this.process.stdout));

    // HTTP 控制通道：Windows 上 piped stdin 收不到，宿主改走这里
    await this.startControlServer();
    this.later(() => this.pollHost(), this.config.hostPollMs);
    this.later(() => this.pollHitTest(), this.config.hitPollMs);

    await this.win.loadURL(this.config.url);
    trace('loadURL done: ' + this.config.url);
    if (this.displayWin) {
      await this.displayWin.loadURL(this.config.url + (this.config.url.indexOf('?') >= 0 ? '&' : '?') + 'view=display');
      trace('display loadURL done');
    }
    this.status('ready', { pid: this.process.pid, bounds: this.win.getBounds(), controlPort: this.controlPort });
    trace('status(ready) written to stdout, controlPort=' + this.controlPort);
    this.sendState();
    return true;
  }

  /**
   * 创建展示窗口。
   *
   * 独立于输入窗口：输入框尺寸固定、展示内容天然增长，同处一个窗口就只能让窗口
   * 跟着内容伸缩。展示窗口自身尺寸固定（高=config.displayHeight），内容在其中滚动。
   */
  createDisplayWindow(display) {
    const { BrowserWindow } = this.electron;
    const area = (display && display.workArea) || { x: 0, y: 0, width: 1920, height: 1040 };
    const width = this.config.width;
    const height = Math.min(this.config.displayHeight || 520, area.height);
    const win = new BrowserWindow(sharedWindowOptions({
      width,
      height,
      x: Math.round(area.x + area.width - width - (this.config.margin || 16)),
      y: Math.round(area.y + area.height - height - (this.config.margin || 16)),
      title: 'QuickDock Display',
    }));
    prepareWindow(win, this.store);
    // 关闭展示窗口不应连带退出整个 dock，只收起它
    win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.hideDisplay();
    });
    return win;
  }

  /**
   * 把展示窗口贴到输入窗口的上边或下边。
   *
   * 规则：默认贴在**下方**；如果下方空间不够（会超出屏幕），就翻到上方。
   * 两者都不够时选空间多的那个，并夹回屏幕内。
   */
  /**
   * 把展示窗口的内容尺寸校正回目标值。
   *
   * 为什么需要：Windows 在非 100% 缩放下移动窗口时，客户区尺寸会自己漂移
   * （实测 604→606、304→312），因为 DIP 与物理像素反复换算取整。
   * 而 setContentSize 本身也会被取整 ±1，所以**不能**在拖动过程中反复纠正
   * ——两边会互相打架，表现就是窗口一边闪一边长大。
   *
   * 因此：拖动中只挪位置，松手后再调用本方法一次性校正。
   */
  enforceDisplaySize() {
    const win = this.displayWin;
    if (!win || win.isDestroyed()) return;
    const wantW = (this.win && this.win.getContentSize()[0]) || this.displayWantW || this.config.width;
    const wantH = this.displayWantH || this.config.displayHeight || 520;
    const cur = win.getContentSize();
    if (cur[0] === wantW && cur[1] === wantH) return;
    try {
      win.setContentSize(wantW, wantH);
      let after = win.getContentSize();
      // 系统取整吃掉 ±1 时按实测误差补偿一次（只补一次，避免振荡）
      if (after[0] !== wantW || after[1] !== wantH) {
        win.setContentSize(wantW - (after[0] - wantW), wantH - (after[1] - wantH));
        after = win.getContentSize();
      }
      trace('display size: ' + cur + ' -> ' + after + ' (want ' + wantW + ',' + wantH + ')');
    } catch (_) {}
  }

  placeDisplayWindow(fixSize) {
    if (!this.win || !this.displayWin) return;
    const input = this.win.getBounds();
    // 只在「不拖动」时校正尺寸；拖动中尺寸交给系统，松手后统一修正
    if (fixSize === true) this.enforceDisplaySize();
    const inputContent = this.win.getContentSize();
    const content = this.displayWin.getContentSize();
    const width = inputContent[0] || this.config.width;
    // 定位用**标准高度**，不用当前实测值：漂移时实测值会让位置跟着抖
    const height = this.displayWantH || content[1] || (this.config.displayHeight || 520);
    const display = currentDisplay(this.electron.screen, { x: input.x + input.width / 2, y: input.y + input.height / 2 });
    const area = display.workArea;
    // 两个窗口各有 10px 透明内边距（让圆角浮起来），所以窗口贴边时
    // 两块**面板**之间其实隔了 10 + 10 = 20px，看起来很远。
    // 这里让两窗轻微重叠，把「面板到面板」的视觉间距压到 PANEL_GAP。
    const EDGE_PAD = 10;     // 页面里 .stack / .display-body 的透明内边距
    const PANEL_GAP = 6;     // 想要的面板间距
    const gap = PANEL_GAP - 2 * EDGE_PAD;   // = -14，即两窗重叠 14px

    const below = input.y + input.height + gap;
    const above = input.y - height - gap;
    const spaceBelow = area.y + area.height - below;
    const spaceAbove = above - area.y;

    let y;
    if (spaceBelow >= Math.min(height, 120) || spaceBelow >= spaceAbove) {
      y = below;                       // 下方放得下（或下方空间更大）→ 放下方
    } else {
      y = above;                       // 放不下 → 翻到上方
    }
    // 夹回屏幕内，保证展示窗口完整可见
    y = Math.round(Math.max(area.y, Math.min(area.y + area.height - height, y)));
    const x = Math.round(Math.max(area.x, Math.min(area.x + area.width - width, input.x)));

    // 位置没变、尺寸也没漂就不动：SSE 每次 state 推送都会走到这里，
    // 无脑设置会让两个窗口反复抖动。
    const wasAbove = this.displayAbove;
    this.displayAbove = y < input.y;
    const current = this.displayWin.getBounds();
    const wantW = this.displayWantW || width;
    const wantH = this.displayWantH || height;
    const sizeDrift = content[0] !== wantW || content[1] !== wantH;
    if (current.x !== x || current.y !== y || sizeDrift) {
      // **一次把位置和尺寸都设**：单独 setPosition 时 Windows 会在高缩放下
      // 反复取整客户区，拖久了窗口会越拖越大（实测每步 +1~2px）。
      // 顺带把尺寸纠回去，所以拖动过程中也不需要再单独校正。
      this.displayWin.setBounds({ x, y, width: wantW, height: wantH });
      trace('display placed: x=' + x + ' y=' + y + ' above=' + this.displayAbove
        + ' size=' + wantW + 'x' + wantH
        + (sizeDrift ? ' (fixed from ' + content + ')' : ''));
    }
    // 上/下变了要通知页面：贴在下方时内容从顶部生长，贴在上方时从底部生长
    // （这样内容始终紧贴输入窗口，不会在中间留一大块空隙）。
    if (wasAbove !== this.displayAbove) this.sendState();
  }

  /**
   * 强制重绘两个窗口。
   *
   * 为什么需要：Windows 上透明窗口的透明区有时不会在首次合成时生效，
   * 要等到"有事件"（鼠标移进来、拖一下）才重画成透明 ——
   * 表现就是「鼠标移到窗口上，背景才变透明」。
   *
   * 做法：
   *   1. webContents.invalidate() 让 Chromium 重画整页
   *   2. 尺寸 +1px 再还原，逼 DWM 重新合成这一层（位置不动，肉眼不可见）
   */
  ensurePainted() {
    const invalidate = (win) => {
      if (!win || win.isDestroyed()) return;
      try { win.webContents.invalidate(); } catch (_) {}
    };
    const both = () => {
      for (const win of [this.win, this.displayWin]) invalidate(win);
    };
    both();
    // 首帧画完之后再启用"点击穿透"（此时透明区已经正确合成）。
    const arm = () => {
      if (this.win && !this.win.isDestroyed()) this.applyClickThrough(this.win, !this.interactive);
      if (this.displayWin && !this.displayWin.isDestroyed()) this.applyClickThrough(this.displayWin, !this.displayInteractive);
    };
    this.later(arm, 0);
    // 首帧合成有时比 load 事件晚，隔一帧再补一次
    this.later(both, 90);
  }

  /** 显示/隐藏展示窗口（没有执行内容时隐藏）。 */
  setDisplayVisible(visible) {
    if (!this.displayWin) return;
    if (visible) {
      this.placeDisplayWindow(true);
      if (!this.displayWin.isVisible()) {
        this.displayWin.showInactive();
        this.ensurePainted();
        trace('display shown');
      }
    } else if (this.displayWin.isVisible()) {
      this.displayWin.hide();
      trace('display hidden');
    }
  }

  hideDisplay() {
    if (this.displayWin && this.displayWin.isVisible()) this.displayWin.hide();
  }

  /**
   * 启动回环 HTTP 控制通道。
   *
   * 为什么要它：Windows 上 Electron 主进程收不到 piped stdin（DESIGN §3.3 记录过），
   * 宿主无法通过 stdin 下发 show/quit/attach —— 实测 quit 命令根本收不到。
   * 改为 dock 监听 127.0.0.1 随机端口，宿主用 HTTP 调用。
   *
   * 安全：仅绑定回环地址；每个请求必须带一次性 token（宿主启动时通过 env 传入）。
   */
  async startControlServer() {
    const token = this.process.env.DSH_QUICKDOCK_CONTROL_TOKEN;
    if (!token) { trace('control server skipped: no token'); return }
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/control' || url.searchParams.get('t') !== token) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end('{"ok":false}');
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        let message = {};
        try { message = body ? JSON.parse(body) : {} } catch (e) {}
        try {
          this.command(message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"ok":false}');
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.controlPort = server.address().port;
        resolve();
      });
    });
    this.controlServer = server;
    trace('control server listening on 127.0.0.1:' + this.controlPort);
  }

  validHitRegions(value) {
    return Array.isArray(value) && value.length <= 1000 && value.every((rect) => rect
      && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key]))
      && rect.width >= 0 && rect.height >= 0 && rect.width <= 10000 && rect.height <= 10000);
  }

  state() {
    return {
      alwaysOnTop: this.store ? this.store.state.alwaysOnTop : false,
      displayAbove: Boolean(this.displayAbove),
    };
  }

  /** 向两个窗口广播（输入窗口 + 展示窗口）。 */
  send(channel, value) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, value);
    if (this.displayWin && !this.displayWin.isDestroyed()) this.displayWin.webContents.send(channel, value);
  }

  sendState() { this.send('dock:state', this.state()); }

  status(type, details) {
    writeStatus(this.process.stdout, type, details);
  }

  error(error) {
    this.status('error', { message: error && error.message ? error.message : String(error) });
  }

  setInteractive(value) {
    this.interactive = value;
    this.applyClickThrough(this.win, !value);
  }

  /**
   * 拖动结束后把窗口夹回可见范围。
   *
   * 用户可以拖到屏幕外，但必须能拖回来 —— 所以松手时把窗口完整拉回 workArea。
   */
  clampIntoView() {
    if (!this.win) return;
    const outer = this.win.getBounds();
    const display = currentDisplay(this.electron.screen, outer);
    const content = this.win.getContentSize();
    // 以实际外框尺寸参与夹取（内容区 + 不可见边框），保证整窗可见
    const clamped = clampBounds(display.workArea, {
      x: outer.x, y: outer.y, width: outer.width, height: outer.height,
    });
    if (clamped.x !== outer.x || clamped.y !== outer.y) {
      this.win.setPosition(clamped.x, clamped.y);
    }
    void content;
    this.remember();
  }

  remember(patch) {
    if (!this.store || !this.win || !this.config.rememberGeometry) return;
    const outer = this.win.getBounds();
    const content = this.win.getContentSize();
    const display = currentDisplay(this.electron.screen, outer);
    this.store.update(Object.assign({
      x: outer.x,
      y: outer.y,
      // 存内容区尺寸：下次创建时配合 useContentSize 才能还原成同样大小的视口
      width: content[0],
      height: content[1],
      displayId: display.id,
    }, patch || {}));
  }

  reinforceSkipTaskbar() {
    if (!this.win) return;
    this.win.setSkipTaskbar(true);
    this.later(() => { if (this.win) this.win.setSkipTaskbar(true); }, 0);
  }

  show() {
    if (!this.win || this.destroyed) return;
    this.clearTimer(this.showFallback);
    this.reinforceSkipTaskbar();
    if (this.config.focusOnSummon) this.win.show();
    else this.win.showInactive();
    this.placeDisplayWindow(true);
    // 显示后主动重绘一次：否则透明区要等鼠标移入才变透明
    this.ensurePainted();
    this.status('shown');
    this.sendState();
  }

  hide() {
    if (!this.win || this.destroyed) return;
    this.remember();
    this.hideDisplay();
    // 按需模式：隐藏等同于退出，否则进程会残留（用户已明确表示希望点完即走）
    if (this.exitOnClose) {
      this.quitting = true;
      this.win.close();
      return;
    }
    this.win.hide();
    this.status('hidden');
  }

  command(message) {
    trace('command: ' + JSON.stringify(message));
    if (message.type === 'quit') this.quit(0);
    else if (message.type === 'show') this.show();
    else if (message.type === 'ping') this.status('pong');
    else if (message.type === 'attach') this.show();
    else if (message.type === 'window') {
      if (message.alwaysOnTop !== undefined && this.win && !this.win.isDestroyed()) {
        this.win.setAlwaysOnTop(Boolean(message.alwaysOnTop), 'screen-saver');
        if (this.store) this.store.state.alwaysOnTop = Boolean(message.alwaysOnTop);
      }
      this.show();
      this.sendState();
    }
  }

  isHostAlive() {
    try {
      this.process.kill(this.config.hostPid, 0);
      return true;
    } catch (error) {
      return error.code !== 'ESRCH';
    }
  }

  pollHost() {
    if (this.destroyed) return;
    if (!this.isHostAlive()) {
      this.status('closed', { reason: 'host-exited' });
      this.quit(0);
      return;
    }
    this.later(() => this.pollHost(), this.config.hostPollMs);
  }

  /** 判断 IPC 来自哪个窗口。 */
  whichWindow(event) {
    const wc = eventWebContents(event);
    if (this.displayWin && !this.displayWin.isDestroyed() && wc === this.displayWin.webContents) return 'display';
    return 'input';
  }

  /**
   * 命中测试：对两个窗口分别判断光标是否落在可交互区 / 拖动区，
   * 落在里面就取消该窗口的点击穿透。
   */
  pollHitTest() {
    if (this.destroyed) return;
    const point = (() => {
      try { return this.electron.screen.getCursorScreenPoint(); } catch (_) { return null; }
    })();
    if (point) {
      this.updateWindowHit(this.win, this.regions.input, point);
      this.updateWindowHit(this.displayWin, this.regions.display, point);
    }
    this.later(() => this.pollHitTest(), this.config.hitPollMs);
  }

  /**
   * 切换"点击穿透"并强制重绘。
   *
   * Windows 上每次切换 WS_EX_TRANSPARENT 都会让窗口重新合成，
   * 而透明区在这之后可能又退回不透明，直到下一次重绘。
   * 所以切换完立刻 invalidate 一次 —— 这正是「鼠标离开窗口后又变回色块」的原因。
   */
  applyClickThrough(win, ignore) {
    if (!win || win.isDestroyed()) return;
    // 诊断开关：完全不启用穿透（窗口始终可交互）。
    // 如果透明区仍有问题，设 DSH_QUICKDOCK_NO_CLICK_THROUGH=1 可排除穿透的影响。
    if (this.noClickThrough) return;
    try { win.setIgnoreMouseEvents(ignore, { forward: true }); } catch (_) { return; }
    try { win.webContents.invalidate(); } catch (_) {}
  }

  updateWindowHit(win, regions, point) {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (!regions) return;
    const hasHit = Array.isArray(regions.hit) && regions.hit.length > 0;
    const hasDrag = Array.isArray(regions.drag) && regions.drag.length > 0;
    if (!hasHit && !hasDrag) return;
    try {
      const bounds = win.getBounds();
      const hit = hasHit ? pointInRects(point, bounds, regions.hit) : false;
      // 拖动区单独判定：光标在拖动条上时必须取消穿透，
      // 否则 -webkit-app-region: drag 收不到真实鼠标事件，窗口拖不动。
      const overDrag = hasDrag ? pointInRects(point, bounds, regions.drag) === true : false;
      const want = Boolean(hit) || overDrag;
      const key = win === this.displayWin ? 'displayInteractive' : 'interactive';
      if (want !== this[key]) {
        this[key] = want;
        this.applyClickThrough(win, !want);
      }
    } catch (_) {
      // Cursor/display queries can fail during a display topology transition.
    }
  }

  later(callback, delay) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.destroyed) callback();
    }, delay);
    if (timer.unref) timer.unref();
    this.timers.add(timer);
    return timer;
  }

  clearTimer(timer) {
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
  }

  cleanup() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const protocol of this.protocols) protocol.dispose();
    this.protocols = [];
    if (this.controlServer) {
      try { this.controlServer.close() } catch (_) {}
      this.controlServer = null;
    }
    if (this.displayWin && !this.displayWin.isDestroyed()) {
      try { this.displayWin.destroy(); } catch (_) {}
      this.displayWin = null;
    }
  }

  async quit(code) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.quitting = true;
    this.cleanup();
    if (this.store) await this.store.close().catch(() => {});
    if (code !== undefined) this.process.exitCode = code;
    this.electron.app.quit();
  }
}

async function startRuntime(electron, options) {
  const opts = options || {};
  const proc = opts.process || process;
  try {
    const config = opts.config || parseConfig(proc.argv.slice(1), proc.env);
    trace('config parsed ok: url=' + config.url + ' hostPid=' + config.hostPid);
    const runtime = new DockRuntime(electron, Object.assign({}, opts, { process: proc, config }));
    await runtime.start();
    return runtime;
  } catch (error) {
    trace('START-THREW ' + (error && error.stack || error));
    throw error;
  }
}

module.exports = { DockRuntime, startRuntime };

/**
 * ⚠️ 不能用 `if (require.main === module)` 守卫自执行！
 *
 * Electron 用 `<exe> <script>` 启动时是通过 default_app.asar **require()** 入口文件的，
 * 因此 require.main 指向 electron 自身（`require.main.filename === 'electron'`），
 * 与 module 永远不相等 → 自执行块永不运行 → dock 静默不启动（实测确认）。
 *
 * 这里改为无条件自执行；被宿主以库方式 require 时（仅测试用）不会造成副作用，
 * 因为那种情况下 Electron API 不存在，startRuntime 会立即失败并被 catch 吞掉。
 */
startRuntime(require('electron')).catch((error) => {
  trace('AUTOSTART-FAILED ' + (error && error.stack || error));
});