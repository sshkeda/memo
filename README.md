# Memo

Your agent forgets. Memo doesn't.

Memo is a CLI that keeps append-only logs you and your AI agents can search later.

An agent forgets everything when its conversation ends. With Memo, it writes what it learned to a log and finds it again in the next conversation. Memo never edits or deletes an entry, so a log stays a true record of what was written and when.

```
$ memo append "Deploys need the staging key from 1Password, not .env" --log work
Appended work #1.

$ memo search "staging key"
work #1  2026-10-21 23:40
  Deploys need the staging key from 1Password, not .env
```

Tell your agent to use `memo` and which log to write to. It needs no skill or plugin.

Memo is built with [Task](https://github.com/sshkeda/task) and [Check](https://github.com/sshkeda/check).

## Commands

```
memo append CONTENT --log LOG   Save content as a new entry in a log
memo search [QUERY]             Search every log, newest entries first
memo read [LOG] [ID...]         List your logs, or show a log's entries
memo check CONTENT --log LOG    Run a log's hook on content without saving it
```

`memo <command> --help` lists each command's flags.

## Get started

Memo needs Bun 1.4.4 or newer.

Run these commands:

```bash
git clone https://github.com/sshkeda/memo && cd memo
bun install --frozen-lockfile
bun scripts/build.ts
bun link
```

That builds one executable at `dist/memo` and links it into Bun's bin folder. If `memo` isn't found, add Bun's bin folder to your PATH.

## Hooks

A log can have one hook, which is a command that accepts or rejects each entry before Memo saves it. To add one, create `config.json` in the log's folder, which `memo read <log>` names, and give the command as a list of words:

```json
{ "hook": ["bun", "/absolute/path/to/check.ts"] }
```

The first word is a program on your PATH or an absolute path. Memo runs the command without a shell, passes the entry on stdin and the log's name in `MEMO_LOG`, and saves the entry only if the command exits 0. The command writes its reason for a rejection to stderr. If the command doesn't exit within 1 minute, Memo stops it, doesn't save the entry, and reports that the hook didn't finish in time. On macOS and Linux, once the command finishes, Memo also stops the processes it started, except any that break away on their own.

To use shell syntax, run a shell yourself. This hook rejects any entry that contains `TODO` and says why:

```json
{ "hook": ["sh", "-c", "if grep -q TODO; then echo 'the entry has a TODO' >&2; exit 1; fi"] }
```

`memo read <log>` shows how many entries the log has, its folder and its hook, and `memo check <content> --log <log>` runs the hook on content without saving it.

## Where logs live

Each log has its own folder under `logs` in Memo's data folder, holding the log's SQLite database, and its `config.json` if you added a hook. SQLite also keeps `-wal` and `-shm` files next to the database. The folder is:

- `~/Library/Application Support/Memo` on macOS
- `$XDG_DATA_HOME/memo` on Linux, or `~/.local/share/memo` otherwise
- `%LOCALAPPDATA%\Memo` on Windows

Set `MEMO_HOME` to an absolute path to use another folder.

## Development

To run the checks and tests, run `bun scripts/ci.ts`.

[MIT](LICENSE)
