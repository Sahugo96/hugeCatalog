'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { UPLOAD_DIR } = require('./db');

const TMP_DIR = path.join(UPLOAD_DIR, '.tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

const storage = multer.diskStorage({
  destination: TMP_DIR,
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
});

function fileFilter(req, file, cb) {
  if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
  const err = new Error(`Файл «${file.originalname}» не является изображением (jpg, png, webp, gif, avif).`);
  err.status = 400;
  cb(err);
}

const coverUpload = multer({ storage, fileFilter, limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const pagesUpload = multer({ storage, fileFilter, limits: { fileSize: 20 * 1024 * 1024, files: 500 } });

/** Определяет расширение по сигнатуре файла. null — если это не картинка. */
function detectImageExt(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /avi[fs]/.test(buf.toString('ascii', 8, 12))) return 'avif';
  return null;
}

/**
 * Перемещает загруженный файл в uploads/<subdir>/ и возвращает публичный путь (/uploads/...).
 * Бросает ошибку, если содержимое не является изображением.
 */
function storeImage(file, subdir, baseName) {
  const ext = detectImageExt(file.path);
  if (!ext) {
    safeUnlink(file.path);
    const err = new Error(`Файл «${file.originalname}» повреждён или не является изображением.`);
    err.status = 400;
    throw err;
  }
  const dir = path.join(UPLOAD_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${baseName || crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.renameSync(file.path, path.join(dir, name));
  require('./webp').afterUpload(path.join(dir, name)); // WebP-копия в фоне
  return `/uploads/${subdir}/${name}`;
}

function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/** Копирует уже загруженное изображение (например, обложку другой версии). */
function copyPublic(publicPath, subdir) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return null;
  const src = path.join(UPLOAD_DIR, publicPath.slice('/uploads/'.length));
  if (!src.startsWith(UPLOAD_DIR) || !fs.existsSync(src)) return null;
  const dir = path.join(UPLOAD_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomBytes(8).toString('hex')}${path.extname(src)}`;
  fs.copyFileSync(src, path.join(dir, name));
  return `/uploads/${subdir}/${name}`;
}

/** Удаляет файл по публичному пути /uploads/... */
function removePublic(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return;
  const full = path.join(UPLOAD_DIR, publicPath.slice('/uploads/'.length));
  if (full.startsWith(UPLOAD_DIR)) {
    safeUnlink(full);
    safeUnlink(`${full}.webp`); // WebP-копия
    safeUnlink(`${full}.thumb.webp`); // миниатюра галереи
  }
}

function removeDir(subdir) {
  const full = path.join(UPLOAD_DIR, subdir);
  if (full.startsWith(UPLOAD_DIR) && full !== UPLOAD_DIR) fs.rmSync(full, { recursive: true, force: true });
}

/** Очистка временных файлов, если обработчик упал до их перемещения. */
function cleanupTmp(req) {
  const files = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) files.push(...req.files);
  else if (req.files) Object.values(req.files).forEach((arr) => files.push(...arr));
  files.forEach((f) => f.path && f.path.startsWith(TMP_DIR) && safeUnlink(f.path));
}

/** Естественная сортировка имён файлов: 2.jpg < 10.jpg */
const naturalCompare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

module.exports = { coverUpload, pagesUpload, storeImage, copyPublic, removePublic, removeDir, cleanupTmp, naturalCompare, detectImageExt };
