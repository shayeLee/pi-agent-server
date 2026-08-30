# 项目规则

## Git 提交权限

未经用户在当前对话中明确要求，禁止执行任何 git 提交操作，包括但不限于：

- `git commit`
- `git commit --amend`
- rebase、cherry-pick 等可能自动产生提交的操作

**允许的操作**：查看 `git status`、`git diff`、`git log`、`git stash list` 等只读命令。

提交前必须先获得用户明确授权。

## README 双语同步

任何 README 内容新增、修改或删除时，必须同步更新英文 `README.md` 和简体中文 `README.zh-CN.md`。两份必须在以下方面语义一致：功能状态、配置变量、命令、链接、限制和验收说明。提交或交付前应检查双语链接和内容是否同步。
