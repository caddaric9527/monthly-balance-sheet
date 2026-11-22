import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './routes.js';
import { authRouter, requireAuthApi, requireAuthPage, authStatus } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8080;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '4mb' }));

const version = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return '';
  }
})();
process.env.APP_VERSION = version;

// 登录页不依赖其它静态资源
app.get(['/login', '/login.html'], (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// 公开鉴权接口
app.use('/api', authRouter);

// 业务接口需登录；/api/health 供容器健康检查放行
app.use(
  '/api',
  (req, res, next) => (req.path === '/health' ? next() : requireAuthApi(req, res, next)),
  api,
);

app.use(
  requireAuthPage,
  express.static(PUBLIC_DIR, {
    etag: true,
    lastModified: true,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, '0.0.0.0', () => {
  const a = authStatus();
  console.log(`月度资产负债表已启动: http://0.0.0.0:${PORT}  版本 ${version || 'dev'}`);
  if (a.enabled) {
    console.log(`密码认证已开启，登录有效期 ${a.days} 天`);
  } else {
    console.warn('警告：未设置 AUTH_PASSWORD，网站无密码保护，任何能访问该端口的人都能看到你的资产数据');
  }
});
