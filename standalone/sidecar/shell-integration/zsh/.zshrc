# Dormouse zsh shell integration — interactive rc (.zshrc).
#
# Hands ZDOTDIR back to the user, sources their real .zshrc, then installs the
# OSC 633 prompt/command hooks. We restore ZDOTDIR *before* running the user's rc
# so that anything zsh writes relative to ZDOTDIR — .zcompdump, .zsh_history —
# lands in the user's directory, not ours: when shipped, this directory lives
# inside the signed macOS app bundle, and any file written here breaks the
# bundle's code signature (Gatekeeper then refuses to launch the app as
# "damaged"). It also means login shells read $USER_ZDOTDIR/.zlogin next (the
# user's, directly) and child shells behave normally, so this directory needs
# no .zlogin of its own.

: ${USER_ZDOTDIR:=$HOME}
ZDOTDIR=${USER_ZDOTDIR}
if [[ -f ${USER_ZDOTDIR}/.zshrc ]]; then
  builtin source ${USER_ZDOTDIR}/.zshrc
fi

# macOS /etc/zshrc runs before this file — while ZDOTDIR still points at our
# directory — and sets HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history; a user
# .zshenv/.zprofile sourced during that window can do the same. Left alone, zsh
# would write history into the signed app bundle on shell exit (see above).
# Redirect it to what /etc/zshrc would have chosen without us. Runs after the
# user's rc so a HISTFILE they set themselves is never touched. The directory
# is quoted so that a user rc enabling GLOB_SUBST (e.g. sh/ksh emulation)
# can't turn an install path containing glob metacharacters into a pattern.
if [[ -n ${HISTFILE} && -n ${DORMOUSE_ZDOTDIR} && ${HISTFILE:A} == "${DORMOUSE_ZDOTDIR:A}"/* ]]; then
  HISTFILE=${USER_ZDOTDIR}/.zsh_history
fi

# Guard against a re-sourced .zshrc installing the hooks twice.
if [[ -z ${DORMOUSE_SHELL_INTEGRATION} ]]; then
  DORMOUSE_SHELL_INTEGRATION=1

  autoload -Uz add-zsh-hook

  # The three byte sequences that end an OSC string, and therefore the three no
  # field of ours may contain raw: BEL, ESC (which begins ST, "ESC \\"), and the
  # C1 ST U+009C. The last is held as its UTF-8 bytes because that is how it
  # reaches us from a filename, and because [[:cntrl:]] does not cover it under
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
  # parser reads Cwd= verbatim — no \xNN decoding, so a Windows path's
  # backslashes arrive intact — which rules out escaping, so the terminators are
  # removed instead. A path component may hold any byte but '/' and NUL, so a
  # directory name can carry one; see docs/specs/terminal-escapes.md -> OSC 633.
  #
  # The C1 ST goes first and explicitly: under LC_ALL=C it is two ordinary bytes
  # that [[:cntrl:]] does not match.
  __dormouse_633_safe_cwd() {
    local value=$1
    value=${value//"$__dormouse_633_c1st"/}
    __dormouse_633_out=${value//[[:cntrl:]]/}
  }

  # First precmd has no preceding command, so it must not emit a D (finished).
  __dormouse_633_first_prompt=1

  # preexec: the user submitted a command line. Report it (E) and mark the start
  # of command output (C).
  __dormouse_633_preexec() {
    __dormouse_633_escape "$1"
    builtin printf '\e]633;E;%s\a' "$__dormouse_633_out"
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
    __dormouse_633_safe_cwd "$PWD"
    builtin printf '\e]633;P;Cwd=%s\a' "$__dormouse_633_out"
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
