#!/usr/bin/env bash
# 家庭医学存档 · 一键安装/升级脚本（Debian/Ubuntu + systemd）
# 用法:  curl -fsSL https://raw.githubusercontent.com/wolfpan/medical-archive/main/install.sh | sudo bash
# 自定义: sudo INSTALL_DIR=/opt/xxx PORT=3000 curl -fsSL … | bash
# 重复执行同一命令即可升级到最新版本（数据目录不受影响）
set -euo pipefail

REPO="https://github.com/wolfpan/medical-archive.git"
DIR="${INSTALL_DIR:-/opt/medical-archive}"
PORT="${PORT:-3000}"
SERVICE=medical-archive

[ "$(id -u)" = 0 ] || { echo "[错误] 请使用 root 或 sudo 运行"; exit 1; }
command -v apt-get >/dev/null 2>&1 || { echo "[错误] 本脚本支持 Debian/Ubuntu（apt 系）；其他发行版请参照 README 手动部署"; exit 1; }
echo "==> 安装目录: $DIR   端口: $PORT"

# 1) Node.js >= 23（缺失则经 NodeSource 安装 Node 24）
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [ "$major" -ge 23 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  echo "==> 未检测到 Node.js 23+，安装 Node.js 24（NodeSource）"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi
echo "==> Node.js: $(node -v)"

# 2) 代码：已有则升级，否则克隆（无 git 时下载压缩包）
if [ -d "$DIR/.git" ]; then
  echo "==> 检测到已有安装，升级到最新版本"
  git -C "$DIR" pull --ff-only
elif command -v git >/dev/null 2>&1; then
  echo "==> 克隆代码到 $DIR"
  git clone --depth 1 "$REPO" "$DIR"
else
  echo "==> 无 git，下载代码压缩包"
  mkdir -p "$DIR"
  curl -fsSL https://github.com/wolfpan/medical-archive/archive/refs/heads/main.tar.gz | tar -xz --strip-components=1 -C "$DIR"
fi

# 3) 数据目录与运行用户（代码可被所有用户读取，数据仅服务用户可写）
id -u www-data >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin www-data
mkdir -p "$DIR/data/uploads"
chown -R www-data:www-data "$DIR/data"

# 4) systemd 常驻服务
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=Family Medical Archive
After=network.target

[Service]
WorkingDirectory=${DIR}
ExecStart=$(command -v node) ${DIR}/server.js
Environment=PORT=${PORT}
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ${SERVICE} >/dev/null 2>&1
systemctl restart ${SERVICE}

sleep 1
systemctl is-active --quiet ${SERVICE} || { echo "[错误] 服务未启动，最近日志："; journalctl -u ${SERVICE} -n 20 --no-pager; exit 1; }

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "=============================================="
echo " 安装/升级完成，访问: http://${IP:-<服务器IP>}:${PORT}"
echo " 首次打开会引导设置管理密码"
echo " 数据目录: $DIR/data （定期备份，网页端也可一键完整备份）"
echo " 升级:     重复执行本安装命令即可"
echo "=============================================="
