# Dormouse zsh shell integration — bootstrap (.zshenv).
#
# Dormouse spawns zsh with ZDOTDIR pointed at this directory and USER_ZDOTDIR set
# to the user's real ZDOTDIR (or $HOME). zsh sources $ZDOTDIR/.zshenv first, then
# .zprofile/.zshrc/.zlogin from whatever ZDOTDIR holds at the time it reads each
# one. Between the user's files we keep ZDOTDIR pointed here so our files load,
# chaining to the user's real dotfiles, and only hand ZDOTDIR back to the user
# at the end of .zshrc (see that file for the handoff and why .zlogin then loads
# straight from the user's directory).

# Remember our own directory so we can re-pin after sourcing user files that may
# themselves reassign ZDOTDIR.
DORMOUSE_ZDOTDIR=${ZDOTDIR:-$HOME}
: ${USER_ZDOTDIR:=$HOME}

# The user's .zshenv runs with ZDOTDIR as it would be without us: unset when
# they had none (USER_ZDOTDIR fell back to $HOME), so a default such as
# `export ZDOTDIR=${ZDOTDIR:-$HOME/.config/zsh}` still applies. Setting ZDOTDIR
# there is how a user moves the rest of their dotfiles, so whatever it leaves
# becomes the directory we chain to from here on.
if [[ ${USER_ZDOTDIR} == ${HOME} ]]; then unset ZDOTDIR; else ZDOTDIR=${USER_ZDOTDIR}; fi
if [[ -f ${USER_ZDOTDIR}/.zshenv ]]; then
  builtin source ${USER_ZDOTDIR}/.zshenv
fi
USER_ZDOTDIR=${ZDOTDIR:-$HOME}

# Re-pin so zsh still reads our .zprofile/.zshrc next.
ZDOTDIR=${DORMOUSE_ZDOTDIR}

# A system startup file can run compinit before our .zshrc hands ZDOTDIR back
# (Debian and Ubuntu's /etc/zsh/zshrc does), and compinit dumps to
# ${ZDOTDIR:-$HOME}/.zcompdump: into this directory, which nothing may write
# (see .zshrc). Run it with the user's ZDOTDIR instead, so the dump lands where
# it would without us. compinit leaves itself an autoload stub when it is done;
# .zshrc removes this wrapper if nothing called it.
__dormouse_had_compinit=${+functions[compinit]}
compinit() {
  builtin unfunction compinit
  builtin autoload -Uz compinit
  if [[ ${ZDOTDIR} == "${DORMOUSE_ZDOTDIR}" ]]; then
    local ZDOTDIR=${USER_ZDOTDIR}
  fi
  compinit "$@"
}
