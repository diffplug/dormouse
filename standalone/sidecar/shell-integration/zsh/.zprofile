# Dormouse zsh shell integration — login profile (.zprofile).
# Only read for login shells; chain to the user's with ZDOTDIR at their
# directory (following any ZDOTDIR it sets, as .zshenv does), then re-pin
# ZDOTDIR to ours so our .zshrc still loads.
: ${USER_ZDOTDIR:=$HOME}
ZDOTDIR=${USER_ZDOTDIR}
if [[ -f ${USER_ZDOTDIR}/.zprofile ]]; then
  builtin source ${USER_ZDOTDIR}/.zprofile
fi
USER_ZDOTDIR=${ZDOTDIR:-$HOME}
ZDOTDIR=${DORMOUSE_ZDOTDIR}
