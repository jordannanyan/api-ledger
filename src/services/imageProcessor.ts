import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

export interface CompressOptions {
  /** Max width in pixels. Default 1600. */
  maxWidth?: number;
  /** Max height in pixels. Default 1600. */
  maxHeight?: number;
  /** JPEG quality 1-100. Default 80. */
  quality?: number;
  /** Skip if file already smaller than this byte count. Default 200 KB. */
  skipBelowBytes?: number;
}

const DEFAULTS: Required<CompressOptions> = {
  maxWidth: 1600,
  maxHeight: 1600,
  quality: 80,
  skipBelowBytes: 200 * 1024,
};

/**
 * Compress an image in-place: auto-rotate (EXIF), resize-to-fit, re-encode as JPEG.
 * Non-image or invalid files are left untouched; never throws.
 *
 * The original file is OVERWRITTEN. For very small files, the operation is skipped
 * to avoid re-encoding tiny images and losing quality.
 */
export async function compressImage(filePath: string, opts: CompressOptions = {}): Promise<void> {
  const cfg = { ...DEFAULTS, ...opts };

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return;

    let meta;
    try {
      meta = await sharp(filePath).metadata();
    } catch {
      return; // not a valid image — leave as-is (could be PDF, etc.)
    }
    if (!meta.width || !meta.height) return;

    // Skip if already within bounds AND small file size
    const withinSize = meta.width <= cfg.maxWidth && meta.height <= cfg.maxHeight;
    if (withinSize && stat.size <= cfg.skipBelowBytes) return;

    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const tmp = path.join(dir, `.compress-${process.pid}-${Date.now()}${ext}`);

    await sharp(filePath)
      .rotate() // honor EXIF orientation, then strip it
      .resize(cfg.maxWidth, cfg.maxHeight, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: cfg.quality, mozjpeg: true })
      .toFile(tmp);

    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Best-effort: log but don't break the upload flow.
    console.warn('[imageProcessor] failed for', filePath, '-', (err as Error).message);
  }
}

/** Compress multiple files in parallel. Safe to call with mixed image/non-image paths. */
export async function compressImages(filePaths: (string | undefined | null)[], opts?: CompressOptions): Promise<void> {
  const paths = filePaths.filter((p): p is string => !!p);
  await Promise.all(paths.map((p) => compressImage(p, opts)));
}
