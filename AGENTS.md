# Pi Extensions Monorepo

## Commit 规范

所有 commit 必须使用 Conventional Commits 格式：

```
<type>(<scope>): <description>
```

- **type**: `feat` | `fix` | `chore` | `docs` | `refactor` | `style` | `test`
- **scope**: 包目录名，如 `context-include`
- 破坏性变更加 `!` 后缀：`feat(context-include)!: 改了配置格式`

### 示例

```
feat(context-include): 支持嵌套 @ 引用
fix(context-include): 修复 ~ 路径展开在 Windows 上的问题
chore: 更新依赖
docs(context-include): 补充 README
```

### 版本发布

push 到 main 后 GitHub Actions 自动发布，规则：
- `feat` → minor
- `fix` → patch
- `!` 或 `BREAKING CHANGE` → major
- 其他类型不触发发布
