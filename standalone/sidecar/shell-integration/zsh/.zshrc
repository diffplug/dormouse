# Dormouse zsh shell integration — interactive rc (.zshrc).
#
# Hands ZDOTDIR back to the user, sources their real .zshrc, then installs the
# OSC 633 prompt/command hooks. We restore ZDOTDIR *before* running the user's rc
# so that anything zsh writes relative to ZDOTDIR — .zcompdump, .zsh_history —
# lands in the user's directory, not ours (which is read-only when shipped). It
# also means login shells read $USER_ZDOTDIR/.zlogin next (the user's, directly)
# and child shells behave normally, so this directory needs no .zlogin of its own.

: ${USER_ZDOTDIR:=$HOME}
ZDOTDIR=${USER_ZDOTDIR}
if [[ -f ${USER_ZDOTDIR}/.zshrc ]]; then
  builtin source ${USER_ZDOTDIR}/.zshrc
fi

# Guard against a re-sourced .zshrc installing the hooks twice.
if [[ -z ${DORMOUSE_SHELL_INTEGRATION} ]]; then
  DORMOUSE_SHELL_INTEGRATION=1

  autoload -Uz add-zsh-hook

  # Escape a value for OSC 633 transport. The parser splits the E command field
  # on the first raw ';' then decodes \\ and \xNN, so backslash and semicolon
  # must be escaped; newlines/CR are escaped to keep the sequence single-line.
  __dormouse_633_escape() {
    local value=$1
    value=${value//\\/\\\\}
    value=${value//;/\\x3b}
    value=${value//$'\n'/\\x0a}
    value=${value//$'\r'/\\x0d}
    builtin print -rn -- "$value"
  }

  # First precmd has no preceding command, so it must not emit a D (finished).
  __dormouse_633_first_prompt=1

  # preexec: the user submitted a command line. Report it (E) and mark the start
  # of command output (C).
  __dormouse_633_preexec() {
    builtin printf '\e]633;E;%s\a' "$(__dormouse_633_escape "$1")"
    builtin printf '\e]633;C\a'
  }

  # precmd: a command just finished (D, with its exit code) and a new prompt is
  # about to render. Emit cwd (P) and the prompt-start marker (A). Emitting A
  # here rather than from PS1 keeps it working under prompt frameworks that
  # rebuild PS1 on every prompt.
  __dormouse_633_precmd() {
    local exit_code=$?
    if [[ -z ${__dormouse_633_first_prompt} ]]; then
      builtin printf '\e]633;D;%s\a' "$exit_code"
    fi
    __dormouse_633_first_prompt=
    builtin printf '\e]633;P;Cwd=%s\a' "$PWD"
    builtin printf '\e]633;A\a'
  }

  add-zsh-hook preexec __dormouse_633_preexec
  add-zsh-hook precmd __dormouse_633_precmd
  # Our precmd must run before any user precmd hook (e.g. oh-my-zsh), otherwise
  # $? would be the previous hook's status instead of the command's exit code.
  precmd_functions=(__dormouse_633_precmd ${precmd_functions:#__dormouse_633_precmd})

  # Mark prompt end / input start (B) at the tail of the prompt. Wrapped in %{%}
  # so zsh counts it as zero width. Best-effort: a prompt that fully rebuilds PS1
  # without re-running this loses B, but A/C/D/E/P still come from the hooks.
  PS1="${PS1}%{"$'\e]633;B\a'"%}"
fi
