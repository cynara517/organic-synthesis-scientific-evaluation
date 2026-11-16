#!/bin/sh
# 生成可直接分享的安装命令和市场索引条目。
# 本脚本位于仓库的 scientific-trace/ 子目录，会自动定位仓库根目录。
#
# 用法：
#   sh scripts/make-share.sh <GitHub用户名> [仓库名] [SHA]
#
# 不传 SHA 时使用本地 HEAD。通过网页手动上传时，GitHub 上的 SHA 与本地不同，
# 必须从网页复制 40 位完整 SHA 作为第三个参数传入。
set -e

USER=${1:?用法: sh scripts/make-share.sh <GitHub用户名> [仓库名] [commit SHA]}
REPO=${2:-organic-synthesis-scientific-evaluation}

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PKG_DIR=$(CDPATH= cd -- "$HERE/.." && pwd -P)
ROOT=$(CDPATH= cd -- "$PKG_DIR/.." && pwd -P)

# 插件在本仓库中的子目录名，例如 scientific-trace。
SUBDIR=$(basename "$PKG_DIR")
# 相对仓库根的路径，供 pnpm 的 path: 参数使用。
REL=${PKG_DIR#"$ROOT"/}

NAME=$(node -p "require('$PKG_DIR/package.json').name")
VERSION=$(node -p "require('$PKG_DIR/package.json').version")

if [ -n "$3" ]; then
  COMMIT=$3
  case "$COMMIT" in
    *[!0-9a-f]*|'') echo "错误：commit 必须是 40 位小写十六进制。" >&2; exit 1 ;;
  esac
  if [ ${#COMMIT} -ne 40 ]; then
    echo "错误：commit 必须是 40 位，当前 ${#COMMIT} 位。短 SHA 不适用于市场索引。" >&2
    exit 1
  fi
else
  COMMIT=$(git -C "$ROOT" rev-parse HEAD)
  echo "提示：使用本地 HEAD $COMMIT。若你是通过网页手动上传的，" >&2
  echo "      GitHub 上的 SHA 会不同，请把它作为第三个参数传入。" >&2
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "警告：工作区有未提交改动，commit SHA 可能不包含最新代码。" >&2
  fi
fi

URL="https://github.com/$USER/$REPO"
# pnpm 从子目录安装插件所需的后缀：固定 commit 后接 path 参数。
SPEC="git+$URL.git#$COMMIT&path:/$REL"

cat <<EOF

=== 安装命令（发给别人）===

在 DSH 的 Plugins → Add plugin 里粘贴：

  $SPEC

或在命令行：

  dsh plugin --profile <你的profile> add "$SPEC"

说明：插件位于仓库的 $REL/ 子目录，所以需要 &path:/$REL 指定目录。
      commit 必须固定为完整 40 位，分支名不保证可复现。

=== 市场索引条目 ===

把下面这段放进索引 JSON 的 plugins 数组：

EOF

node - "$PKG_DIR" "$USER" "$REPO" "$COMMIT" "$REL" <<'NODE'
const [pkgDir, user, repo, commit, rel] = process.argv.slice(2)
const p = require(`${pkgDir}/package.json`)
const url = `https://github.com/${user}/${repo}`
console.log(JSON.stringify({
  name: p.name,
  title: {en: 'Scientific Trace', zh: '科学轨迹'},
  description: {
    en: 'Four-stage scientific workflow with experience planning, structured tool selection, real Python execution, and evidence-linked traces.',
    zh: '四阶段科学工作流：经验规划、结构化工具选择、真实 Python 执行与可追溯证据链。'
  },
  author: user,
  homepage: url,
  repository: {url, directory: rel},
  // jsDelivr 而非 github.com/raw：后者 302 到 raw.githubusercontent.com，
  // 该域名在部分网络下不可达。
  icon: `https://cdn.jsdelivr.net/gh/${user}/${repo}@main/${rel}/icon.svg`,
  versions: [{
    version: p.version,
    publishTimestamp: Math.floor(Date.now() / 1000),
    source: {type: 'git', url, commit, path: rel},
    engines: {dsh: p.engines.dsh}
  }]
}, null, 2))
NODE

cat <<EOF

=== 完整索引文件骨架 ===

保存为 index.json，放 docs/ 并开启 GitHub Pages：

{
  "format": 1,
  "title": {"en": "Your Plugins", "zh": "你的插件"},
  "plugins": [ <把上面那段放进来> ]
}

注意：
- 索引必须直接返回 200，DSH 拒绝重定向。别用 raw.githubusercontent.com。
- 建议地址：https://$USER.github.io/$REPO/index.json
- jsDelivr 中转（仓库改版后需等缓存刷新）：
  https://cdn.jsdelivr.net/gh/$USER/$REPO@main/index.json
EOF
