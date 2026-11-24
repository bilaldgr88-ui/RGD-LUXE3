import React from 'react';
import { useShop } from '../context/ShopContext';
import { ArrowRight, Watch } from 'lucide-react';
import { OptimizedImage } from './OptimizedImage';

export const HeroBanner: React.FC = () => {
  const { setCurrentPage } = useShop();

  return (
    <section
      aria-label="Maison RGD LUXE Featured Campaign"
      className="relative w-full overflow-hidden bg-black border-b border-[#24242A]"
    >
      <div className="relative w-full min-h-[235px] sm:min-h-[340px] md:min-h-[370px] lg:min-h-[410px] flex items-end">
        {/* Unified Priority Campaign Image */}
        <div className="absolute inset-0 z-0">
          <OptimizedImage
            src="/assets/aistudio/image_4a962f72_73843b7b.jpg"
            alt="RGD LUXE Timeless Style Modern Luxury Campaign"
            priority
            sizes="100vw"
            className="w-full h-full object-cover object-[68%_22%] sm:object-center opacity-95"
          />
          {/* Balanced scrims: keep model + gold crest visible while guaranteeing crisp text contrast */}
          <div className="absolute inset-0 bg-gradient-to-r from-[#060608]/95 via-[#060608]/70 to-[#060608]/25 sm:from-black/90 sm:via-black/55 sm:to-black/15" />
          <div className="absolute inset-0 bg-gradient-to-t from-[#060608]/95 via-[#060608]/40 to-transparent sm:from-black/90 sm:via-black/25" />
        </div>

        {/* Hero Copy & Primary Actions Overlaid Cleanly */}
        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-7 lg:py-9 w-full">
          <div className="max-w-md sm:max-w-lg lg:max-w-xl sm:bg-black/55 sm:backdrop-blur-sm sm:px-6 sm:py-5 sm:rounded-2xl sm:border sm:border-[#D4AF37]/30 sm:shadow-2xl">
            <div className="text-[10px] sm:text-[11px] uppercase tracking-[0.22em] font-semibold text-[#F3E5AB] mb-1">
              New York · Geneva · Paris
            </div>

            <h1 className="font-brand text-2xl sm:text-4xl lg:text-5xl font-extrabold tracking-[0.14em] text-gold-gradient uppercase leading-none">
              RGD LUXE
            </h1>

            <p className="mt-1 sm:mt-2 font-editorial text-sm sm:text-xl lg:text-2xl text-neutral-100 italic tracking-wide font-normal">
              "TIMELESS STYLE. MODERN LUXURY."
            </p>

            <p className="mt-1.5 sm:mt-2 text-xs sm:text-sm text-neutral-200 sm:text-neutral-300 leading-relaxed font-light max-w-sm sm:max-w-none">
              Discover the Art of Refined Living. An exclusive synthesis of master-tailored evening couture and Swiss-certified mechanical timepieces.
            </p>

            <div className="mt-3.5 sm:mt-5 flex flex-wrap items-center gap-2.5 sm:gap-3.5">
              <button
                onClick={() => {
                  setCurrentPage('shop');
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className="group inline-flex items-center justify-center gap-2 px-4 sm:px-6 py-2.5 sm:py-3 min-h-[40px] bg-gradient-to-r from-[#D4AF37] via-[#F3E5AB] to-[#C99726] text-black font-semibold text-[11px] sm:text-xs tracking-wider uppercase rounded-full shadow-[0_0_20px_rgba(212,175,55,0.35)] hover:shadow-[0_0_28px_rgba(212,175,55,0.55)] transition-all duration-300 cursor-pointer whitespace-nowrap"
              >
                <span>Shop Now</span>
                <ArrowRight className="w-3.5 h-3.5 sm:w-4 sm:h-4 group-hover:translate-x-0.5 transition-transform" />
              </button>

              <button
                onClick={() => {
                  setCurrentPage('watches');
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className="inline-flex items-center justify-center gap-1.5 sm:gap-2 px-3.5 sm:px-5 py-2.5 sm:py-3 min-h-[40px] bg-[#0F0F14]/90 hover:bg-[#1A1A22] border border-[#D4AF37]/50 hover:border-[#D4AF37] text-neutral-200 hover:text-white text-[11px] sm:text-xs font-medium tracking-wider uppercase rounded-full backdrop-blur-md transition-all duration-300 cursor-pointer whitespace-nowrap"
              >
                <Watch className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#D4AF37]" />
                <span>Horology Salon</span>
              </button>
            </div>

            <div className="hidden sm:flex mt-3.5 pt-2.5 border-t border-white/10 items-center gap-4 text-[11px] text-neutral-300 flex-wrap">
              <span>Original Swiss Calibres</span>
              <span aria-hidden="true" className="text-[#D4AF37]">·</span>
              <span>Bespoke Italian Silks</span>
              <span aria-hidden="true" className="text-[#D4AF37]">·</span>
              <span>White-Glove Delivery</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
