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

# The user's .zshenv runs with ZDOTDIR at their directory, as it would without
# us. Setting ZDOTDIR there is how a user moves the rest of their dotfiles (for
# example to ~/.config/zsh), so whatever it leaves becomes the directory we
# chain to from here on.
ZDOTDIR=${USER_ZDOTDIR}
if [[ -f ${USER_ZDOTDIR}/.zshenv ]]; then
  builtin source ${USER_ZDOTDIR}/.zshenv
fi
USER_ZDOTDIR=${ZDOTDIR:-$HOME}

# Re-pin so zsh still reads our .zprofile/.zshrc next.
ZDOTDIR=${DORMOUSE_ZDOTDIR}
