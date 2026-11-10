# Dormouse zsh shell integration — login profile (.zprofile).
# Only read for login shells; chain to the user's with ZDOTDIR as it would be
# without us (unset when it falls back to $HOME, as in .zshenv), following any
# ZDOTDIR it sets, then re-pin ZDOTDIR to ours so our .zshrc still loads.
: ${USER_ZDOTDIR:=$HOME}
if [[ ${USER_ZDOTDIR} == ${HOME} ]]; then unset ZDOTDIR; else ZDOTDIR=${USER_ZDOTDIR}; fi
if [[ -f ${USER_ZDOTDIR}/.zprofile ]]; then
  builtin source ${USER_ZDOTDIR}/.zprofile
fi
USER_ZDOTDIR=${ZDOTDIR:-$HOME}
ZDOTDIR=${DORMOUSE_ZDOTDIR}
