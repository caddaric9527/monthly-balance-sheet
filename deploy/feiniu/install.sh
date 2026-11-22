#!/usr/bin/env bash
# 飞牛 NAS（fnOS）一键安装脚本
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/caddaric9527/monthly-balance-sheet/main/deploy/feiniu/install.sh | bash
# 或者先下载再看内容：
#   bash install.sh --port 8899 --password 你的访问密码
set -euo pipefail

APP_NAME="monthly-balance-sheet"
CONTAINER_NAME="balance"
REPO_URL="${REPO_URL:-https://github.com/caddaric9527/monthly-balance-sheet.git}"
REPO_TARBALL="${REPO_TARBALL:-https://codeload.github.com/caddaric9527/monthly-balance-sheet/tar.gz/refs/heads/main}"
APP_VERSION="${APP_VERSION:-2.0.0}"

HOST_PORT="${HOST_PORT:-8899}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
BASE_DIR="${BASE_DIR:-}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
NODE_IMAGE="${NODE_IMAGE:-node:22-bookworm-slim}"
TZ_VALUE="${TZ_VALUE:-Asia/Shanghai}"
ASSUME_YES=0

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info() { color "36" "==> $*"; }
ok()   { color "32" " ✓  $*"; }
warn() { color "33" " !  $*"; }
die()  { color "31" " ✗  $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
飞牛 NAS 一键安装：月度个人资产负债表

参数：
  --port <端口>           宿主机访问端口，默认 8899
  --password <密码>       网站访问密码（留空则自动生成随机密码）
  --dir <绝对路径>        安装目录，默认自动探测 /vol1/1000/docker/monthly-balance-sheet
  --registry <npm源>      构建时的 npm 源，默认官方源；国内可填 https://registry.npmmirror.com
  --node-image <镜像>     基础镜像，默认 node:22-bookworm-slim；拉不动可换镜像站地址
  -y, --yes               不询问，直接执行
  -h, --help              显示帮助

示例：
  bash install.sh --port 8899 --registry https://registry.npmmirror.com
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) HOST_PORT="$2"; shift 2 ;;
    --password) AUTH_PASSWORD="$2"; shift 2 ;;
    --dir) BASE_DIR="$2"; shift 2 ;;
    --registry) NPM_REGISTRY="$2"; shift 2 ;;
    --node-image) NODE_IMAGE="$2"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（-h 查看帮助）" ;;
  esac
done

# ---------- 前置检查 ----------
info "检查 Docker 环境"
if ! command -v docker >/dev/null 2>&1; then
  die "未找到 docker。请先在飞牛「应用中心」安装 Docker，再重新运行本脚本。"
fi

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    warn "当前用户无权访问 Docker，改用 sudo 执行"
    DOCKER="sudo docker"
    sudo docker info >/dev/null 2>&1 || die "sudo 也无法访问 Docker，请检查 Docker 服务是否运行。"
  else
    die "当前用户无权访问 Docker，请用 root 或加入 docker 用户组后重试。"
  fi
fi

if $DOCKER compose version >/dev/null 2>&1; then
  COMPOSE="$DOCKER compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="$( [ "$DOCKER" = "sudo docker" ] && echo 'sudo docker-compose' || echo 'docker-compose' )"
else
  die "未找到 docker compose 插件，请升级 Docker（飞牛应用中心的版本自带 compose）。"
fi
ok "$($DOCKER --version | head -1) / $($COMPOSE version --short 2>/dev/null || echo compose)"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ok "架构 $ARCH" ;;
  aarch64|arm64) warn "架构 $ARCH，会走源码构建，首次安装较慢（5-10 分钟）" ;;
  *) die "不支持的架构：$ARCH" ;;
esac

# ---------- 安装目录 ----------
if [ -z "$BASE_DIR" ]; then
  for base in /vol1/1000/docker /vol1/docker /vol2/1000/docker /volume1/docker /opt/docker; do
    parent="$(dirname "$base")"
    if [ -d "$parent" ]; then BASE_DIR="$base/$APP_NAME"; break; fi
  done
  [ -n "$BASE_DIR" ] || BASE_DIR="$HOME/docker/$APP_NAME"
fi
info "安装目录：$BASE_DIR"
mkdir -p "$BASE_DIR"
cd "$BASE_DIR"

# ---------- 获取源码 ----------
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  info "更新源码（git pull）"
  git fetch --depth=1 origin main >/dev/null 2>&1 || true
  git reset --hard origin/main >/dev/null 2>&1 || warn "拉取失败，沿用本地源码"
elif [ -f Dockerfile ]; then
  ok "沿用已有源码"
else
  tmp="$(mktemp -d)"
  if command -v git >/dev/null 2>&1; then
    info "克隆仓库"
    git clone --depth=1 "$REPO_URL" "$tmp/src" || die "克隆失败，请检查 NAS 能否访问 GitHub"
  else
    info "下载源码包"
    command -v curl >/dev/null 2>&1 || die "系统没有 git 也没有 curl，请先安装其一"
    curl -fL --retry 3 -o "$tmp/src.tar.gz" "$REPO_TARBALL" || die "下载失败，请检查 NAS 网络"
    mkdir -p "$tmp/src" && tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" --strip-components=1
  fi
  cp -a "$tmp/src/." "$BASE_DIR/"
  rm -rf "$tmp"
fi
[ -f Dockerfile ] || die "源码不完整：$BASE_DIR 里没有 Dockerfile"

# ---------- 生成 .env ----------
if [ -z "$AUTH_PASSWORD" ]; then
  if [ -f .env ] && grep -q '^AUTH_PASSWORD=.\+' .env; then
    AUTH_PASSWORD="$(grep '^AUTH_PASSWORD=' .env | head -1 | cut -d= -f2-)"
    ok "沿用已有访问密码"
  else
    AUTH_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)"
    warn "已生成随机访问密码：$AUTH_PASSWORD"
  fi
fi

mkdir -p data
cat > .env <<EOF
# 由 deploy/feiniu/install.sh 生成于 $(date '+%Y-%m-%d %H:%M:%S')
HOST_PORT=$HOST_PORT
AUTH_PASSWORD=$AUTH_PASSWORD
AUTH_DAYS=30
TZ=$TZ_VALUE
APP_VERSION=$APP_VERSION
CONTAINER_NAME=$CONTAINER_NAME
HOST_DATA_DIR=$BASE_DIR/data
NODE_IMAGE=$NODE_IMAGE
NPM_REGISTRY=$NPM_REGISTRY
EOF
chmod 600 .env
ok ".env 已写入（端口 $HOST_PORT，数据目录 $BASE_DIR/data）"

if [ "$ASSUME_YES" -ne 1 ] && [ -t 0 ]; then
  printf '即将构建镜像并启动容器，继续？[Y/n] '
  read -r answer
  case "$answer" in [nN]*) die "已取消" ;; esac
fi

# ---------- 构建并启动 ----------
info "构建镜像（首次约 2-6 分钟，取决于 NAS 性能与网络）"
$COMPOSE build --build-arg NPM_REGISTRY="$NPM_REGISTRY" --build-arg NODE_IMAGE="$NODE_IMAGE" \
  || die "镜像构建失败，常见原因：拉不到 node 基础镜像（试 --node-image docker.m.daocloud.io/library/node:22-bookworm-slim）"

info "启动容器"
$COMPOSE up -d

# ---------- 等健康 ----------
info "等待服务就绪"
ready=0
for _ in $(seq 1 40); do
  if $DOCKER exec "$CONTAINER_NAME" node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 3
done
[ "$ready" -eq 1 ] || { $DOCKER logs --tail 40 "$CONTAINER_NAME"; die "服务未就绪，日志见上"; }

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
[ -n "$LAN_IP" ] || LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$LAN_IP" ] || LAN_IP="<NAS的局域网IP>"

echo
ok "安装完成"
cat <<EOF

  访问地址   http://$LAN_IP:$HOST_PORT
  访问密码   $AUTH_PASSWORD
  安装目录   $BASE_DIR
  数据文件   $BASE_DIR/data/balance.db   （备份就拷这个目录）

  常用命令（在该目录下执行）
    cd $BASE_DIR
    $COMPOSE logs -f          # 看日志
    $COMPOSE restart          # 重启
    $COMPOSE down             # 停止
    $COMPOSE up -d            # 启动
    $COMPOSE up -d --build    # 更新到最新代码

  下一步：打开网页 → 设置 → 持仓 → 新建组合，然后每月月底点「月末录入」。
EOF
