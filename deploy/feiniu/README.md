# 安装到飞牛 NAS（fnOS）

飞牛 NAS 自带 Docker，本项目一个容器、一个 SQLite 文件即可跑完，无需额外数据库。

## 前置条件

1. 飞牛「应用中心」里已安装 **Docker**（新版 fnOS 默认自带）。
2. 「设置 → 系统设置 → 远程访问 → SSH」已开启（一键脚本需要；只走网页端安装则不必打开）。
3. 记下你的存储空间路径，例如 `/vol1/1000/docker`（「文件管理」里能看到实际路径）。

## 方式一：SSH 一键脚本（推荐）

在 NAS 的终端（或电脑 SSH 上去）执行：

```bash
curl -fsSL https://raw.githubusercontent.com/caddaric9527/monthly-balance-sheet/main/deploy/feiniu/install.sh -o install.sh
bash install.sh --port 8899
```

脚本会依次完成：检查 Docker → 拉取源码 → 生成 `.env`（含随机访问密码）→ 构建镜像 → 启动容器 → 等待健康检查 → 打印访问地址。

常用参数：

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `--port` | 宿主机访问端口 | `8899` |
| `--password` | 网站访问密码 | 随机生成 |
| `--dir` | 安装目录 | 自动探测 `/vol1/1000/docker/monthly-balance-sheet` |
| `--registry` | 构建时 npm 源 | 官方源，国内建议 `https://registry.npmmirror.com` |
| `--node-image` | 基础镜像 | `node:22-bookworm-slim` |

国内网络拉不到 Docker Hub 时：

```bash
bash install.sh --registry https://registry.npmmirror.com \
  --node-image docker.m.daocloud.io/library/node:22-bookworm-slim
```

## 方式二：飞牛 Docker 网页端「项目」

1. 先用方式一（或任何一台装了 Docker 的机器）构建出镜像 `monthly-balance-sheet:2.0.0`，
   否则网页端只能拉取、不能构建（构建上下文在网页端不可见）。
2. 把 `deploy/feiniu/docker-compose.yml` 里的数据路径和密码改成你自己的，删掉 `build:` 三行。
3. 飞牛「Docker → 项目 → 新建」，粘贴 compose 内容，保存并启动。

## 方式三：离线镜像导入

在一台能联网、装了 Docker 的机器上：

```bash
git clone https://github.com/caddaric9527/monthly-balance-sheet.git
cd monthly-balance-sheet
docker build -t monthly-balance-sheet:2.0.0 .
docker save monthly-balance-sheet:2.0.0 | gzip > balance.tar.gz
```

把 `balance.tar.gz` 传到 NAS，然后：

```bash
gunzip -c balance.tar.gz | docker load
```

再用方式二或 `docker compose up -d` 启动。

## 访问与初始化

- 地址：`http://<NAS局域网IP>:8899`
- 首次进入：**设置** 页确认汇率来源（自动 / 手动）→ **持仓** 页新建组合（填币种、说明）
- 每月月底：**月末录入** → 填各账户现金余额 → 理财市值自动按持仓折算 → 保存
- 老项目 `portfolio-tracker` 的历史数据可用 `node scripts/import-legacy.mjs /path/to/portfolio.db` 一次性导入

## 备份

所有数据都在挂载目录下的 `balance.db`：

```bash
# 冷备份（停机 1 秒）
docker compose stop && cp data/balance.db ~/backup/balance-$(date +%F).db && docker compose start
```

也可以在网页「设置 → 导出」拿到完整 JSON，恢复时用「导入」。

## 更新

```bash
cd /vol1/1000/docker/monthly-balance-sheet
git pull
docker compose up -d --build
```

数据在 `data/` 里，重建镜像不会丢。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `permission denied while trying to connect to the Docker daemon` | 当前用户不在 docker 组，用 `sudo bash install.sh`，或 `sudo usermod -aG docker $USER` 后重新登录 |
| 构建卡在 `FROM node:...` | 基础镜像拉不动，加 `--node-image docker.m.daocloud.io/library/node:22-bookworm-slim` |
| 构建卡在 `npm ci` | 加 `--registry https://registry.npmmirror.com` |
| 打开页面 502 / 无法访问 | `docker compose logs -f` 看日志；确认端口未冲突：`ss -lntp \| grep 8899` |
| 想换端口 | 改 `.env` 里的 `HOST_PORT` 后 `docker compose up -d` |
| 忘记密码 | `cat .env` 里看 `AUTH_PASSWORD`；想取消密码就设为空并重启 |
