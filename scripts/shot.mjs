/**
 * CDP 驱动无头 Chrome 截图（不依赖 puppeteer）。
 * 用法：node scripts/shot.mjs <url> <输出目录> [宽] [高]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT) || 9345;
const URL_ARG = process.argv[2] || 'http://127.0.0.1:8911/';
const OUT_DIR = process.argv[3] || 'docs/screenshots';
const WIDTH = Number(process.argv[4]) || 1280;
const HEIGHT = Number(process.argv[5]) || 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitVersion = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  throw new Error('Chrome 调试端口未就绪');
};

const connect = (wsUrl) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const { ok, bad } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? bad(new Error(JSON.stringify(m.error))) : ok(m.result);
      }
    };
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((ok, bad) => {
            const i = ++id;
            pending.set(i, { ok, bad });
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
        close: () => ws.close(),
      });
  });

const main = async () => {
  fs.mkdirSync(path.resolve(OUT_DIR), { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${PORT}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      '--user-data-dir=' + path.join(process.env.TEMP || '/tmp', 'bs-chrome-profile'),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    await waitVersion();
    const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
    const page = targets.find((t) => t.type === 'page');
    const pageCdp = await connect(page.webSocketDebuggerUrl);
    await pageCdp.send('Page.enable');
    await pageCdp.send('Runtime.enable');
    await pageCdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 2,
      mobile: false,
    });

    await pageCdp.send('Page.navigate', { url: URL_ARG });
    await sleep(2600);

    const { data } = await pageCdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const name = `${new URL(URL_ARG).searchParams.get('shot') || 'page'}.png`;
    fs.writeFileSync(path.resolve(OUT_DIR, name), Buffer.from(data, 'base64'));
    console.log(`已保存 ${path.join(OUT_DIR, name)}`);

    pageCdp.close();
  } finally {
    chrome.kill();
  }
};

main().catch((e) => {
  console.error('截图失败：', e.message);
  process.exit(1);
});
