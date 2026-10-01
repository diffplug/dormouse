import re
p='scripts/spec-word-budgets.json'
s=open(p).read()
def merge(m):
    vals, order = {}, []
    for block in (m.group(1), m.group(2)):
        for k, v in re.findall(r'"([^"]+)":\s*(\d+)', block):
            if k not in vals: order.append(k)
            vals[k] = max(vals.get(k, 0), int(v))
    return ''.join(f'  "{k}": {vals[k]},\n' for k in order)
s = re.sub(r"<<<<<<< [^\n]*\n(.*?)(?:\|\|\|\|\|\|\| [^\n]*\n.*?)?=======\n(.*?)>>>>>>> [^\n]*\n", merge, s, flags=re.S)
open(p,'w').write(s)
