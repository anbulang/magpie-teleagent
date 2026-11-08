#!/usr/bin/env bash
# 在隔离的 HOME 里跑一遍 magpie 插件：不改你真实的 magpie 配置、不用你真实的
# TeleAgent 登录态（除非传 --real-home，用来验证登录与真实请求）。
#
# 用法：
#   bash magpie/scripts/sandbox.sh              # 隔离 HOME：只验证「未登录」分支
#   bash magpie/scripts/sandbox.sh --real-home  # 用真实 HOME：登录 + quota + 一次 provider test
#
# 说明：
#   - 端口固定 3499，避免和正在用的 magpie 撞车
#   - provider test 会发一次真实请求并消耗积分，所以只在 --real-home 时跑
#     （两次封号复盘给出的硬约束，见 README 第八节）
set -euo pipefail

REAL_HOME="${HOME}"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAGPIE_BIN="${MAGPIE_BIN:-/Applications/magpie.app/Contents/MacOS/magpie}"
USE_REAL_HOME=0

for arg in "$@"; do
  case "$arg" in
    --real-home) USE_REAL_HOME=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -x "$MAGPIE_BIN" ]]; then
  echo "找不到 magpie：$MAGPIE_BIN（用 MAGPIE_BIN=/path/to/magpie 指定）" >&2
  exit 1
fi

SB="$(mktemp -d)"
trap 'rm -rf "$SB"' EXIT

if [[ "$USE_REAL_HOME" == "1" ]]; then
  SANDBOX_HOME="$REAL_HOME"
  MODE="真实 HOME（会读你的 TeleAgent 登录态）"
else
  SANDBOX_HOME="$SB/home"
  mkdir -p "$SANDBOX_HOME"
  MODE="隔离 HOME（读不到真实登录态，验证失败分支）"
fi

m() {
  env HOME="$SANDBOX_HOME" \
      XDG_CONFIG_HOME="$SB/config" \
      XDG_CACHE_HOME="$SB/cache" \
      MAGPIE_ADDR=127.0.0.1:3499 \
      "$MAGPIE_BIN" "$@"
}

step() { printf '\n== %s ==\n' "$*"; }
quiet() { grep -v 'plugin: host starts' || true; }

echo "插件目录：$PLUGIN_DIR"
echo "运行模式：$MODE"

step "1/5 安装插件（本地目录，就地加载）"
m plugin add "$PLUGIN_DIR" 2>&1 | quiet

step "2/5 插件清单（不联网、不发模型请求）"
m plugin --json 2>/dev/null > "$SB/plugins.json"
python3 - "$SB/plugins.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for p in d.get("providers", []):
    models = [m["id"] for m in p.get("models", [])]
    rates = [m.get("rate") for m in p.get("models", [])]
    print("  %-10s %-10s models=%s" % (p["id"], p.get("name"), models))
    print("  %-10s %-10s rates=%s  signedIn=%s" % ("", "", rates, p.get("signedIn")))
for l in d.get("loaded", []):
    print("  loaded: %s -> %s" % (l.get("spec"), l.get("provides")))
PY

if [[ "$USE_REAL_HOME" == "1" ]]; then
  step "3/5 登录（读本机登录态；下拉框里选第一个账号）"
  printf '1\n' | m plugin login teleagent 2>&1 | quiet

  step "4/5 用量（只读 portal，不花积分、不发模型请求）"
  m quota 2>&1 | quiet | grep -i teleagent || echo "  （没有 teleagent 的用量行）"

  step "5/5 一次真实请求（只测 chat-flash，会消耗积分）"
  m provider test teleagent chat-flash 2>&1 | quiet
else
  step "3/5 登录（预期失败：隔离 HOME 里没有凭据）"
  if printf '1\n' | m plugin login teleagent 2>&1 | quiet; then
    echo "  ✗ 意外成功：隔离环境不该读得到真实凭据" >&2
    exit 1
  else
    echo "  ✓ 按预期失败（失败原因由插件给出）"
  fi

  step "4/5 usage（没有 cookie）"
  m quota 2>&1 | quiet || true

  step "5/5 跳过真实请求（隔离环境没有凭据）"
fi

step "完成"
echo "沙箱目录：${SB}（退出时自动删除）"
