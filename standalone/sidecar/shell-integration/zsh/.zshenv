# Dormouse zsh shell integration — bootstrap (.zshenv).
#
# Dormouse spawns zsh with ZDOTDIR pointed at this directory and USER_ZDOTDIR set
# to the user's real ZDOTDIR (or $HOME). zsh sources $ZDOTDIR/.zshenv first, then
# .zprofile/.zshrc/.zlogin from whatever ZDOTDIR holds at the time it reads each
# one. We keep ZDOTDIR pointed here through .zshenv/.zprofile/.zshrc so our files
# load, chaining to the user's real dotfiles, and only hand ZDOTDIR back to the
# user at the end of .zshrc (see that file for the handoff and why .zlogin then
# loads straight from the user's directory).

# Remember our own directory so we can re-pin after sourcing user files that may
# themselves reassign ZDOTDIR.
DORMOUSE_ZDOTDIR=${ZDOTDIR:-$HOME}
: ${USER_ZDOTDIR:=$HOME}

if [[ -f ${USER_ZDOTDIR}/.zshenv ]]; then
  builtin source ${USER_ZDOTDIR}/.zshenv
fi

# A user .zshenv that sets ZDOTDIR would otherwise divert zsh away from our
# .zprofile/.zshrc; re-pin so the rest of our startup still runs.
ZDOTDIR=${DORMOUSE_ZDOTDIR}
