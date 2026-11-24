import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendCacheVersionIfMutable,
  resolveResponsiveImage,
} from './responsiveImage';

test('resolveResponsiveImage resolves local product JPEGs to WebP srcset while preserving original fallbackSrc', () => {
  const resolved = resolveResponsiveImage(
    '/assets/images/watch_rose_gold_1794494079347.jpg'
  );
  assert.equal(
    resolved.fallbackSrc,
    '/assets/images/watch_rose_gold_1794494079347.jpg'
  );
  assert.equal(
    resolved.webpSrcSet,
    '/assets/opt/watch_rose_gold_1794494079347-480w.webp 480w, /assets/opt/watch_rose_gold_1794494079347-960w.webp 960w'
  );
  assert.equal(resolved.width, 1200);
  assert.equal(resolved.height, 896);
});

test('resolveResponsiveImage normalizes legacy /src/assets/images and /public/assets paths', () => {
  const fromSrc = resolveResponsiveImage(
    '/src/assets/images/men_collection_suit_1794494077378.jpg'
  );
  assert.equal(
    fromSrc.fallbackSrc,
    '/assets/images/men_collection_suit_1794494077378.jpg'
  );
  assert.match(fromSrc.webpSrcSet || '', /men_collection_suit_1794494077378-480w\.webp 480w/);

  const fromPublic = resolveResponsiveImage(
    '/public/assets/aistudio/image_4a962f72_73843b7b.jpg'
  );
  assert.equal(
    fromPublic.fallbackSrc,
    '/assets/aistudio/image_4a962f72_73843b7b.jpg'
  );
  assert.equal(
    fromPublic.webpSrcSet,
    '/assets/opt/image_4a962f72_73843b7b-768w.webp 768w, /assets/opt/image_4a962f72_73843b7b-1376w.webp 1376w'
  );
  assert.equal(fromPublic.width, 1376);
  assert.equal(fromPublic.height, 768);
});

test('resolveResponsiveImage resolves brand emblem and atelier images', () => {
  const emblem = resolveResponsiveImage('/assets/aistudio/image_1656b91e_85be1a48.jpg');
  assert.equal(emblem.width, 1024);
  assert.equal(emblem.height, 1024);
  assert.match(emblem.webpSrcSet || '', /image_1656b91e_85be1a48-128w\.webp 128w/);

  const atelier = resolveResponsiveImage('/assets/images/atelier_craftsman_1794495941003.jpg');
  assert.equal(atelier.width, 1376);
  assert.equal(atelier.height, 768);
  assert.match(atelier.webpSrcSet || '', /atelier_craftsman_1794495941003-960w\.webp 960w/);
});

test('appendCacheVersionIfMutable appends version to mutable uploads/external URLs only', () => {
  assert.equal(
    appendCacheVersionIfMutable('/uploads/products/watch-1.jpg', '2026-11-24T00:00:00Z'),
    '/uploads/products/watch-1.jpg?v=2026-11-24T00%3A00%3A00Z'
  );
  assert.equal(
    appendCacheVersionIfMutable('https://cdn.example.com/item.jpg?quality=85', '42'),
    'https://cdn.example.com/item.jpg?quality=85&v=42'
  );

  // Must not mutate data URLs, blob URLs, /assets/*, already-versioned, or signed URLs
  const dataUrl = 'data:image/webp;base64,UklGRh4AAABXRUJQ';
  assert.equal(appendCacheVersionIfMutable(dataUrl, '123'), dataUrl);
  assert.equal(appendCacheVersionIfMutable('blob:https://rgd.test/abc', '123'), 'blob:https://rgd.test/abc');
  assert.equal(appendCacheVersionIfMutable('/assets/images/foo.jpg', '123'), '/assets/images/foo.jpg');
  assert.equal(
    appendCacheVersionIfMutable('https://firebasestorage.googleapis.com/v0/b/app/o/img.webp?alt=media&token=abc-123', '123'),
    'https://firebasestorage.googleapis.com/v0/b/app/o/img.webp?alt=media&token=abc-123'
  );
  assert.equal(
    appendCacheVersionIfMutable('/uploads/x.jpg?v=existing', '999'),
    '/uploads/x.jpg?v=existing'
  );
});

test('resolveResponsiveImage handles empty input safely', () => {
  assert.deepEqual(resolveResponsiveImage(''), { fallbackSrc: '' });
  assert.deepEqual(resolveResponsiveImage('   '), { fallbackSrc: '' });
});
