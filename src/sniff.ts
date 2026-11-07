export const HEAD_BYTES = 1024;

export type Container = "mp4" | "mov" | "webm" | "mkv";

const ISO_BOXES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"]);

// ISO files that hold a picture or only sound, which clipsdk can't clip
const NOT_VIDEO_BRANDS = new Set(["avif", "avis", "heic", "heix", "heim", "heis", "mif1", "msf1", "M4A ", "M4B "]);

// We recognise a file by its first bytes, never by its name: clipsdk takes MP4, MOV, WebM and MKV
export function videoContainer(head: Buffer, fileSize: number): Container | undefined {
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return head.subarray(0, 64).includes("webm") ? "webm" : "mkv";
  if (!isIsoMedia(head, fileSize)) return undefined;

  if (head.toString("latin1", 4, 8) !== "ftyp") return "mov";
  const brand = head.toString("latin1", 8, 12);
  if (NOT_VIDEO_BRANDS.has(brand)) return undefined;
  return brand === "qt  " ? "mov" : "mp4";
}

// MP4 and MOV open with a box whose size fits in the file
function isIsoMedia(head: Buffer, fileSize: number): boolean {
  if (head.length < 8 || !ISO_BOXES.has(head.toString("latin1", 4, 8))) return false;

  const boxSize = head.readUInt32BE(0);
  return boxSize <= 1 || (boxSize >= 8 && boxSize <= fileSize);
}
