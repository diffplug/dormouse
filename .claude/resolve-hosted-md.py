# Take the replayed commit's side of each hosted.md conflict, then restore
# #867's relay-smoke clause on the production deploy-order sentence.
import re, sys
p='docs/specs/hosted.md'
s=open(p).read()
s=re.sub(r"<<<<<<< [^\n]*\n(.*?)(?:\|\|\|\|\|\|\| [^\n]*\n.*?)?=======\n(.*?)>>>>>>> [^\n]*\n", lambda m: m.group(2), s, flags=re.S)
clause="Deploy relay, voice, then account, stopping at a failure; the relay must pass its revision check, push config, and `oneTimeSmoke` before the next deploy (rationale)."
s=s.replace("Deploy relay, voice, then account, stopping at a failure (rationale).", clause)
if clause not in s: sys.exit("clause anchor not found")
open(p,'w').write(s)
