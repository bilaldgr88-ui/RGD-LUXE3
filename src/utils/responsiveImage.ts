import { normalizePublicAssetPath } from './pricing';

export interface ResponsiveVariant {
  w: number;
  url: string;
}

export interface ResponsiveAssetEntry {
  width: number;
  height: number;
  variants: ResponsiveVariant[];
}

const PRODUCT_ASSETS = [
  'watch_rose_gold_1794494079347',
  'watch_black_diamond_1794494079598',
  'watch_perpetual_blue_1794495941635',
  'women_evening_dress_1794494078742',
  'women_silk_coat_1794495941084',
  'women_emerald_gown_1794495965655',
  'men_collection_suit_1794494077378',
  'men_black_overcoat_1794495965409',
  'men_navy_blazer_1794495940721',
] as const;

const RESPONSIVE_MANIFEST: Record<string, ResponsiveAssetEntry> = {
  '/assets/aistudio/image_4a962f72_73843b7b.jpg': {
    width: 1376,
    height: 768,
    variants: [
      { w: 768, url: '/assets/opt/image_4a962f72_73843b7b-768w.webp' },
      { w: 1376, url: '/assets/opt/image_4a962f72_73843b7b-1376w.webp' },
    ],
  },
  '/assets/aistudio/image_1656b91e_85be1a48.jpg': {
    width: 1024,
    height: 1024,
    variants: [
      { w: 128, url: '/assets/opt/image_1656b91e_85be1a48-128w.webp' },
      { w: 288, url: '/assets/opt/image_1656b91e_85be1a48-288w.webp' },
    ],
  },
  '/assets/images/atelier_craftsman_1794495941003.jpg': {
    width: 1376,
    height: 768,
    variants: [
      { w: 480, url: '/assets/opt/atelier_craftsman_1794495941003-480w.webp' },
      { w: 960, url: '/assets/opt/atelier_craftsman_1794495941003-960w.webp' },
    ],
  },
};

for (const name of PRODUCT_ASSETS) {
  RESPONSIVE_MANIFEST[`/assets/images/${name}.jpg`] = {
    width: 1200,
    height: 896,
    variants: [
      { w: 480, url: `/assets/opt/${name}-480w.webp` },
      { w: 960, url: `/assets/opt/${name}-960w.webp` },
    ],
  };
}

export function appendCacheVersionIfMutable(url: string, version?: string | number): string {
  if (!url || version === undefined || version === null || version === '') {
    return url;
  }
  const cleanUrl = url.trim();
  if (!cleanUrl || cleanUrl.startsWith('data:') || cleanUrl.startsWith('blob:')) {
    return cleanUrl;
  }
  // Never alter signed cloud/storage URLs or static bundled assets with manifest WebP twins
  if (
    cleanUrl.startsWith('/assets/') ||
    /[?&](token|signature|x-amz-signature|googleaccessid|x-goog-signature)=/i.test(cleanUrl) ||
    /[?&]v=/i.test(cleanUrl)
  ) {
    return cleanUrl;
  }
  const sep = cleanUrl.includes('?') ? '&' : '?';
  return `${cleanUrl}${sep}v=${encodeURIComponent(String(version))}`;
}

export interface ResolvedImageSources {
  fallbackSrc: string;
  webpSrcSet?: string;
  width?: number;
  height?: number;
}

export function resolveResponsiveImage(
  rawSrc: string,
  version?: string | number
): ResolvedImageSources {
  const normalized = normalizePublicAssetPath(rawSrc || '');
  if (!normalized) {
    return { fallbackSrc: '' };
  }

  const basePath = normalized.split('?')[0];
  const entry = RESPONSIVE_MANIFEST[basePath];
  if (entry) {
    return {
      fallbackSrc: normalized,
      webpSrcSet: entry.variants.map((v) => `${v.url} ${v.w}w`).join(', '),
      width: entry.width,
      height: entry.height,
    };
  }

  return {
    fallbackSrc: appendCacheVersionIfMutable(normalized, version),
  };
}
