const fs = require('fs');

const csv = fs.readFileSync('reference_files/heisig-kanjis.csv', 'utf8').split('\n');
const lines = csv.slice(1);
const map = {};

lines.forEach(l => {
  const parts = l.split(',');
  if(parts.length >= 5) {
    const kanji = parts[0];
    const keyword = parts[4];
    map[kanji] = keyword;
  }
});

const tsFile = fs.readFileSync('src/data/rtkKanji.ts', 'utf8');
const match = tsFile.match(/export const rtkKanjiList(.*?)=\s*\[(.*?)\];/s);

if (match) {
  const kanjiRaw = match[2];
  const kanjis = kanjiRaw.replace(/['\s\n\r]/g, '').split(',').filter(x => x);
  
  let out = `export const rtkKanjiList: string[] = [\n  `;
  out += kanjis.map(k => `'${k}'`).join(', ') + `\n];\n\n`;
  
  out += `export const rtkKanjiMap: Record<string, string> = {\n`;
  kanjis.forEach(k => {
    let keyword = map[k] || '';
    out += `  '${k}': '${keyword.replace(/'/g, "\\'")}',\n`;
  });
  out += `};\n`;

  fs.writeFileSync('src/data/rtkKanji.ts', out);
  console.log('Successfully updated src/data/rtkKanji.ts');
} else {
  console.log('Could not find rtkKanjiList match in file.');
}
