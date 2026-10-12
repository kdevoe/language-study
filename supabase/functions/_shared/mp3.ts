// Clean up an MP3 made by joining several MP3 files end to end.
//
// Long podcasts are voiced in ~1,900-character requests and the returned MP3s
// are concatenated (supabase/functions/_shared/elevenlabs.ts). Each piece can
// carry an ID3 tag and a Xing/Info/VBRI header frame that states that piece's
// own length. Safari trusts the first one, so a 9-minute episode reported a
// ~5-minute duration: at that point the element considered itself finished
// (lock screen 5:11 / −0:00) while the decoder played on, and the player's
// highlight and clock froze. Dropping every tag and header frame leaves plain
// constant-bitrate frames, whose length the browser works out from the size.
//
// Mirrors src/services/mp3.ts (keep the two in sync). This copy cleans new
// episodes as they are rendered; the app's copy repairs ones already stored.

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES_V1 = [44100, 48000, 32000];

interface Frame {
  length: number;
  /** Offset of a Xing/Info tag inside the frame. */
  xingAt: number;
}

/** A Layer III frame header at `p`, or null. */
function frameAt(b: Uint8Array, p: number): Frame | null {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[p + 1] >> 3) & 3; // 0: 2.5, 2: 2, 3: 1
  const layer = (b[p + 1] >> 1) & 3; // 1: Layer III
  const bitrateIdx = b[p + 2] >> 4;
  const rateIdx = (b[p + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) return null;
  const v1 = version === 3;
  const bitrate = (v1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIdx] * 1000;
  const rate = SAMPLE_RATES_V1[rateIdx] / (v1 ? 1 : version === 2 ? 2 : 4);
  const padding = (b[p + 2] >> 1) & 1;
  const length = Math.floor(((v1 ? 144 : 72) * bitrate) / rate) + padding;
  const mono = b[p + 3] >> 6 === 3;
  const sideInfo = v1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  return { length, xingAt: p + 4 + sideInfo };
}

const tagAt = (b: Uint8Array, p: number, tag: string) =>
  p + tag.length <= b.length && [...tag].every((c, i) => b[p + i] === c.charCodeAt(0));

/** Size of an ID3v2 tag starting at `p` (header, body and optional footer). */
function id3v2Size(b: Uint8Array, p: number): number {
  if (p + 10 > b.length) return b.length - p;
  const size = ((b[p + 6] & 0x7f) << 21) | ((b[p + 7] & 0x7f) << 14) | ((b[p + 8] & 0x7f) << 7) | (b[p + 9] & 0x7f);
  return 10 + size + (b[p + 5] & 0x10 ? 10 : 0);
}

/**
 * The audio frames of `bytes` without ID3 tags or Xing/Info/VBRI header
 * frames. Returns the input unchanged when there is nothing to drop.
 */
export function cleanJoinedMp3(bytes: Uint8Array): Uint8Array {
  const keep: [number, number][] = [];
  let dropped = false;
  let p = 0;
  while (p < bytes.length) {
    if (tagAt(bytes, p, 'ID3')) {
      p += id3v2Size(bytes, p);
      dropped = true;
      continue;
    }
    if (tagAt(bytes, p, 'TAG') && p + 128 <= bytes.length && !frameAt(bytes, p)) {
      p += 128; // ID3v1, at the end of each joined piece
      dropped = true;
      continue;
    }
    const frame = frameAt(bytes, p);
    if (!frame || p + frame.length > bytes.length) {
      // Not a frame boundary (or a truncated last frame): skip a byte to resync.
      p += 1;
      dropped = true;
      continue;
    }
    const isHeader =
      tagAt(bytes, frame.xingAt, 'Xing') || tagAt(bytes, frame.xingAt, 'Info') || tagAt(bytes, p + 36, 'VBRI');
    if (isHeader) dropped = true;
    else if (keep.length && keep[keep.length - 1][1] === p) keep[keep.length - 1][1] = p + frame.length;
    else keep.push([p, p + frame.length]);
    p += frame.length;
  }
  if (!dropped) return bytes;
  const out = new Uint8Array(keep.reduce((n, [a, z]) => n + z - a, 0));
  let at = 0;
  for (const [a, z] of keep) {
    out.set(bytes.subarray(a, z), at);
    at += z - a;
  }
  return out;
}
