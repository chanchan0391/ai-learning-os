#!/bin/zsh

set -e

cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "AI Learning OS 需要安装 Node.js 20 或更高版本。"
  echo "请安装 Node.js 后重新双击此文件。"
  read -r "?按回车键关闭..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次启动，正在准备应用..."
  npm install
fi

echo "正在启动 AI Learning OS..."
echo "关闭此窗口即可停止应用。"
exec npm start
