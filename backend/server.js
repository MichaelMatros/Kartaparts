// server.js (исправлённый)
// Требует Node >=18 (fetch в глобальной области), "type":"module" в package.json желательно.

import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import cors from 'cors';
import sharp from 'sharp';
import { pipeline } from '@xenova/transformers';
import cosineSimilarity from 'compute-cosine-similarity';
import crypto from 'crypto';
import 'dotenv/config';

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------- Настройки --------------------
const PARTS_FILE = path.join(__dirname, 'data', 'parts.json');
const EMB_FILE = path.join(__dirname, 'data', 'embeddings.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_IMAGES_DIR = path.join(__dirname, 'public', 'images');

if (!fs.existsSync(PUBLIC_IMAGES_DIR)) fs.mkdirSync(PUBLIC_IMAGES_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// -------------------- Данные --------------------
let parts = [];
let partsWithEmbeddings = [];

// -------------------- Чтение parts.json --------------------
try {
  const raw = fs.readFileSync(PARTS_FILE, 'utf8');
  parts = JSON.parse(raw);
  if (!Array.isArray(parts)) throw new Error('parts.json is not an array');
  console.log(`Loaded parts.json — items: ${parts.length}`);
} catch (e) {
  console.error('FATAL: не удалось прочитать/распарсить parts.json:', e.message);
  process.exit(1);
}

// -------------------- Express --------------------
const app = express();
const PORT = process.env.PORT || 5002;
app.use(cors());
app.use(express.json());

// logger
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.originalUrl);
  next();
});

// multer для загрузок
const upload = multer({ dest: UPLOADS_DIR });

// отдаём статику
app.use('/static', express.static(path.join(__dirname, 'public')));

// -------------------- Embedder (попытка ViT) --------------------
let embedder = null;
let useFallback = false;

async function initEmbedder() {
  if (embedder || useFallback) return;
  try {
    console.log('Инициализация локального embedder (google/vit-base-patch16-224) — начинается загрузка (если нужно)...');
    // Пытаемся инициализировать через xenova/transformers (скачет из HuggingFace при необходимости)
    embedder = await pipeline('feature-extraction', 'google/vit-base-patch16-224');
    console.log('✅ Локальный embedder инициализирован (ViT).');
  } catch (err) {
    console.warn('⚠️ Не удалось инициализировать ViT-embedder:', err?.message || err);
    console.warn('Будет использован Fallback-embedder (простой дескриптор изображения).');
    embedder = null;
    useFallback = true;
  }
}

// Fallback: простой эмбеддинг — grayscale downsample (гарантированно работает оффлайн)
async function fallbackEmbedding(filePath, size = 64, outDims = 256) {
  // resize to size x size, greyscale, get raw buffer
  const img = await sharp(filePath).resize(size, size, { fit: 'cover' }).removeAlpha().greyscale().raw().toBuffer();
  // img is Uint8Array length = size*size
  const floats = Float32Array.from(img).map(v => v / 255.0); // normalize 0..1

  // reduce to outDims by simple averaging blocks
  const block = Math.floor(floats.length / outDims) || 1;
  const emb = new Array(outDims).fill(0);
  for (let i = 0; i < floats.length; i++) {
    const idx = Math.floor(i / block);
    if (idx < outDims) emb[idx] += floats[i];
  }
  // normalize
  for (let i = 0; i < emb.length; i++) emb[i] = emb[i] / block;
  return emb;
}

// Возвращает массив чисел (embedding)
async function getImageEmbedding(filePath) {
  // проверка существования файла
  if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);

  // инициализируем embedder при первом обращении
  await initEmbedder();

  if (embedder) {
    try {
      // xenova pipeline: можно передавать путь к файлу
      const output = await embedder(filePath);
      // output может быть [1, dim] или просто [dim]
      // приводим к плоскому массиву
      const emb = Array.isArray(output) && Array.isArray(output[0]) ? output[0] : Array.isArray(output) ? output : [];
      return emb.map(x => Number(x)); // ensure numbers
    } catch (err) {
      console.warn('Ошибка при получении эмбеддинга от ViT для', filePath, err?.message || err);
      // падаем в fallback
      useFallback = true;
      return fallbackEmbedding(filePath);
    }
  } else {
    // fallback
    return fallbackEmbedding(filePath);
  }
}

// -------------------- Утилита: скачать внешний URL в локальную папку --------------------
async function downloadRemoteImage(url) {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname) || '.jpg';
    const hash = crypto.createHash('md5').update(url).digest('hex');
    const filename = `remote-${hash}${ext}`;
    const dest = path.join(PUBLIC_IMAGES_DIR, filename);

    // если уже скачан — возвращаем путь
    if (fs.existsSync(dest)) return dest;

    console.log(`Скачиваем удалённую картинку ${url} -> ${dest}`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`http ${resp.status}`);

    const arrayBuffer = await resp.arrayBuffer();
    fs.writeFileSync(dest, Buffer.from(arrayBuffer));
    return dest;
  } catch (err) {
    console.warn('Не удалось скачать изображение', url, err?.message || err);
    return null;
  }
}

// -------------------- Генерация эмбеддингов --------------------
async function buildEmbeddingsIfNeeded() {
  if (partsWithEmbeddings && partsWithEmbeddings.length) {
    console.log('Эмбеддинги уже есть — пропускаем генерацию.');
    return;
  }

  console.log('🔹 Генерация локальных эмбеддингов для parts.json...');
  const results = [];

  for (const p of parts) {
    // подготовка списка картинок (приоритет: images array, иначе image)
    const imgs = Array.isArray(p.images) && p.images.length ? p.images : p.image ? [p.image] : [];
    if (!imgs.length) continue;

    for (let img of imgs) {
      try {
        let imagePath;
        if (img.startsWith('http://') || img.startsWith('https://')) {
          // скачиваем внешнюю картинку локально
          const downloaded = await downloadRemoteImage(img);
          if (!downloaded) {
            console.log('ℹ️ не удалось скачать внешнюю картинку, пропускаем:', img);
            continue;
          }
          imagePath = downloaded;
          // сохраним относительный путь в p.image? (не меняем оригинальные данные, только для эмбеддинга)
        } else {
          // локальный путь относительно /public
          imagePath = path.join(__dirname, 'public', img);
        }

        // лог проверки
        console.log('Проверяем файл:', imagePath, 'exists=', fs.existsSync(imagePath));
        if (!fs.existsSync(imagePath)) {
          console.log('ℹ️ image file not found:', imagePath);
          continue;
        }

        // генерация эмбеддинга
        const embedding = await getImageEmbedding(imagePath);
        if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
          console.warn('⚠️ Пустой эмбеддинг для', p.name || p.id, img);
          continue;
        }

        results.push({ ...p, image: img, embedding });
        console.log('✅ эмбеддинг для', p.name || p.id, img, 'dim=', embedding.length);
      } catch (err) {
        console.warn('⚠️ Ошибка при эмбеддинге для', p.name || p.id, err?.message || err);
      }
    }
  }

  partsWithEmbeddings = results;

  try {
    fs.writeFileSync(EMB_FILE, JSON.stringify(partsWithEmbeddings, null, 2), 'utf8');
    console.log(`Сохранены эмбеддинги в ${EMB_FILE}`);
  } catch (e) {
    console.warn('Не удалось сохранить embeddings.json:', e?.message || e);
  }

  console.log(`Готово. Эмбеддингов: ${partsWithEmbeddings.length}`);
}

// -------------------- API: поиск по изображению --------------------
app.post(['/search-image', '/api/search-by-image'], upload.single('image') , async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Нет загруженного файла' });

    // убеждаемся, что эмбеддинги подготовлены
    if (!partsWithEmbeddings.length) {
      try {
        await buildEmbeddingsIfNeeded();
      } catch (e) {
        console.warn('buildEmbeddingsIfNeeded failed:', e?.message || e);
      }
    }

    // получаем эмбеддинг пользователя
    let userEmb = null;
    try {
      userEmb = await getImageEmbedding(req.file.path);
    } catch (e) {
      console.warn('Не удалось получить эмбеддинг для загруженного фото:', e?.message || e);
    } finally {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
    }

    if (!userEmb || !partsWithEmbeddings.length) {
      console.log('Возвращаем демо-результаты (no embeddings).');
      return res.json({ results: parts.slice(0, 6), warning: 'Эмбеддинги не доступны — возвращены демонстрационные результаты.' });
    }

    const scored = partsWithEmbeddings
      .map(p => ({ ...p, score: cosineSimilarity(userEmb, p.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    return res.json({ results: scored });
  } catch (err) {
    console.error('/api/search-by-image error:', err);
    return res.status(500).json({ error: 'Ошибка при обработке изображения' });
  }
});

// ========== Другие эндпоинты ==========
// root
app.get('/', (req, res) => {
  res.send('<html><body><h2>Mock server OK</h2><p>use /api/parts and /api/vin/:vin and POST /api/search-by-image</p></body></html>');
});

// GET /api/parts?q=...
app.get('/api/parts', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ parts });

  const filtered = parts.filter(p =>
    (p.name && p.name.toLowerCase().includes(q)) ||
    (p.brand && p.brand.toLowerCase().includes(q)) ||
    (p.oem && p.oem.toLowerCase().includes(q))
  );
  return res.json({ parts: filtered });
});

// GET /api/vin/:vin
app.get('/api/vin/:vin', (req, res) => {
  const vin = (req.params.vin || '').trim().toUpperCase();
  if (!vin) return res.status(400).json({ error: 'VIN required' });

  if (vin.length !== 17) {
    const q = vin.toLowerCase();
    const filtered = parts.filter(p =>
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.brand && p.brand.toLowerCase().includes(q)) ||
      (p.oem && p.oem.toLowerCase().includes(q))
    );
    return res.json({ vin, parts: filtered });
  }

  let sum = 0;
  for (let i = 0; i < vin.length; i++) sum = (sum * 31 + vin.charCodeAt(i)) >>> 0;
  const start = parts.length ? sum % parts.length : 0;
  const result = [];
  for (let i = 0; i < Math.min(12, parts.length); i++) result.push(parts[(start + i) % parts.length]);
  return res.json({ vin, parts: result });
});

// GET /api/parts/:id
app.get('/api/parts/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const p = parts.find(x => Number(x.id) === id);
  if (!p) return res.status(404).json({ error: 'Part not found' });
  return res.json({ part: p });
});

// single app.listen
app.listen(PORT, async () => {
  console.log(`Server started on http://localhost:${PORT}`);
  await buildEmbeddingsIfNeeded();
});
