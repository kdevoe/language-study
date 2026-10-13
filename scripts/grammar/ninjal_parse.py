# Parse the NINJAL 日本語文型データベース zip into one JSON list. Reads in memory; extracts nothing.
import sys, zipfile, json, re
import xml.etree.ElementTree as ET
RUBY = re.compile(r'〓([^〔]*)〔[^〕]*〕')
plain = lambda s: RUBY.sub(r'\1', (s or '').strip())
out = []
z = zipfile.ZipFile(sys.argv[1])
for info in z.infolist():
    root = ET.fromstring(z.read(info))
    senses = []
    for s in root.findall('Sense'):
        conns = []
        for c in s.findall('Connection'):
            exs = [plain(e.findtext('Example')) for e in c.findall('ExampleSet')]
            conns.append({'type': plain(c.findtext('ConnectionType')), 'examples': [e for e in exs if e]})
        senses.append({
            'category': plain(s.findtext('SenceCategory')),
            'level': int(s.findtext('Level') or 0),
            'usage': plain(s.findtext('Usage')),
            'orthography': plain(s.findtext('Orthography')),
            'alt': plain(s.findtext('AlternativeForm')),
            'style': plain(s.findtext('Style')),
            'similar': plain(s.findtext('SimilarExpressions')),
            'connections': conns,
        })
    out.append({'pattern': plain(root.findtext('SentencePattern')), 'reading': plain(root.findtext('Reading')), 'senses': senses})
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
print(len(out), 'entries')
