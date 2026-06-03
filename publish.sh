#!/usr/bin/env bash
set -euo pipefail

# ── 配置 ──────────────────────────────────────────────
SCOPE="@d3ara1n"
REGISTRY="https://registry.npmjs.org"

# ── 颜色 ──────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

info()  { echo -e "${GREEN}✓${RESET} $*"; }
warn()  { echo -e "${YELLOW}⚠${RESET} $*"; }
err()   { echo -e "${RED}✗${RESET} $*"; exit 1; }

# ── 参数 ──────────────────────────────────────────────
PKG="${1:-}"
BUMP="${2:-patch}"  # patch | minor | major

if [[ -z "$PKG" ]]; then
    echo "Usage: ./publish.sh <package-name> [patch|minor|major]"
    echo ""
    echo "Available packages:"
    ls -d packages/*/ 2>/dev/null | sed 's|packages/||;s|/||' | prefix="  "
    exit 1
fi

PKG_DIR="packages/$PKG"
[[ -d "$PKG_DIR" ]] || err "Package not found: $PKG_DIR"

PKG_JSON="$PKG_DIR/package.json"
FULL_NAME=$(node -e "console.log(require('./$PKG_JSON').name)")
[[ -z "$FULL_NAME" ]] && err "Cannot read package name from $PKG_JSON"

echo ""
echo -e "${DIM}────────────────────────────────────────${RESET}"
echo -e "  ${FULL_NAME}"
echo -e "${DIM}────────────────────────────────────────────────${RESET}"
echo ""

# ── 1. 检查 npm 已发布版本 ─────────────────────────────
REMOTE_VERSION=$(npm view "$FULL_NAME" version 2>/dev/null || echo "0.0.0")
LOCAL_VERSION=$(node -e "console.log(require('./$PKG_JSON').version)")

echo -e "  Remote: ${REMOTE_VERSION}"
echo -e "  Local:  ${LOCAL_VERSION}"
echo ""

# ── 2. 确定目标版本 ────────────────────────────────────
if [[ "$REMOTE_VERSION" == "0.0.0" ]]; then
    # 从未发布过，使用本地版本
    TARGET_VERSION="$LOCAL_VERSION"
    info "First publish, using local version ${TARGET_VERSION}"
else
    # 已发布过，比较版本
    HIGHER=$(node -e "
        const r = '${REMOTE_VERSION}'.split('.').map(Number);
        const l = '${LOCAL_VERSION}'.split('.').map(Number);
        console.log(l[0] > r[0] || l[1] > r[1] || l[2] > r[2] ? 'local' : 'remote');
    ")

    if [[ "$HIGHER" == "local" ]]; then
        TARGET_VERSION="$LOCAL_VERSION"
        info "Local version is higher, publishing as-is: ${TARGET_VERSION}"
    else
        # 自动 bump
        TARGET_VERSION=$(node -e "
            const semver = require('semver');
            console.log(semver.inc('${REMOTE_VERSION}', '${BUMP}'));
        " 2>/dev/null || node -e "
            // Fallback: simple bump without semver dep
            const [major, minor, patch] = '${REMOTE_VERSION}'.split('.').map(Number);
            '${BUMP}' === 'major' ? console.log(major+1+'.0.0')
          : '${BUMP}' === 'minor' ? console.log(major+'.'+(minor+1)+'.0')
          : console.log(major+'.'+minor+'.'+(patch+1));
        ")
        info "Auto-bumping (${BUMP}): ${REMOTE_VERSION} → ${TARGET_VERSION}"
    fi
fi

# ── 3. 确认 ────────────────────────────────────────────
echo ""
read -rp "  Publish ${FULL_NAME}@${TARGET_VERSION}? [Y/n] " CONFIRM
[[ "${CONFIRM,,}" == "n" ]] && { warn "Cancelled"; exit 0; }

# ── 4. 更新 version ────────────────────────────────────
npm version "$TARGET_VERSION" --no-git-tag-version -w "$PKG_DIR" 2>/dev/null || \
    node -e "
        const fs = require('fs');
        const p = '$PKG_JSON';
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        pkg.version = '${TARGET_VERSION}';
        fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
    "
info "Version set to ${TARGET_VERSION}"

# ── 5. Git commit + tag + push ─────────────────────────
TAG="${FULL_NAME}@${TARGET_VERSION}"
git add "$PKG_JSON"
git commit -m "release: ${TAG}" || true
git tag "$TAG"
info "Git tag: ${TAG}"

git push
git push --tags
info "Git pushed"

# ── 6. npm publish ─────────────────────────────────────
npm publish -w "$PKG_DIR" --access public
info "Published to npm: ${TAG}"

echo ""
info "Done! 🚀"
echo ""
echo -e "  Install: ${DIM}pi install npm:${FULL_NAME}${RESET}"
