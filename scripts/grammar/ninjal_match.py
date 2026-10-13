# Match the JLPT checklist against NINJAL headwords.
import sys, json, csv, re, itertools
ninjal = json.load(open(sys.argv[1]))
rows = list(csv.DictReader(open(sys.argv[2]), delimiter='\t'))

def expand(p):
    """All spelled-out variants of a pattern, wildcards collapsed to '*'."""
    p = p.replace('～', '〜').replace('...', '…')
    p = re.sub(r'\[.*?\]|（.*?）', '', p)                       # sense labels
    p = p.replace('(+助詞)', '')
    alts = []
    # A trailing "(〜…)" that starts with 〜 is an alternative spelling: 〜とおりだ(〜どおりだ)
    m = re.match(r'^(.*?)\((〜.*)\)$', p)
    if m: alts = [m.group(1), m.group(2)]
    else: alts = [p]
    out = set()
    for a in alts:
        for part in a.split('・'):
            # optional groups: (は) (よ) (に) (して) …
            pieces = re.split(r'(\([^()]*\))', part)
            opts = [[x[1:-1], ''] if x.startswith('(') else [x] for x in pieces]
            for combo in itertools.product(*opts):
                s = ''.join(combo)
                s = re.sub(r'[…、\s]', '*', s).replace('〜', '*')
                s = re.sub(r'\*+', '*', s).strip('*')
                if not s: continue
                s = re.sub(r'\*?N$', '', s).strip('*')             # 〜べからざるN, 〜ってN
                out.add(s)
                # て-form vs stem spellings: 〜に対して ≈ 〜に対し, 〜に伴って ≈ 〜に伴い
                if s.endswith('して'): out.add(s[:-1])
                if s.endswith('って'): out.add(s[:-2] + 'い')
    return out

idx = {}
for i, e in enumerate(ninjal):
    for v in expand(e['pattern']):
        idx.setdefault(v, set()).add(i)

def core(v):  # loosen: drop final copula/particle so 〜おかげだ ≈ 〜おかげで
    return re.sub(r'(です|だ|で|に|は|も|を|が)$', '', v)
loose = {}
for v, ids in idx.items():
    loose.setdefault(core(v), set()).update(ids)

out = []
for r in rows:
    vs = expand(r['pattern'])
    hit = set().union(*(idx.get(v, set()) for v in vs))
    how = 'exact' if hit else ''
    if not hit:
        hit = set().union(*(loose.get(core(v), set()) for v in vs))
        how = 'near' if hit else 'none'
    es = [ninjal[i] for i in sorted(hit)]
    senses = [s for e in es for s in e['senses']]
    out.append({**r,
        'match': how,
        'ninjal': ' / '.join(e['pattern'].replace('～', '〜') for e in es),
        'ninjal_levels': ','.join(sorted({str(s['level']) for s in senses})),
        'senses': ' | '.join(f"{s['level']}:{s['category'].split('｜')[-1]}" for s in senses),
        'connections': ' / '.join(sorted({c['type'] for s in senses for c in s['connections']})),
        'examples': sum(len(c['examples']) for s in senses for c in s['connections']),
    })
cols = list(out[0].keys())
w = csv.DictWriter(open(sys.argv[3], 'w'), fieldnames=cols, delimiter='\t'); w.writeheader(); w.writerows(out)

# Summary
import collections
print('match by level/kind:')
for k, n in sorted(collections.Counter((o['level'], o['kind'], o['match']) for o in out).items()): print(' ', k, n)
used = set()
for r in out:
    for v in expand(r['pattern']): used |= idx.get(v, set()) | loose.get(core(v), set())
print('ninjal entries matched:', len(used), 'of', len(ninjal))
json.dump(sorted(used), open(sys.argv[3] + '.used.json', 'w'))
