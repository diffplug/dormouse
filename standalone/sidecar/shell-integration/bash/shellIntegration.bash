# Dormouse bash shell integration (OSC 633).
#
# Delivered via `bash --init-file <this>`, which bash reads — in place of
# ~/.bashrc — for an interactive NON-login shell. Dormouse normally spawns bash
# as a login shell (-l) so the user's profile (PATH, Homebrew/asdf) loads, but
# --init-file and login mode are mutually exclusive, so when injecting Dormouse
# drops -l and this script replicates login-profile startup first, then installs
# the OSC 633 prompt/command hooks.
#
# Written for bash 3.2 (the macOS system bash) and newer: a DEBUG trap for
# command-start and a string PROMPT_COMMAND for the prompt — no PS0 (4.4+) and no
# array PROMPT_COMMAND (5.1+).

# --- Replicate login-shell startup (we are spawned without --login) ----------
if [ -r /etc/profile ]; then . /etc/profile; fi
for __dormouse_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -r "$__dormouse_profile" ]; then . "$__dormouse_profile"; break; fi
done
unset __dormouse_profile

# Only wire up hooks for an interactive shell, and only once.
case "$-" in *i*) ;; *) return 0 2>/dev/null || exit 0 ;; esac
if [ -n "${__dormouse_633_installed:-}" ]; then return 0 2>/dev/null || exit 0; fi
__dormouse_633_installed=1

# The three byte sequences that end an OSC string, and therefore the three that
# no field of ours may contain raw: BEL, ESC (which begins ST, "ESC \\"), and the
# C1 ST U+009C. The last is held as its UTF-8 bytes because that is how it
# reaches us from a filename, and because `[[:cntrl:]]` does not cover it under
# LC_ALL=C — verified, not assumed.
__dormouse_633_c1st=$'\302\234'

# Escape a value for the E command field, leaving the result in
# __dormouse_633_out. Backslash and semicolon are escaped because the parser
# splits on the first raw ';' then decodes \\ and \xNN; newlines/CR keep the
# sequence single-line; BEL/ESC/C1-ST are the OSC terminators. Escaping costs
# nothing here because the parser decodes \xNN back.
# Why terminators must not survive: docs/specs/terminal-escapes.md -> OSC 633.
#
# Out-param rather than a return value: the call site would otherwise need
# $(...), which forks a subshell on every command in the user's shell.
__dormouse_633_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//;/\\x3b}
  value=${value//$'\n'/\\x0a}
  value=${value//$'\r'/\\x0d}
  value=${value//$'\a'/\\x07}
  value=${value//$'\e'/\\x1b}
  value=${value//"$__dormouse_633_c1st"/\\x9c}
  __dormouse_633_out=$value
}

# Reduce a value for the `Cwd=` field into __dormouse_633_out. Unlike E, the
# parser reads Cwd= verbatim — no \xNN decoding, so a Windows path's backslashes
# arrive intact — which rules out escaping, so the terminators are removed
# instead. A path component may hold any byte but '/' and NUL, so a directory
# name can carry one; see docs/specs/terminal-escapes.md -> OSC 633.
#
# The C1 ST goes first and explicitly: under LC_ALL=C it is two ordinary bytes
# that [[:cntrl:]] does not match.
__dormouse_633_safe_cwd() {
  local value=$1
  value=${value//"$__dormouse_633_c1st"/}
  __dormouse_633_out=${value//[[:cntrl:]]/}
}

__dormouse_633_armed=                       # set at the END of the prompt hook: "the next command is the user's"
__dormouse_633_ran=                         # a command actually executed since the last prompt
__dormouse_633_user_pc="$PROMPT_COMMAND"    # preserve the user's PROMPT_COMMAND

# precmd: runs via PROMPT_COMMAND just before each prompt. Reports the previous
# command's exit (D), the cwd (P), and the prompt start (A). Disarms first so its
# own commands — and the user's PROMPT_COMMAND — don't trip the preexec trap, and
# re-arms last so the trap fires for the next interactive command.
__dormouse_633_prompt() {
  local exit_code=$?
  __dormouse_633_armed=
  if [ -n "$__dormouse_633_ran" ]; then printf '\033]633;D;%s\007' "$exit_code"; fi
  __dormouse_633_ran=
  __dormouse_633_safe_cwd "$PWD"
  printf '\033]633;P;Cwd=%s\007' "$__dormouse_633_out"
  printf '\033]633;A\007'
  if [ -n "$__dormouse_633_user_pc" ]; then
    ( exit "$exit_code" )                   # restore $? for the user's PROMPT_COMMAND
    eval "$__dormouse_633_user_pc"
  fi
  __dormouse_633_armed=1
}

# preexec: the DEBUG trap fires before every command; emit E/C once per line.
__dormouse_633_preexec() {
  [ "$BASH_COMMAND" = "__dormouse_633_prompt" ] && return   # the PROMPT_COMMAND invocation itself
  [ -z "$__dormouse_633_armed" ] && return                 # inside PROMPT_COMMAND, or already fired this line
  [ -n "${COMP_LINE:-}" ] && return                        # tab-completion, not a submitted command
  __dormouse_633_armed=
  __dormouse_633_ran=1
  __dormouse_633_escape "$BASH_COMMAND"
  printf '\033]633;E;%s\007' "$__dormouse_633_out"
  printf '\033]633;C\007'
}

trap '__dormouse_633_preexec' DEBUG
PROMPT_COMMAND='__dormouse_633_prompt'
# Prompt-end / input-start (B) at the tail of PS1, wrapped in \[ \] so bash counts
# it as zero width. Best-effort: a prompt rebuilt every render loses B, but
# A/C/D/E/P still come from the hooks.
PS1="${PS1}\[\033]633;B\007\]"
