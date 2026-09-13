const ACCEPT = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);
const MAX_INPUT = 8 * 1024 * 1024;
const MAX_OUTPUT = 48 * 1024;

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read this image.")); };
    img.src = url;
  });
}

function toJpeg(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => { if (!blob) reject(new Error("Could not compress this image.")); else resolve(blob); }, "image/jpeg", quality);
  });
}

async function jpegDataUrl(canvas: HTMLCanvasElement) {
  let quality = 0.72;
  let blob = await toJpeg(canvas, quality);
  while (blob.size > MAX_OUTPUT && quality > 0.32) {
    quality -= 0.08;
    blob = await toJpeg(canvas, quality);
  }
  if (blob.size > MAX_OUTPUT) throw new Error("Image is still too large after compression.");
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the compressed image."));
    reader.readAsDataURL(blob);
  });
}

function prepare(file: File) {
  if (!ACCEPT.has(file.type)) throw new Error("Use a JPEG, PNG, WebP, or GIF.");
  if (file.size > MAX_INPUT) throw new Error("Image must be under 8MB.");
}

export async function compressAvatarFile(file: File) {
  prepare(file);
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (side < 32) throw new Error("Photo is too small.");
  const out = Math.min(384, side);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not compress this image.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out, out);
  ctx.drawImage(img, Math.floor((img.naturalWidth - side) / 2), Math.floor((img.naturalHeight - side) / 2), side, side, 0, 0, out, out);
  return jpegDataUrl(canvas);
}

export async function compressBannerFile(file: File) {
  prepare(file);
  const img = await loadImage(file);
  const scale = Math.min(1, 960 / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not compress this image.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return jpegDataUrl(canvas);
}
