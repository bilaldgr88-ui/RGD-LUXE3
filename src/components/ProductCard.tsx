import React from 'react';
import { Product } from '../types';
import { useShop } from '../context/ShopContext';
import {
  formatPrice,
  getDiscountPercentage,
  getEffectivePrice,
  getNormalizedGallery,
  hasActiveDiscount,
} from '../utils/pricing';
import { Heart, ShoppingBag, Eye, Star } from 'lucide-react';
import { OptimizedImage } from './OptimizedImage';

interface ProductCardProps {
  product: Product;
}

export const ProductCard: React.FC<ProductCardProps> = ({ product }) => {
  const { viewProduct, addToCart, wishlist, toggleWishlist } = useShop();

  const isSaved = wishlist.includes(product.id);
  const gallery = getNormalizedGallery(product);
  const mainImage = gallery[0] || product.image;
  const discounted = hasActiveDiscount(product);
  const effectivePrice = getEffectivePrice(product);
  const discountPct = getDiscountPercentage(product);

  return (
    <article className="group relative h-full flex flex-col bg-[#0F0F13] border border-[#24242C] hover:border-[#D4AF37]/60 rounded-xl sm:rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(0,0,0,0.6)]">
      {/* Product Image Frame */}
      <div
        onClick={() => viewProduct(product.id)}
        className="relative w-full aspect-[4/3] bg-[#0A0A0C] overflow-hidden cursor-pointer shrink-0"
      >
        <OptimizedImage
          src={mainImage}
          alt={product.name}
          sizes="(max-width: 767px) 46vw, (max-width: 1023px) 31vw, (max-width: 1279px) 23vw, 290px"
          className="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-700 ease-out"
        />

        {/* Subtle Gradient Scrim at bottom of image */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

        {/* Wishlist Button Top Right */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleWishlist(product.id);
          }}
          aria-label={isSaved ? `Remove ${product.name} from wishlist` : `Save ${product.name} to wishlist`}
          className={`absolute top-2 right-2 sm:top-3 sm:right-3 w-8 h-8 sm:w-9 sm:h-9 rounded-full backdrop-blur-md flex items-center justify-center transition-all cursor-pointer z-10 ${
            isSaved
              ? 'bg-[#D4AF37] text-black shadow-md'
              : 'bg-black/65 text-neutral-300 hover:text-white hover:bg-black/90'
          }`}
        >
          <Heart className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${isSaved ? 'fill-current' : ''}`} />
        </button>

        {/* Status & Discount indicators top left (cleanly bounded away from heart button) */}
        <div className="absolute top-2 left-2 sm:top-3 sm:left-3 flex flex-col items-start gap-1 max-w-[calc(100%-3.25rem)] z-10 pointer-events-none">
          {discounted && (
            <span className="text-[9px] sm:text-[10px] uppercase tracking-wider font-bold text-black bg-[#D4AF37] px-1.5 sm:px-2 py-0.5 rounded shadow-sm whitespace-nowrap">
              {discountPct}% OFF
            </span>
          )}
          {product.isNewArrival && (
            <span className="text-[9px] sm:text-[10px] uppercase tracking-wider font-semibold text-[#F3E5AB] bg-black/75 backdrop-blur-md px-1.5 sm:px-2 py-0.5 rounded border border-[#D4AF37]/40 whitespace-nowrap">
              New Arrival
            </span>
          )}
          {product.isSpecialOffer && !discounted && (
            <span className="text-[9px] sm:text-[10px] uppercase tracking-wider font-semibold text-[#D4AF37] bg-black/75 backdrop-blur-md px-1.5 sm:px-2 py-0.5 rounded border border-[#D4AF37]/40 whitespace-nowrap">
              Private Offer
            </span>
          )}
        </div>

        {/* Desktop Quick View Overlay on Hover */}
        <div className="hidden sm:flex absolute inset-x-4 bottom-3 items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-2 group-hover:translate-y-0 z-10">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              viewProduct(product.id);
            }}
            className="w-full py-2 bg-neutral-900/90 hover:bg-black text-white text-xs font-semibold uppercase tracking-wider rounded-xl backdrop-blur-md border border-neutral-700 hover:border-[#D4AF37] transition-all flex items-center justify-center gap-1.5 shadow-lg cursor-pointer"
          >
            <Eye className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span>View Details</span>
          </button>
        </div>
      </div>

      {/* Card Info Section */}
      <div className="p-3 sm:p-3.5 xl:p-4 flex flex-col flex-1 justify-between">
        <div>
          {/* Metadata: Category & Rating */}
          <div className="flex items-center justify-between text-[10px] sm:text-xs text-neutral-400 mb-1 sm:mb-1.5 gap-1.5">
            <span className="uppercase tracking-[0.08em] sm:tracking-[0.1em] text-[9px] sm:text-[10px] xl:text-[11px] font-medium text-neutral-400 truncate min-w-0">
              {product.categoryLabel}
            </span>
            <div className="flex items-center gap-0.5 sm:gap-1 text-[10px] sm:text-[11px] text-[#E6C25B] shrink-0">
              <Star className="w-2.5 h-2.5 sm:w-3 sm:h-3 fill-current text-[#D4AF37]" />
              <span className="tabular-nums font-medium">{product.rating.toFixed(1)}</span>
              <span className="hidden sm:inline text-neutral-500">({product.reviewsCount})</span>
            </div>
          </div>

          {/* Product Title */}
          <h3
            onClick={() => viewProduct(product.id)}
            className="font-brand text-xs sm:text-[13px] lg:text-sm xl:text-[15px] tracking-[0.06em] sm:tracking-[0.08em] font-semibold text-neutral-100 group-hover:text-gold-gradient transition-colors cursor-pointer line-clamp-2 min-h-[2.25rem] sm:min-h-[2.5rem] leading-snug"
          >
            {product.name}
          </h3>

          {/* Subtitle / Spec */}
          <p className="text-[11px] sm:text-xs text-neutral-400 font-light mt-1 line-clamp-1">
            {product.subtitle}
          </p>

          {/* Available Sizes (desktop/tablet) */}
          {product.sizes && product.sizes.length > 0 && (
            <div className="hidden sm:flex mt-2 items-center gap-1.5 text-[11px] text-neutral-400">
              <span className="text-neutral-500 shrink-0">Sizes:</span>
              <span className="text-neutral-300 font-mono text-[10px] truncate">
                {product.sizes.join(' · ')}
              </span>
            </div>
          )}
        </div>

        {/* Price & Buy Action */}
        <div className="mt-2.5 sm:mt-3 pt-2.5 sm:pt-3 border-t border-[#1F1F27] flex items-center justify-between gap-1.5 sm:gap-2">
          <div className="flex flex-col min-w-0">
            <div className="flex items-baseline gap-1.5 flex-wrap">
              <span className="text-[13px] sm:text-sm xl:text-base font-bold text-white tabular-nums whitespace-nowrap">
                {formatPrice(effectivePrice)}
              </span>
              {discounted && product.originalPrice && (
                <span className="text-[10px] sm:text-[11px] text-neutral-500 line-through tabular-nums whitespace-nowrap">
                  {formatPrice(product.originalPrice)}
                </span>
              )}
            </div>
            <span
              className={`text-[9px] sm:text-[10px] mt-0.5 truncate ${
                product.inStock ? 'text-emerald-400' : 'text-neutral-500'
              }`}
            >
              {product.inStock ? `In Stock (${product.stockCount})` : 'Made to Order'}
            </span>
          </div>

          {/* Touch-Friendly Add to Bag Button */}
          <button
            type="button"
            onClick={() => addToCart(product, 1)}
            aria-label={`Add ${product.name} to shopping bag`}
            className="w-9 h-9 xl:w-10 xl:h-10 bg-[#181820] hover:bg-[#D4AF37] text-neutral-200 hover:text-black rounded-xl border border-[#2E2E38] hover:border-[#D4AF37] transition-all cursor-pointer group/btn shrink-0 flex items-center justify-center"
          >
            <ShoppingBag className="w-4 h-4 group-hover/btn:scale-110 transition-transform" />
          </button>
        </div>
      </div>
    </article>
  );
};
