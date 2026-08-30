# 项目规则

## Git 提交权限

未经用户在当前对话中明确要求，禁止执行任何 git 提交操作，包括但不限于：

- `git commit`
- `git commit --amend`
- rebase、cherry-pick 等可能自动产生提交的操作

**允许的操作**：查看 `git status`、`git diff`、`git log`、`git stash list` 等只读命令。

提交前必须先获得用户明确授权。
